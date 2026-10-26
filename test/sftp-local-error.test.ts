import { EventEmitter } from "events";
import type { Client, SFTPWrapper } from "ssh2";
import { describe, expect, it, vi } from "vitest";
import { SftpClient } from "../src/services/sftp-client.js";

// 模拟本地目标无法打开（权限、无效路径等）时 createWriteStream 同步抛错。
vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return {
    ...actual,
    createWriteStream: vi.fn(() => {
      throw new Error("local setup failed");
    }),
  };
});

describe("SFTP 本地流创建失败后的通道清理", () => {
  it("关闭远端 ReadStream 和会话；迟到 error/close 不产生未处理异常", async () => {
    const readStream = new EventEmitter() as EventEmitter & { destroy: ReturnType<typeof vi.fn> };
    readStream.destroy = vi.fn();
    const wrapper = new EventEmitter() as EventEmitter & { end: ReturnType<typeof vi.fn> };
    wrapper.end = vi.fn();
    Object.assign(wrapper, {
      stat: (_path: string, callback: (err: Error | null, attrs: { size: number; mode: number }) => void) => {
        callback(null, { size: 5, mode: 0o100644 });
      },
      createReadStream: () => readStream,
    });
    const client = new SftpClient({
      sftp: (callback: (err: Error | null, sftp: SFTPWrapper) => void) => {
        callback(null, wrapper as unknown as SFTPWrapper);
      },
    } as unknown as Client);
    await client.init();

    await expect(client.downloadFile("/remote.txt", "/tmp/any-target.txt"))
      .rejects.toThrow(/local setup failed/);

    expect(readStream.destroy).toHaveBeenCalled();
    expect(wrapper.end).toHaveBeenCalledTimes(1);
    expect(client.isAlive()).toBe(false);

    // 清理后远端流/通道才上报错误：已有监听器，不能变成 unhandled 'error'。
    readStream.emit("error", new Error("late read error"));
    wrapper.emit("error", new Error("late channel error"));
    wrapper.emit("close");
    expect(client.isAlive()).toBe(false);
  });
});
