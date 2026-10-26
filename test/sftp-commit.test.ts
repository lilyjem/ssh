import { EventEmitter } from "events";
import type { Client, SFTPWrapper } from "ssh2";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SftpClient } from "../src/services/sftp-client.js";
import type { SshOperationError } from "../src/utils/errors.js";

type Callback = (err?: Error | null) => void;

interface FakeWriteStream extends EventEmitter {
  end: (data?: Buffer) => void;
  destroy: ReturnType<typeof vi.fn>;
}

function fakeWriteStream(files: Map<string, Buffer>, path: string): FakeWriteStream {
  const stream = new EventEmitter() as FakeWriteStream;
  stream.destroy = vi.fn();
  stream.end = (data?: Buffer) => {
    files.set(path, Buffer.from(data ?? Buffer.alloc(0)));
    queueMicrotask(() => stream.emit("close"));
  };
  return stream;
}

function makeClient(files: Map<string, Buffer>, options: {
  extRename: (from: string, to: string, callback: Callback) => void;
  rename?: (from: string, to: string, callback: Callback) => void;
  unlink?: (path: string, callback: Callback) => void;
}) {
  const extCalls: Array<[string, string]> = [];
  const renameCalls: Array<[string, string]> = [];
  const unlinkCalls: string[] = [];
  const wrapper = {
    end: vi.fn(),
    createWriteStream: (path: string) => fakeWriteStream(files, path),
    stat: (path: string, callback: (err: Error | null, attrs: { size: number }) => void) => {
      const file = files.get(path);
      if (!file) callback(new Error("No such file"), { size: 0 });
      else callback(null, { size: file.length });
    },
    unlink: (path: string, callback: Callback) => {
      unlinkCalls.push(path);
      if (options.unlink) {
        options.unlink(path, callback);
        return;
      }
      files.delete(path);
      callback(null);
    },
    rename: (from: string, to: string, callback: Callback) => {
      renameCalls.push([from, to]);
      if (options.rename) {
        options.rename(from, to, callback);
        return;
      }
      const content = files.get(from);
      if (content) files.set(to, content);
      files.delete(from);
      callback(null);
    },
    ext_openssh_rename: (from: string, to: string, callback: Callback) => {
      extCalls.push([from, to]);
      options.extRename(from, to, callback);
    },
  };
  const sshClient = {
    sftp: (callback: (err: Error | null, sftp: SFTPWrapper) => void) => {
      callback(null, wrapper as unknown as SFTPWrapper);
    },
  } as unknown as Client;
  return { client: new SftpClient(sshClient), wrapper, extCalls, renameCalls, unlinkCalls };
}

async function initialized(files: Map<string, Buffer>, options: Parameters<typeof makeClient>[1]) {
  const setup = makeClient(files, options);
  await setup.client.init();
  return setup;
}

describe("SFTP 提交必须原子替换且保留最终目标", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("posix-rename 成功时不删除目标，也不走普通 rename", async () => {
    const files = new Map([["/data.txt", Buffer.from("ORIGINAL")]]);
    const setup = await initialized(files, {
      extRename: (from, to, callback) => {
        files.set(to, files.get(from)!);
        files.delete(from);
        callback(null);
      },
    });

    await setup.client.writeFile("/data.txt", "NEW", { timeout: 500 });

    expect(setup.extCalls).toHaveLength(1);
    expect(setup.extCalls[0][1]).toBe("/data.txt");
    expect(setup.extCalls[0][0]).toMatch(/^\/data\.txt\.part-/);
    expect(setup.renameCalls).toHaveLength(0);
    expect(setup.unlinkCalls).toEqual([]);
    expect(files.get("/data.txt")?.toString()).toBe("NEW");
    expect([...files.keys()].some((path) => path.includes(".part-"))).toBe(false);
  });

  it("仅在 ssh2 扩展不可用的同步抛出时退回普通 rename", async () => {
    const files = new Map([["/data.txt", Buffer.from("ORIGINAL")]]);
    const setup = await initialized(files, {
      extRename: () => {
        throw new Error("Server does not support this extended request");
      },
    });

    await setup.client.writeFile("/data.txt", "NEW", { timeout: 500 });

    expect(setup.renameCalls).toHaveLength(1);
    expect(setup.renameCalls[0][1]).toBe("/data.txt");
    expect(setup.unlinkCalls).toEqual([]);
    expect(files.get("/data.txt")?.toString()).toBe("NEW");
  });

  it("仅在扩展返回 OP_UNSUPPORTED（code 8）时退回普通 rename", async () => {
    const files = new Map([["/data.txt", Buffer.from("ORIGINAL")]]);
    const setup = await initialized(files, {
      extRename: (_from, _to, callback) => {
        callback(Object.assign(new Error("Operation unsupported"), { code: 8 }));
      },
    });

    await setup.client.writeFile("/data.txt", "NEW", { timeout: 500 });

    expect(setup.renameCalls).toHaveLength(1);
    expect(setup.unlinkCalls).toEqual([]);
    expect(files.get("/data.txt")?.toString()).toBe("NEW");
  });

  it("其他扩展错误直接失败，不 fallback、不删除最终目标", async () => {
    const files = new Map([["/data.txt", Buffer.from("ORIGINAL")]]);
    const setup = await initialized(files, {
      extRename: (_from, _to, callback) => {
        callback(Object.assign(new Error("Failure"), { code: 4 }));
      },
    });

    const error = await setup.client.writeFile("/data.txt", "NEW", { timeout: 500 })
      .catch((err: Error) => err) as SshOperationError;

    expect(error.message).toMatch(/Failed to commit remote file/);
    expect(error.retryable).toBe(false);
    expect(setup.renameCalls).toHaveLength(0);
    expect(setup.unlinkCalls.some((path) => path === "/data.txt")).toBe(false);
    expect(files.get("/data.txt")?.toString()).toBe("ORIGINAL");
  });

  it("扩展同步抛出非 unsupported 错误时也不 fallback", async () => {
    const files = new Map([["/data.txt", Buffer.from("ORIGINAL")]]);
    const setup = await initialized(files, {
      extRename: () => {
        throw new Error("unexpected extension failure");
      },
    });

    const error = await setup.client.writeFile("/data.txt", "NEW", { timeout: 500 })
      .catch((err: Error) => err) as SshOperationError;

    expect(error.message).toMatch(/Failed to commit remote file: unexpected extension failure/);
    expect(setup.renameCalls).toHaveLength(0);
    expect(setup.unlinkCalls.some((path) => path === "/data.txt")).toBe(false);
    expect(files.get("/data.txt")?.toString()).toBe("ORIGINAL");
  });

  it("普通 rename 失败时失败并保留最终目标", async () => {
    const files = new Map([["/data.txt", Buffer.from("ORIGINAL")]]);
    const setup = await initialized(files, {
      extRename: (_from, _to, callback) => {
        callback(Object.assign(new Error("Operation unsupported"), { code: 8 }));
      },
      // 模拟不能覆盖已有目标的 SFTP 服务端：拒绝 rename，但不影响已有目标。
      rename: (_from, _to, callback) => {
        callback(Object.assign(new Error("Failure"), { code: 4 }));
      },
    });

    await expect(setup.client.writeFile("/data.txt", "NEW", { timeout: 500 }))
      .rejects.toThrow(/Failed to commit remote file/);

    expect(setup.unlinkCalls.some((path) => path === "/data.txt")).toBe(false);
    expect(files.get("/data.txt")?.toString()).toBe("ORIGINAL");
    expect([...files.keys()].some((path) => path.includes(".part-"))).toBe(false);
  });

  it("提交挂起时按 timeout 结束，目标保持不变", async () => {
    const files = new Map([["/data.txt", Buffer.from("ORIGINAL")]]);
    const setup = await initialized(files, {
      extRename: () => {
        // 服务端接受扩展请求后永不响应。
      },
    });

    const start = Date.now();
    const error = await setup.client.writeFile("/data.txt", "NEW", { timeout: 100 })
      .catch((err: Error) => err) as SshOperationError;

    expect(Date.now() - start).toBeLessThan(1000);
    expect(error.message).toMatch(/SFTP timeout after 100ms/);
    expect(error.timedOut).toBe(true);
    expect(error.retryable).toBe(false);
    expect(setup.renameCalls).toHaveLength(0);
    expect(files.get("/data.txt")?.toString()).toBe("ORIGINAL");
    expect(setup.wrapper.end).toHaveBeenCalledTimes(1);
  });

  it("提交等待时取消，目标保持不变且标记 cancelled", async () => {
    const files = new Map([["/data.txt", Buffer.from("ORIGINAL")]]);
    let notifyExtCalled!: () => void;
    const extCalled = new Promise<void>((resolve) => {
      notifyExtCalled = resolve;
    });
    const setup = await initialized(files, {
      extRename: () => notifyExtCalled(),
    });
    const controller = new AbortController();

    const pending = setup.client.writeFile("/data.txt", "NEW", {
      timeout: 5000,
      signal: controller.signal,
    }).catch((err: Error) => err as SshOperationError);
    await extCalled;
    controller.abort();
    const error = await pending;

    expect(error.message).toMatch(/cancelled/i);
    expect(error.cancelled).toBe(true);
    expect(error.retryable).toBe(false);
    expect(files.get("/data.txt")?.toString()).toBe("ORIGINAL");
    expect(setup.renameCalls).toHaveLength(0);
  });
});
