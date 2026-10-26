import { EventEmitter } from "events";
import { createReadStream, createWriteStream, mkdtempSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { Client, SFTPWrapper } from "ssh2";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SftpClient } from "../src/services/sftp-client.js";

// 这些用例验证本地流不会在 SFTP 会话校验前打开；默认实现直接失败，避免真的创建文件或 FD。
vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return {
    ...actual,
    createReadStream: vi.fn(() => {
      throw new Error("本地读取流不应在 SFTP 校验前创建");
    }),
    createWriteStream: vi.fn(() => {
      throw new Error("本地写入流不应在 SFTP 校验前创建");
    }),
  };
});

function fakeSshClient(sftp: Record<string, unknown>): Client {
  return {
    sftp: (callback: (err: Error | null, sftp: SFTPWrapper) => void) => {
      callback(null, sftp as unknown as SFTPWrapper);
    },
  } as unknown as Client;
}

async function initializedClient(sftp: Record<string, unknown>): Promise<SftpClient> {
  const client = new SftpClient(fakeSshClient(sftp));
  await client.init();
  return client;
}

function trackedSignal(): { signal: AbortSignal; listeners: Set<() => void> } {
  const listeners = new Set<() => void>();
  const signal = {
    aborted: false,
    addEventListener: (_type: string, listener: () => void) => {
      listeners.add(listener);
    },
    removeEventListener: (_type: string, listener: () => void) => {
      listeners.delete(listener);
    },
  } as unknown as AbortSignal;
  return { signal, listeners };
}

function fakeRemoteWriteStream() {
  const stream = new EventEmitter() as EventEmitter & {
    destroy: ReturnType<typeof vi.fn>;
    end: ReturnType<typeof vi.fn>;
  };
  stream.destroy = vi.fn();
  stream.end = vi.fn();
  return stream;
}

describe("SFTP 同步失败和超时的资源清理", () => {
  const dirs: string[] = [];

  function makeDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "ssh-mcp-sftp-cleanup-"));
    dirs.push(dir);
    return dir;
  }

  beforeEach(() => {
    vi.mocked(createReadStream).mockClear();
    vi.mocked(createWriteStream).mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    dirs.length = 0;
  });

  it("同步失败时清除超时定时器和取消监听", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const client = new SftpClient(fakeSshClient({}));
    const { signal, listeners } = trackedSignal();

    await expect(client.stat("/missing", { timeout: 5000, signal }))
      .rejects.toThrow(/SFTP not initialized/);

    expect(vi.getTimerCount()).toBe(0);
    expect(listeners.size).toBe(0);
  });

  it("远端流创建同步失败时清理定时器、监听并关闭会话", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const end = vi.fn();
    const client = await initializedClient({
      end,
      stat: (_path: string, callback: (err: Error | null, attrs: unknown) => void) => {
        callback(null, { size: 4 });
      },
      createReadStream: () => {
        throw new Error("stream setup failed");
      },
    });
    const { signal, listeners } = trackedSignal();

    await expect(client.readFile("/file.txt", { timeout: 5000, signal }))
      .rejects.toThrow("stream setup failed");

    expect(end).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(listeners.size).toBe(0);
  });

  it("写入超时后的清理不会留下默认超时定时器", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const end = vi.fn();
    const writeStream = fakeRemoteWriteStream();
    const client = await initializedClient({
      end,
      createWriteStream: () => writeStream,
    });

    const pending = client.writeFile("/data.txt", "HELLO", { timeout: 1000 })
      .catch((err: Error) => err);
    await vi.advanceTimersByTimeAsync(1000);
    const error = await pending;

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/SFTP timeout after 1000ms/);
    expect((error as { retryable?: boolean }).retryable).toBe(false);
    expect(writeStream.destroy).toHaveBeenCalled();
    expect(end).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("上传时会话不可用不会打开本地读取流", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const dir = makeDir();
    const local = join(dir, "upload.txt");
    writeFileSync(local, "hello");
    const client = new SftpClient(fakeSshClient({}));

    await expect(client.uploadFile(local, "/remote.txt", { timeout: 5000 }))
      .rejects.toThrow(/SFTP not initialized/);

    expect(createReadStream).not.toHaveBeenCalled();
    expect(readdirSync(dir)).toEqual(["upload.txt"]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("下载时会话在 stat 后失效，不创建本地写入流或临时文件", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const dir = makeDir();
    const local = join(dir, "downloaded.txt");
    let client: SftpClient;
    const sftp = {
      end: vi.fn(),
      stat: (_path: string, callback: (err: Error | null, attrs: unknown) => void) => {
        callback(null, { size: 5, mode: 0o100644 });
        client.close();
      },
      createReadStream: vi.fn(),
    };
    client = await initializedClient(sftp);

    await expect(client.downloadFile("/remote.txt", local, { timeout: 5000 }))
      .rejects.toThrow(/SFTP not initialized/);

    expect(createWriteStream).not.toHaveBeenCalled();
    expect(readdirSync(dir)).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
