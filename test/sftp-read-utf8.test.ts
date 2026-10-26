import { EventEmitter } from "events";
import type { Client, SFTPWrapper } from "ssh2";
import { describe, expect, it, vi } from "vitest";
import { SftpClient } from "../src/services/sftp-client.js";
import type { SshOperationError } from "../src/utils/errors.js";

interface FakeReadStream extends EventEmitter {
  destroy: ReturnType<typeof vi.fn>;
}

function makeReadClient(file: Buffer) {
  const stat = vi.fn((_path: string, callback: (err: Error | null, attrs: { size: number; mode: number }) => void) => {
    callback(null, { size: file.length, mode: 0o100644 });
  });
  const createReadStream = vi.fn((_path: string, options: { start: number; end: number }) => {
    const stream = new EventEmitter() as FakeReadStream;
    stream.destroy = vi.fn();
    queueMicrotask(() => {
      stream.emit("data", file.subarray(options.start, Math.min(file.length, options.end + 1)));
      stream.emit("end");
    });
    return stream;
  });
  const wrapper = {
    end: vi.fn(),
    stat,
    createReadStream,
    createWriteStream: vi.fn(),
    readdir: vi.fn(),
    rename: vi.fn(),
    unlink: vi.fn(),
  };
  const sshClient = {
    sftp: (callback: (err: Error | null, sftp: SFTPWrapper) => void) => {
      callback(null, wrapper as unknown as SFTPWrapper);
    },
  } as unknown as Client;
  return { client: new SftpClient(sshClient), wrapper, stat, createReadStream };
}

async function initialized(file: Buffer) {
  const setup = makeReadClient(file);
  await setup.client.init();
  return setup;
}

describe("SFTP UTF-8 分页不会静默丢字符", () => {
  it("limit 小于下一个字符字节数时明确失败，不返回空页", async () => {
    const setup = await initialized(Buffer.from("你好", "utf8"));

    for (const limit of [1, 2]) {
      const error = await setup.client.readFile("/page.txt", { limit, encoding: "utf8" })
        .catch((err: Error) => err) as SshOperationError;
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toMatch(/limit \d+ is smaller than the next complete character/);
      expect(error.retryable).toBe(false);
      expect(error.timedOut).toBe(false);
    }

    // 同一会话仍可用，增大 limit 后能完整读到字符。
    const result = await setup.client.readFile("/page.txt", { limit: 6, encoding: "utf8" });
    expect(result.content).toBe("你好");
    expect(result.nextOffset).toBe(6);
    expect(result.truncated).toBe(false);
  });

  it("四字节字符在 limit 不足时失败，足够时完整返回", async () => {
    const setup = await initialized(Buffer.from("😀", "utf8"));

    await expect(setup.client.readFile("/emoji.txt", { limit: 3, encoding: "utf8" }))
      .rejects.toThrow(/smaller than the next complete character/);

    const result = await setup.client.readFile("/emoji.txt", { limit: 4, encoding: "utf8" });
    expect(result.content).toBe("😀");
    expect(result.bytesRead).toBe(4);
  });

  it("边界截断仍只截完整字符，nextOffset 指向被留下的字符起点", async () => {
    const setup = await initialized(Buffer.from("a你好", "utf8"));

    const first = await setup.client.readFile("/page.txt", { limit: 4, encoding: "utf8" });
    expect(first.content).toBe("a你");
    expect(first.nextOffset).toBe(4);
    expect(first.truncated).toBe(true);

    const second = await setup.client.readFile("/page.txt", {
      offset: first.nextOffset,
      limit: 3,
      encoding: "utf8",
    });
    expect(second.content).toBe("好");
    expect(first.content + second.content).toBe("a你好");
  });

  it("base64 编码不受 UTF-8 字符边界影响", async () => {
    const setup = await initialized(Buffer.from("你", "utf8"));
    const result = await setup.client.readFile("/page.txt", { limit: 1, encoding: "base64" });
    expect(result.bytesRead).toBe(1);
    expect(Buffer.from(result.content, "base64").length).toBe(1);
  });
});

describe("SFTP 路径在 IO 之前校验 NUL", () => {
  it("下载本地路径含 NUL 时在远端 stat 前失败，并保留会话", async () => {
    const setup = await initialized(Buffer.from("hello"));
    const error = await setup.client.downloadFile("/remote.txt", "/tmp/bad\0name.txt")
      .catch((err: Error) => err) as SshOperationError;

    expect(error.message).toMatch(/Invalid local path: NUL/);
    expect(error.retryable).toBe(false);
    expect(setup.stat).not.toHaveBeenCalled();
    expect(setup.client.isAlive()).toBe(true);
  });

  it("上传/写入/列表/重命名的 NUL 路径都不会发起远端请求", async () => {
    const setup = await initialized(Buffer.from("hello"));

    await expect(setup.client.uploadFile("/tmp/bad\0local", "/remote.txt"))
      .rejects.toThrow(/Invalid local path: NUL/);
    await expect(setup.client.writeFile("/bad\0remote", "data"))
      .rejects.toThrow(/Invalid remote path: NUL/);
    await expect(setup.client.listDirectory("/bad\0dir"))
      .rejects.toThrow(/Invalid remote path: NUL/);
    await expect(setup.client.rename("/ok", "/bad\0target"))
      .rejects.toThrow(/Invalid remote path: NUL/);
    await expect(setup.client.readFile("/bad\0read"))
      .rejects.toThrow(/Invalid remote path: NUL/);

    expect(setup.stat).not.toHaveBeenCalled();
    expect(setup.createReadStream).not.toHaveBeenCalled();
    expect(setup.wrapper.createWriteStream).not.toHaveBeenCalled();
    expect(setup.wrapper.readdir).not.toHaveBeenCalled();
    expect(setup.wrapper.rename).not.toHaveBeenCalled();
    expect(setup.client.isAlive()).toBe(true);
  });
});
