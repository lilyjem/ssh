import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Readable } from "stream";
import type { Client, SFTPWrapper } from "ssh2";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SftpClient } from "../src/services/sftp-client.js";
import { SshToolHandlers } from "../src/tools/ssh-tools.js";
import { startSshTestServer, TEST_PASSWORD, TEST_USER } from "./helpers/ssh-test-server.js";

function remoteClient(mode: "error" | "hold") {
  const readStream = new Readable({ read() {} });
  const wrapper = {
    end: vi.fn(),
    stat: (_path: string, callback: (err: Error | null, attrs: { size: number; mode: number }) => void) => {
      callback(null, { size: 5, mode: 0o100644 });
    },
    createReadStream: () => {
      if (mode === "error") {
        queueMicrotask(() => readStream.destroy(new Error("remote read failed")));
      }
      return readStream;
    },
  };
  const client = new SftpClient({
    sftp: (callback: (err: Error | null, sftp: SFTPWrapper) => void) => {
      callback(null, wrapper as unknown as SFTPWrapper);
    },
  } as unknown as Client);
  return { client, readStream, wrapper };
}

function partFiles(dir: string): string[] {
  return readdirSync(dir).filter((name) => name.includes(".part-"));
}

async function settleLocalPart(dir: string): Promise<void> {
  // fs.WriteStream open/close 都是异步的；给晚到的 open + close cleanup 留出时间。
  await new Promise((resolve) => setTimeout(resolve, 150));
  expect(partFiles(dir)).toEqual([]);
}

describe("SFTP 下载失败时本地 .part 在 WriteStream close 后清理", () => {
  const dirs: string[] = [];
  const closers: Array<() => Promise<void>> = [];

  function makeTarget(): { dir: string; local: string } {
    const dir = mkdtempSync(join(tmpdir(), "ssh-mcp-download-part-"));
    dirs.push(dir);
    const local = join(dir, "important.conf");
    writeFileSync(local, "ORIGINAL");
    return { dir, local };
  }

  afterEach(async () => {
    for (const close of closers) await close();
    closers.length = 0;
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    dirs.length = 0;
  });

  it("远端立即失败时立即 unlink 可能 ENOENT，close 后不会留下 .part", async () => {
    const { dir, local } = makeTarget();
    const setup = remoteClient("error");
    await setup.client.init();

    await expect(setup.client.downloadFile("/remote.txt", local, { timeout: 1000 }))
      .rejects.toThrow(/Download failed/);

    expect(readFileSync(local, "utf8")).toBe("ORIGINAL");
    // 失败路径不等待本地流；但本地 close 后必须再清理一次，防止 open 晚于首次 unlink。
    await settleLocalPart(dir);
    expect(readFileSync(local, "utf8")).toBe("ORIGINAL");
  });

  it("超时取消本地流后 close 清理 .part，且超时本身不被 close 拖住", async () => {
    const { dir, local } = makeTarget();
    const setup = remoteClient("hold");
    await setup.client.init();

    const start = Date.now();
    await expect(setup.client.downloadFile("/remote.txt", local, { timeout: 20 }))
      .rejects.toThrow(/SFTP timeout after 20ms/);
    expect(Date.now() - start).toBeLessThan(1000);

    expect(readFileSync(local, "utf8")).toBe("ORIGINAL");
    await settleLocalPart(dir);
    expect(readFileSync(local, "utf8")).toBe("ORIGINAL");
  });

  it("本地 WriteStream open 失败时无临时文件残留，且不影响已有文件", async () => {
    const { dir, local: original } = makeTarget();
    // 不存在的父目录在各平台都会异步 open 失败，不依赖 POSIX NAME_MAX。
    const local = join(dir, "missing-parent", "download.txt");
    const setup = remoteClient("hold");
    await setup.client.init();

    await expect(setup.client.downloadFile("/remote.txt", local, { timeout: 1000 }))
      .rejects.toThrow(/Failed to write local file/);

    expect(readFileSync(original, "utf8")).toBe("ORIGINAL");
    await settleLocalPart(dir);
    expect(readFileSync(original, "utf8")).toBe("ORIGINAL");
  });

  it("真实远端读取失败时也不会留下晚到的 .part", async () => {
    const server = await startSshTestServer();
    closers.push(() => server.close());
    const { dir, local } = makeTarget();
    server.sftp.files.set("/remote.txt", Buffer.from("hello"));
    server.sftp.failReads = true;

    const handlers = new SshToolHandlers({
      maxReconnectAttempts: 1,
      reconnectBaseDelay: 10,
      reconnectMaxDelay: 20,
      strictHostKeyChecking: "no",
      knownHostsPath: join(dir, "known_hosts"),
    });
    const connected = await handlers.connect({
      host: "127.0.0.1",
      port: server.port,
      username: TEST_USER,
      password: TEST_PASSWORD,
      timeout: 3000,
      connect_timeout: 3000,
      keepalive_interval: 0,
    });

    await expect(handlers.sftpDownload({
      session_id: connected.session_id,
      remote_path: "/remote.txt",
      local_path: local,
    })).rejects.toThrow();

    expect(readFileSync(local, "utf8")).toBe("ORIGINAL");
    // 这正是 oracle 复现的路径：失败时本地 WriteStream 可能还没 open，
    // 首次 unlink 得到 ENOENT，稍后 open 才创建 .part。
    await settleLocalPart(dir);
    expect(readFileSync(local, "utf8")).toBe("ORIGINAL");
  });
});
