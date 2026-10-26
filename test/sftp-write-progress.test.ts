import { EventEmitter } from "events";
import type { Client, SFTPWrapper } from "ssh2";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SftpClient } from "../src/services/sftp-client.js";
import type { SshOperationError } from "../src/utils/errors.js";

interface WriteStreamDouble extends EventEmitter {
  write: (chunk: Buffer, callback: (err?: Error | null) => void) => boolean;
  end: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
}

describe("SFTP 写入无进度超时使用真实确认", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("每次 write 确认都会延长 deadline，停止确认后才超时", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const acknowledgements: Array<(err?: Error | null) => void> = [];
    const stream = new EventEmitter() as WriteStreamDouble;
    stream.destroy = vi.fn();
    stream.end = vi.fn();
    stream.write = (_chunk, callback) => {
      acknowledgements.push(callback);
      return true;
    };
    const wrapper = {
      end: vi.fn(),
      createWriteStream: () => stream,
    };
    const client = new SftpClient({
      sftp: (callback: (err: Error | null, sftp: SFTPWrapper) => void) => {
        callback(null, wrapper as unknown as SFTPWrapper);
      },
    } as unknown as Client);
    await client.init();

    let settled = false;
    const pending = client.writeFile("/data.txt", "a".repeat(70 * 1024), { timeout: 100 })
      .catch((err: Error) => {
        settled = true;
        return err as SshOperationError;
      });

    // 第一块 64 KiB 发出后等待服务器确认。
    expect(acknowledgements).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(80);
    expect(settled).toBe(false);

    // 第一块确认后计时从零开始，第二块仍在等待。
    acknowledgements[0](null);
    await vi.advanceTimersByTimeAsync(90);
    expect(acknowledgements).toHaveLength(2);
    expect(settled).toBe(false);

    // 超过最后一次确认后的 100ms 才失败。
    await vi.advanceTimersByTimeAsync(20);
    const error = await pending;
    expect(error.message).toMatch(/SFTP timeout after 100ms/);
    expect(error.timedOut).toBe(true);
    expect(stream.destroy).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
