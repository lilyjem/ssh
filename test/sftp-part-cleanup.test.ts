import { EventEmitter } from "events";
import type { Client, SFTPWrapper } from "ssh2";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SftpClient } from "../src/services/sftp-client.js";
import type { SshOperationError } from "../src/utils/errors.js";

type Callback = (err?: Error | null) => void;

interface WriteStreamDouble extends EventEmitter {
  end: (data?: Buffer) => void;
  destroy: ReturnType<typeof vi.fn>;
}

function makeSetup(options: {
  end: (path: string, data: Buffer, stream: WriteStreamDouble) => void;
  unlink?: (path: string, callback: Callback) => void;
}) {
  const files = new Map<string, Buffer>([["/data.txt", Buffer.from("ORIGINAL")]]);
  const unlinkCalls: string[] = [];
  let wrapper!: EventEmitter & { end: ReturnType<typeof vi.fn> };
  wrapper = new EventEmitter() as EventEmitter & { end: ReturnType<typeof vi.fn> };
  wrapper.end = vi.fn();
  const createWriteStream = (path: string) => {
    const stream = new EventEmitter() as WriteStreamDouble;
    stream.destroy = vi.fn();
    stream.end = (data?: Buffer) => {
      files.set(path, Buffer.from(data ?? Buffer.alloc(0)));
      options.end(path, Buffer.from(data ?? Buffer.alloc(0)), stream);
    };
    return stream;
  };
  const unlink = (path: string, callback: Callback) => {
    unlinkCalls.push(path);
    if (options.unlink) {
      options.unlink(path, callback);
      return;
    }
    files.delete(path);
    callback(null);
  };
  Object.assign(wrapper, {
    createWriteStream,
    unlink,
    stat: (path: string, callback: (err: Error | null, attrs: { size: number }) => void) => {
      const file = files.get(path);
      callback(file ? null : new Error("No such file"), { size: file?.length ?? 0 });
    },
  });
  const sftpCalls: Callback[] = [];
  const sshClient = {
    sftp: (callback: Callback) => {
      sftpCalls.push(callback);
      callback(null, wrapper as unknown as SFTPWrapper);
    },
  } as unknown as Client;
  return {
    client: new SftpClient(sshClient),
    files,
    wrapper,
    unlinkCalls,
    sftpCalls,
    createWriteStream,
    unlink,
  };
}

describe("SFTP 远端临时文件清理策略", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("写入失败后在仍存活的会话上删除 part，最终目标不变", async () => {
    const setup = makeSetup({
      end: (_path, _data, stream) => {
        queueMicrotask(() => stream.emit("error", new Error("write failed")));
      },
    });
    await setup.client.init();

    await expect(setup.client.writeFile("/data.txt", "NEW", { timeout: 500 }))
      .rejects.toThrow(/Failed to write file/);

    expect(setup.unlinkCalls).toHaveLength(1);
    expect(setup.unlinkCalls[0]).toMatch(/^\/data\.txt\.part-/);
    expect(setup.files.get("/data.txt")?.toString()).toBe("ORIGINAL");
    expect([...setup.files.keys()].some((path) => path.includes(".part-"))).toBe(false);
    expect(setup.client.isAlive()).toBe(true);
  });

  it("清理挂起时按有界 deadline 结束，不拖住原始错误", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const setup = makeSetup({
      end: (_path, _data, stream) => {
        queueMicrotask(() => stream.emit("error", new Error("write failed")));
      },
      unlink: () => {
        // 模拟服务端接受 REMOVE 后不再响应。
      },
    });
    await setup.client.init();

    const pending = setup.client.writeFile("/data.txt", "NEW", { timeout: 100 })
      .catch((err: Error) => err as SshOperationError);
    await vi.advanceTimersByTimeAsync(0);
    expect(setup.unlinkCalls).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(100);
    const error = await pending;

    expect(error.message).toMatch(/Failed to write file/);
    expect(error.retryable).toBe(false);
    expect(setup.wrapper.end).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(setup.files.get("/data.txt")?.toString()).toBe("ORIGINAL");
  });

  it("会话已断开时不尝试清理，也不重连/重放删除", async () => {
    const setup = makeSetup({
      end: (_path, _data, stream) => {
        queueMicrotask(() => {
          setup.wrapper.emit("close");
          stream.emit("error", new Error("transport lost"));
        });
      },
    });
    await setup.client.init();

    await expect(setup.client.writeFile("/data.txt", "NEW", { timeout: 500 }))
      .rejects.toThrow(/Failed to write file/);

    expect(setup.client.isAlive()).toBe(false);
    expect(setup.unlinkCalls).toEqual([]);
    expect(setup.sftpCalls).toHaveLength(1);
    expect(setup.files.get("/data.txt")?.toString()).toBe("ORIGINAL");
  });

  it("调用已取消时不再发起清理请求", async () => {
    const setup = makeSetup({
      end: (_path, _data, stream) => {
        // 同步上报写入错误，让 catch 在下一个微任务才进入清理。
        stream.emit("error", new Error("write failed"));
      },
    });
    await setup.client.init();
    const controller = new AbortController();

    const pending = setup.client.writeFile("/data.txt", "NEW", {
      timeout: 500,
      signal: controller.signal,
    }).catch((err: Error) => err);
    controller.abort();
    const error = await pending;

    expect(error.message).toMatch(/Failed to write file/);
    expect(setup.unlinkCalls).toEqual([]);
    expect(setup.client.isAlive()).toBe(true);
  });
});
