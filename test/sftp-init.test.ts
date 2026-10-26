import { EventEmitter } from "events";
import type { Client, SFTPWrapper } from "ssh2";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SftpClient } from "../src/services/sftp-client.js";
import type { SshOperationError } from "../src/utils/errors.js";

type SftpCallback = (err: Error | null, sftp: SFTPWrapper) => void;

function fakeWrapper(): EventEmitter & { end: ReturnType<typeof vi.fn> } {
  const wrapper = new EventEmitter() as EventEmitter & { end: ReturnType<typeof vi.fn> };
  wrapper.end = vi.fn();
  return wrapper;
}

function controllableClient(): {
  client: SftpClient;
  sftp: ReturnType<typeof vi.fn>;
  callbacks: SftpCallback[];
} {
  const callbacks: SftpCallback[] = [];
  const sftp = vi.fn((callback: SftpCallback) => {
    callbacks.push(callback);
  });
  const client = new SftpClient({ sftp } as unknown as Client);
  return { client, sftp, callbacks };
}

function trackedSignal(): {
  signal: AbortSignal;
  listeners: Set<() => void>;
  abort: () => void;
} {
  const listeners = new Set<() => void>();
  const signal = {
    aborted: false,
    addEventListener: (_type: string, listener: () => void) => {
      listeners.add(listener);
    },
    removeEventListener: (_type: string, listener: () => void) => {
      listeners.delete(listener);
    },
  } as unknown as AbortSignal & { abort: () => void };
  signal.abort = () => {
    signal.aborted = true;
    for (const listener of [...listeners]) listener();
  };
  return { signal, listeners, abort: signal.abort };
}

describe("SFTP init 生命周期", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("超时后结束迟到的 wrapper，不复活客户端", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { client, callbacks } = controllableClient();
    const wrapper = fakeWrapper();
    const { signal, listeners } = trackedSignal();

    const pending = client.init({ timeout: 1000, signal }).catch((err: Error) => err as SshOperationError);
    expect(vi.getTimerCount()).toBe(1);
    expect(listeners.size).toBe(1);
    await vi.advanceTimersByTimeAsync(1000);
    const error = await pending;

    expect(error.message).toMatch(/SFTP timeout after 1000ms/);
    expect(error.timedOut).toBe(true);
    expect(client.isAlive()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    expect(listeners.size).toBe(0);

    callbacks[0](null, wrapper as unknown as SFTPWrapper);
    expect(wrapper.end).toHaveBeenCalledTimes(1);
    expect(client.isAlive()).toBe(false);
    // 迟到的会话带有 error 监听器，随后断链也不会产生未处理 error。
    wrapper.emit("error", new Error("late channel error"));
  });

  it("超时前的取消在发起请求前完成时不调用 client.sftp", async () => {
    const { client, sftp } = controllableClient();
    const { signal, listeners, abort } = trackedSignal();
    abort();

    const error = await client.init({ timeout: 1000, signal }).catch((err: Error) => err as SshOperationError);

    expect(sftp).not.toHaveBeenCalled();
    expect(error.message).toMatch(/cancelled/i);
    expect(error.cancelled).toBe(true);
    expect(error.retryable).toBe(false);
    expect(listeners.size).toBe(0);
  });

  it("init 进行中取消后，迟到的 wrapper 只被关闭", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { client, callbacks } = controllableClient();
    const wrapper = fakeWrapper();
    const { signal, listeners, abort } = trackedSignal();

    const pending = client.init({ timeout: 5000, signal }).catch((err: Error) => err as SshOperationError);
    expect(callbacks).toHaveLength(1);
    abort();
    const error = await pending;

    expect(error.cancelled).toBe(true);
    expect(listeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);

    callbacks[0](null, wrapper as unknown as SFTPWrapper);
    expect(wrapper.end).toHaveBeenCalledTimes(1);
    expect(client.isAlive()).toBe(false);
  });

  it("并发 init 共享一次请求，成功后 isAlive 为 true", async () => {
    const { client, sftp, callbacks } = controllableClient();
    const wrapper = fakeWrapper();

    const first = client.init({ timeout: 1000 });
    const second = client.init({ timeout: 1000 });
    expect(sftp).toHaveBeenCalledTimes(1);

    callbacks[0](null, wrapper as unknown as SFTPWrapper);
    await Promise.all([first, second]);

    expect(client.isAlive()).toBe(true);
  });

  it("close 幂等并阻止进行中的 init 成功", async () => {
    const { client, callbacks } = controllableClient();
    const wrapper = fakeWrapper();
    const { signal, listeners } = trackedSignal();

    const pending = client.init({ timeout: 5000, signal }).catch((err: Error) => err as SshOperationError);
    client.close();
    const error = await pending;

    expect(error.message).toMatch(/closed/i);
    expect(error.retryable).toBe(false);
    expect(client.isAlive()).toBe(false);
    expect(listeners.size).toBe(0);

    callbacks[0](null, wrapper as unknown as SFTPWrapper);
    expect(wrapper.end).toHaveBeenCalledTimes(1);
    expect(client.isAlive()).toBe(false);

    client.close();
    expect(wrapper.end).toHaveBeenCalledTimes(1);
    await expect(client.init()).rejects.toThrow(/closed/i);
  });

  it("观察 wrapper 的 close/end/error 并使 isAlive 失效，之后可重新 init", async () => {
    const { client, sftp, callbacks } = controllableClient();
    const first = fakeWrapper();
    const second = fakeWrapper();

    const initial = client.init();
    callbacks[0](null, first as unknown as SFTPWrapper);
    await initial;
    expect(client.isAlive()).toBe(true);

    first.emit("error", new Error("channel failed"));
    expect(client.isAlive()).toBe(false);

    const reinit = client.init();
    expect(sftp).toHaveBeenCalledTimes(2);
    callbacks[1](null, second as unknown as SFTPWrapper);
    await reinit;
    expect(client.isAlive()).toBe(true);

    second.emit("close");
    expect(client.isAlive()).toBe(false);
  });

  it("init 回调报错可重试，且不会保存失败的会话", async () => {
    const { client, callbacks } = controllableClient();
    const wrapper = fakeWrapper();

    const first = client.init({ timeout: 1000 }).catch((err: Error) => err);
    callbacks[0](new Error("sftp channel refused"), wrapper as unknown as SFTPWrapper);
    const error = await first;

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/Failed to initialize SFTP/);
    expect(client.isAlive()).toBe(false);

    const retry = client.init({ timeout: 1000 });
    callbacks[1](null, wrapper as unknown as SFTPWrapper);
    await retry;
    expect(client.isAlive()).toBe(true);
  });
});
