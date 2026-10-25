import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import { SshToolHandlers } from "../src/tools/ssh-tools.js";
import { startSshTestServer, TEST_PASSWORD, TEST_USER } from "./helpers/ssh-test-server.js";

describe("SFTP 超时和分段读取", () => {
  const closers: Array<() => Promise<void>> = [];
  const dirs: string[] = [];

  afterEach(async () => {
    for (const close of closers) await close();
    closers.length = 0;
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    dirs.length = 0;
  });

  async function setup() {
    const server = await startSshTestServer();
    closers.push(() => server.close());
    const dir = mkdtempSync(join(tmpdir(), "ssh-mcp-read-"));
    dirs.push(dir);
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
      connect_timeout: 3000,
      keepalive_interval: 0,
    });
    return { server, handlers, dir, sessionId: connected.session_id };
  }

  it("SFTP 无响应时按本次超时失败，之后的读取仍可用", async () => {
    const { server, handlers, sessionId } = await setup();
    server.sftp.files.set("/note.txt", Buffer.from("hello"));
    server.sftp.holdStat = true;
    const start = Date.now();
    await expect(handlers.sftpRead({
      session_id: sessionId,
      path: "/note.txt",
      timeout: 1000,
    })).rejects.toThrow(/SFTP timeout after 1000ms/);
    expect(Date.now() - start).toBeLessThan(2000);

    server.sftp.holdStat = false;
    const result = await handlers.sftpRead({
      session_id: sessionId,
      path: "/note.txt",
      timeout: 3000,
    });
    expect(result.content).toBe("hello");
  }, 5000);

  it("下载长时间没有新数据时超时，并且不改已有本地文件", async () => {
    const { server, handlers, dir, sessionId } = await setup();
    const local = join(dir, "keep.txt");
    writeFileSync(local, "ORIGINAL");
    server.sftp.files.set("/remote.txt", Buffer.from("new-content"));
    server.sftp.holdRead = true;

    await expect(handlers.sftpDownload({
      session_id: sessionId,
      remote_path: "/remote.txt",
      local_path: local,
      timeout: 1000,
    })).rejects.toThrow(/timeout after 1000ms/);
    expect(readFileSync(local, "utf8")).toBe("ORIGINAL");
  }, 5000);

  it("调用方取消时停止等待", async () => {
    const { server, handlers, sessionId } = await setup();
    server.sftp.files.set("/note.txt", Buffer.from("hello"));
    server.sftp.holdStat = true;
    const controller = new AbortController();
    const pending = handlers.sftpRead({
      session_id: sessionId,
      path: "/note.txt",
      timeout: 10000,
    }, controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow(/cancel/i);
  }, 4000);

  it("空文件返回空内容，并可以按字节分页", async () => {
    const { server, handlers, sessionId } = await setup();
    server.sftp.files.set("/empty.txt", Buffer.alloc(0));
    const empty = await handlers.sftpRead({ session_id: sessionId, path: "/empty.txt" });
    expect(empty.content).toBe("");
    expect(empty.size).toBe(0);
    expect(empty.truncated).toBe(false);
    expect(empty.bytes_read).toBe(0);

    const text = Buffer.from("你好world", "utf8");
    server.sftp.files.set("/page.txt", text);
    const first = await handlers.sftpRead({
      session_id: sessionId,
      path: "/page.txt",
      offset: 0,
      limit: 4,
      encoding: "utf8",
    });
    expect(first.content).toBe("你");
    expect(first.truncated).toBe(true);
    expect(first.next_offset).toBe(3);

    const second = await handlers.sftpRead({
      session_id: sessionId,
      path: "/page.txt",
      offset: first.next_offset,
      limit: 20,
      encoding: "utf8",
    });
    expect(second.content).toBe("好world");
    expect(second.truncated).toBe(false);
    expect(first.content + second.content).toBe("你好world");

    const encoded = await handlers.sftpRead({
      session_id: sessionId,
      path: "/page.txt",
      offset: 3,
      limit: 3,
      encoding: "base64",
    });
    expect(Buffer.from(encoded.content, "base64").toString("utf8")).toBe("好");
    expect(encoded.bytes_read).toBe(3);
  });
});
