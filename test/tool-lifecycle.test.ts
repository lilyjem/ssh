import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { SFTPWrapper } from "ssh2";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SshToolHandlers } from "../src/tools/ssh-tools.js";
import { SshClient } from "../src/services/ssh-client.js";
import { CHARACTER_LIMIT } from "../src/constants.js";
import { startSshTestServer, TEST_PASSWORD, TEST_USER, waitFor } from "./helpers/ssh-test-server.js";

interface JobRecord {
  id: string;
  sessionId: string;
  status: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  truncated: boolean;
  cancel: () => void;
  createdAt: number;
  finishedAt: number | null;
}

interface HandlerInternals {
  clients: Map<string, SshClient>;
  sftpClients: Map<string, unknown>;
  jobs: Map<string, JobRecord>;
  sftpInits: Map<string, unknown>;
  retiredSessions: Set<string>;
  defaultSessionId: string | null;
  rememberRetiredSession: (sessionId: string) => void;
  appendJobOutput: (job: JobRecord, field: "stdout" | "stderr", chunk: string) => void;
}

function internals(handlers: SshToolHandlers): HandlerInternals {
  return handlers as unknown as HandlerInternals;
}

interface TrackedSignal {
  signal: AbortSignal;
  listeners: Set<() => void>;
  abort: () => void;
}

function trackedSignal(): TrackedSignal {
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

interface FakeSftpWrapper extends SFTPWrapper {
  end: ReturnType<typeof vi.fn>;
}

function fakeSftpWrapper(): FakeSftpWrapper {
  return {
    end: vi.fn(),
    on: vi.fn(),
    readdir: (_path: string, callback: (err: Error | null, list: unknown[]) => void) => {
      callback(null, []);
    },
  } as unknown as FakeSftpWrapper;
}

async function flushEvents(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

describe("SSH 工具会话生命周期", () => {
  const closers: Array<() => Promise<void>> = [];
  const dirs: string[] = [];
  const instances: SshToolHandlers[] = [];

  afterEach(async () => {
    vi.useRealTimers();
    for (const handlers of instances) {
      try {
        await handlers.cleanup();
      } catch {
        // 测试清理不能掩盖断言失败。
      }
    }
    instances.length = 0;
    for (const close of closers) await close();
    closers.length = 0;
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    dirs.length = 0;
  });

  async function setup() {
    const server = await startSshTestServer();
    closers.push(() => server.close());
    const dir = mkdtempSync(join(tmpdir(), "ssh-mcp-lifecycle-"));
    dirs.push(dir);
    const handlers = new SshToolHandlers({
      maxReconnectAttempts: 3,
      reconnectBaseDelay: 20,
      reconnectMaxDelay: 30,
      strictHostKeyChecking: "no",
      knownHostsPath: join(dir, "known_hosts"),
    });
    instances.push(handlers);

    const connectParams = {
      host: "127.0.0.1",
      port: server.port,
      username: TEST_USER,
      password: TEST_PASSWORD,
      timeout: 30000,
      connect_timeout: 3000,
      keepalive_interval: 0,
    };
    const connected = await handlers.connect(connectParams);
    return { server, handlers, sessionId: connected.session_id, connectParams };
  }

  it("session_id 为空串时拒绝而不是回退默认会话", async () => {
    const { handlers, sessionId } = await setup();
    internals(handlers).defaultSessionId = sessionId;

    await expect(handlers.exec({ session_id: "", command: "echo hi" })).rejects.toThrow(/session_id/);
    await expect(handlers.disconnect({ session_id: "" })).rejects.toThrow(/session_id/);

    const result = await handlers.exec({ command: "echo hi" });
    if ("background" in result) throw new Error("不应返回后台任务");
    expect(result.stdout).toContain("ok:echo hi");
  }, 10000);

  it("disconnect 可重复调用，未知会话仍然明确报错", async () => {
    const { handlers, sessionId } = await setup();
    const first = await handlers.disconnect({ session_id: sessionId });
    expect(first.success).toBe(true);

    const again = await handlers.disconnect({ session_id: sessionId });
    expect(again.success).toBe(true);
    expect(again.message).toMatch(/already disconnected/);

    await expect(handlers.disconnect({ session_id: "missing-session" }))
      .rejects.toThrow(/Session not found/);
  }, 10000);

  it("disconnect 在 await 前完成围栏，取消任务且不再重连", async () => {
    const { server, handlers, sessionId } = await setup();
    const started = await handlers.exec({
      session_id: sessionId,
      command: "sleep",
      background: true,
    });
    if (!("job_id" in started)) throw new Error("缺少 job_id");
    await waitFor(() => server.stats.execs.includes("sleep"));

    const client = internals(handlers).clients.get(sessionId)!;
    const reconnect = vi.spyOn(client, "reconnect");
    const disconnecting = handlers.disconnect({ session_id: sessionId });

    // 不 await disconnect，先确认同步状态已经隔离。
    expect(internals(handlers).clients.has(sessionId)).toBe(false);
    expect(handlers.listSessions().count).toBe(0);
    await expect(handlers.pollExec({ job_id: started.job_id })).rejects.toThrow(/Job not found/);
    await expect(handlers.exec({
      session_id: sessionId,
      command: "echo late",
    })).rejects.toThrow(/Session not found|disconnected|closing/);

    expect(reconnect).not.toHaveBeenCalled();
    await disconnecting;
    await waitFor(() => server.stats.sleepClosed);
  }, 10000);

  it("客户端被显式关闭后操作被围栏且不再重连", async () => {
    const { handlers, sessionId } = await setup();
    const client = internals(handlers).clients.get(sessionId)!;
    const reconnect = vi.spyOn(client, "reconnect");
    await client.close();

    await expect(handlers.exec({ session_id: sessionId, command: "echo hi" }))
      .rejects.toThrow(/disconnected|closing/);
    expect(reconnect).not.toHaveBeenCalled();
    expect(handlers.listSessions().count).toBe(0);
    expect(internals(handlers).clients.has(sessionId)).toBe(false);
  }, 10000);

  it("断开时正在进行的重连完成后不会复活会话", async () => {
    const { handlers, sessionId } = await setup();
    const client = internals(handlers).clients.get(sessionId)!;
    (client as unknown as { connected: boolean }).connected = false;

    let resolveReconnect!: () => void;
    const reconnect = vi.spyOn(client, "reconnect").mockImplementation(
      () => new Promise<void>((resolve) => {
        resolveReconnect = resolve;
      })
    );

    const pending = handlers.exec({ session_id: sessionId, command: "echo hi" });
    await waitFor(() => reconnect.mock.calls.length === 1);

    const disconnecting = handlers.disconnect({ session_id: sessionId });
    resolveReconnect();

    await expect(pending).rejects.toThrow(/disconnected|closing/);
    await disconnecting;

    expect(reconnect).toHaveBeenCalledTimes(1);
    expect(internals(handlers).clients.has(sessionId)).toBe(false);
  }, 10000);

  it("断开后正在退避的操作不会再次尝试", async () => {
    const { handlers, sessionId } = await setup();
    const client = internals(handlers).clients.get(sessionId)!;
    const execCommand = vi.spyOn(client, "execCommand").mockImplementation(async () => {
      throw new Error("Not connected");
    });

    const pending = handlers.exec({ session_id: sessionId, command: "echo hi" });
    await waitFor(() => execCommand.mock.calls.length === 1);

    const disconnecting = handlers.disconnect({ session_id: sessionId });
    await expect(pending).rejects.toThrow(/disconnected|closing|Session/);
    await disconnecting;

    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(execCommand).toHaveBeenCalledTimes(1);
  }, 10000);

  it("关闭的 SFTP 缓存不会被返回，而是重新初始化", async () => {
    const { handlers, sessionId } = await setup();
    const stale = { close: vi.fn(), isAlive: () => false };
    internals(handlers).sftpClients.set(sessionId, stale);

    await expect(handlers.sftpRead({
      session_id: sessionId,
      path: "/does-not-exist",
    })).rejects.toThrow(/Failed to stat/);

    expect(stale.close).toHaveBeenCalledTimes(1);
    const cached = internals(handlers).sftpClients.get(sessionId);
    expect(cached).toBeTruthy();
    expect(cached).not.toBe(stale);
  }, 10000);

  it("断开后晚到的 SFTP init 不会写回缓存", async () => {
    const { handlers, sessionId } = await setup();
    const client = internals(handlers).clients.get(sessionId)!;
    const rawClient = client.getClient();

    let initCallback!: (err: Error | null, sftp: SFTPWrapper) => void;
    (rawClient as unknown as {
      sftp: (callback: (err: Error | null, sftp: SFTPWrapper) => void) => void;
    }).sftp = (callback) => {
      initCallback = callback;
    };

    const lateWrapper = { end: vi.fn() } as unknown as SFTPWrapper;
    const pending = handlers.sftpRead({ session_id: sessionId, path: "/late" });
    await waitFor(() => !!initCallback);

    const disconnecting = handlers.disconnect({ session_id: sessionId });
    initCallback(null, lateWrapper);

    await expect(pending).rejects.toThrow(/SFTP client is closed|disconnected|closing/);
    await disconnecting;

    expect(internals(handlers).sftpClients.has(sessionId)).toBe(false);
    expect(internals(handlers).sftpInits.has(sessionId)).toBe(false);
    expect(lateWrapper.end).toHaveBeenCalledTimes(1);
  }, 10000);

  it("SFTP 初始化会使用本次操作的超时", async () => {
    const { handlers, sessionId } = await setup();
    const client = internals(handlers).clients.get(sessionId)!;
    const rawClient = client.getClient();
    (rawClient as unknown as { sftp: () => void }).sftp = () => {
      // 永不回调，模拟初始化卡住。
    };

    const start = Date.now();
    await expect(handlers.sftpRead({
      session_id: sessionId,
      path: "/stuck",
      timeout: 1000,
    })).rejects.toThrow(/SFTP timeout after 1000ms/);
    expect(Date.now() - start).toBeLessThan(3000);
  }, 10000);

  it("加入共享初始化时，第二个调用按自己的超时结束且不取消第一个", async () => {
    const { handlers, sessionId } = await setup();
    const client = internals(handlers).clients.get(sessionId)!;
    const rawClient = client.getClient();
    const callbacks: Array<(err: Error | null, sftp: SFTPWrapper) => void> = [];
    (rawClient as unknown as {
      sftp: (callback: (err: Error | null, sftp: SFTPWrapper) => void) => void;
    }).sftp = (callback) => {
      callbacks.push(callback);
    };

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    const first = handlers.sftpList({
      session_id: sessionId,
      path: "/",
      timeout: 30000,
    });
    await flushEvents();
    expect(callbacks).toHaveLength(1);

    const second = handlers.sftpList({
      session_id: sessionId,
      path: "/",
      timeout: 1000,
    }).catch((err: Error) => err);
    await flushEvents();
    // 第二个调用只等待，不应再打开一次 SFTP 通道。
    expect(callbacks).toHaveLength(1);
    // 底层 init 的配置超时 + 第一个/第二个调用各自的等待 deadline。
    expect(vi.getTimerCount()).toBe(3);

    await vi.advanceTimersByTimeAsync(1000);
    const secondError = await second as unknown as Error;
    expect(secondError).toMatchObject({ timedOut: true, retryable: false });
    expect(secondError.message).toContain("1000");
    expect(callbacks).toHaveLength(1);

    let firstSettled = false;
    first.then(() => { firstSettled = true; }, () => { firstSettled = true; });
    await flushEvents();
    expect(firstSettled).toBe(false);
    expect(internals(handlers).sftpClients.has(sessionId)).toBe(false);
    expect(internals(handlers).sftpInits.has(sessionId)).toBe(true);
    // 第二个等待者的定时器已经清掉，第一个等待者和底层 init 仍在。
    expect(vi.getTimerCount()).toBe(2);

    const wrapper = fakeSftpWrapper();
    callbacks[0](null, wrapper);
    const firstResult = await first;
    expect(firstResult.count).toBe(0);
    expect(internals(handlers).sftpClients.get(sessionId)).toBeTruthy();
    expect(vi.getTimerCount()).toBe(0);
  }, 15000);

  it("加入共享初始化后取消只结束等待者，第一个调用继续成功", async () => {
    const { handlers, sessionId } = await setup();
    const client = internals(handlers).clients.get(sessionId)!;
    const rawClient = client.getClient();
    const callbacks: Array<(err: Error | null, sftp: SFTPWrapper) => void> = [];
    (rawClient as unknown as {
      sftp: (callback: (err: Error | null, sftp: SFTPWrapper) => void) => void;
    }).sftp = (callback) => {
      callbacks.push(callback);
    };

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const firstSignal = trackedSignal();
    const secondSignal = trackedSignal();

    const first = handlers.sftpList({
      session_id: sessionId,
      path: "/",
      timeout: 30000,
    }, firstSignal.signal);
    await flushEvents();
    expect(callbacks).toHaveLength(1);

    const second = handlers.sftpList({
      session_id: sessionId,
      path: "/",
      timeout: 30000,
    }, secondSignal.signal);
    await flushEvents();
    expect(callbacks).toHaveLength(1);
    expect(secondSignal.listeners.size).toBe(1);

    secondSignal.abort();
    const secondError = await second.catch((err: Error) => err);
    expect(secondError).toMatchObject({ cancelled: true, retryable: false });
    expect(secondError.message).toMatch(/cancelled/i);
    expect(secondSignal.listeners.size).toBe(0);
    expect(callbacks).toHaveLength(1);

    let firstSettled = false;
    first.then(() => { firstSettled = true; }, () => { firstSettled = true; });
    await flushEvents();
    expect(firstSettled).toBe(false);
    expect(internals(handlers).sftpInits.has(sessionId)).toBe(true);

    const wrapper = fakeSftpWrapper();
    callbacks[0](null, wrapper);
    const firstResult = await first;
    expect(firstResult.count).toBe(0);
    expect(firstSignal.listeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  }, 15000);

  it("第一个调用取消不会中断第二个调用等待的共享初始化", async () => {
    const { handlers, sessionId } = await setup();
    const client = internals(handlers).clients.get(sessionId)!;
    const rawClient = client.getClient();
    const callbacks: Array<(err: Error | null, sftp: SFTPWrapper) => void> = [];
    (rawClient as unknown as {
      sftp: (callback: (err: Error | null, sftp: SFTPWrapper) => void) => void;
    }).sftp = (callback) => {
      callbacks.push(callback);
    };

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const firstSignal = trackedSignal();
    const secondSignal = trackedSignal();

    const first = handlers.sftpList({
      session_id: sessionId,
      path: "/",
      timeout: 30000,
    }, firstSignal.signal).catch((err: Error) => err);
    await flushEvents();
    expect(callbacks).toHaveLength(1);

    const second = handlers.sftpList({
      session_id: sessionId,
      path: "/",
      timeout: 30000,
    }, secondSignal.signal);
    await flushEvents();
    expect(callbacks).toHaveLength(1);
    expect(firstSignal.listeners.size).toBe(1);
    expect(secondSignal.listeners.size).toBe(1);

    // 创建者取消只释放自己的 waiter，底层 init 不再绑定第一个调用的 signal。
    firstSignal.abort();
    const firstError = await first as unknown as Error;
    expect(firstError).toMatchObject({ cancelled: true, retryable: false });
    expect(firstError.message).toMatch(/cancelled/i);
    expect(firstSignal.listeners.size).toBe(0);
    expect(secondSignal.listeners.size).toBe(1);
    expect(callbacks).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(2);

    let secondSettled = false;
    second.then(() => { secondSettled = true; }, () => { secondSettled = true; });
    await flushEvents();
    expect(secondSettled).toBe(false);
    expect(internals(handlers).sftpInits.has(sessionId)).toBe(true);

    const wrapper = fakeSftpWrapper();
    callbacks[0](null, wrapper);
    const secondResult = await second;
    expect(secondResult.count).toBe(0);
    expect(secondSignal.listeners.size).toBe(0);
    expect(internals(handlers).sftpClients.get(sessionId)).toBeTruthy();
    expect(vi.getTimerCount()).toBe(0);
  }, 15000);

  it("最后一个等待者取消时会关闭未完成的初始化", async () => {
    const { handlers, sessionId } = await setup();
    const client = internals(handlers).clients.get(sessionId)!;
    const rawClient = client.getClient();
    const callbacks: Array<(err: Error | null, sftp: SFTPWrapper) => void> = [];
    (rawClient as unknown as {
      sftp: (callback: (err: Error | null, sftp: SFTPWrapper) => void) => void;
    }).sftp = (callback) => {
      callbacks.push(callback);
    };

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const signal = trackedSignal();
    const pending = handlers.sftpList({
      session_id: sessionId,
      path: "/",
      timeout: 30000,
    }, signal.signal).catch((err: Error) => err);
    await flushEvents();
    expect(callbacks).toHaveLength(1);

    signal.abort();
    const error = await pending;
    expect(error).toMatchObject({ cancelled: true, retryable: false });
    expect(internals(handlers).sftpInits.has(sessionId)).toBe(false);
    expect(internals(handlers).sftpClients.has(sessionId)).toBe(false);
    // 底层 init 和最后一个 waiter 的定时器都应该被清理。
    expect(vi.getTimerCount()).toBe(0);

    const wrapper = fakeSftpWrapper();
    callbacks[0](null, wrapper);
    expect(wrapper.end).toHaveBeenCalledTimes(1);
  }, 10000);

  it("retiredSessions 只保留最近 256 个断开会话 ID", async () => {
    const handlers = new SshToolHandlers();
    const state = internals(handlers);
    for (let index = 0; index < 300; index++) {
      state.rememberRetiredSession(`retired-${index}`);
    }

    expect(state.retiredSessions.size).toBe(256);
    expect(state.retiredSessions.has("retired-0")).toBe(false);
    expect(state.retiredSessions.has("retired-299")).toBe(true);

    await expect(handlers.disconnect({ session_id: "retired-0" }))
      .rejects.toThrow(/Session not found/);
    const recent = await handlers.disconnect({ session_id: "retired-299" });
    expect(recent.success).toBe(true);
    expect(recent.message).toMatch(/already disconnected/);
  }, 10000);

  it("断开一个会话只取消它自己的后台任务", async () => {
    const { server, handlers, sessionId, connectParams } = await setup();
    const second = await handlers.connect(connectParams);

    const firstJob = await handlers.exec({
      session_id: sessionId,
      command: "sleep",
      background: true,
    });
    if (!("job_id" in firstJob)) throw new Error("缺少 job_id");
    const secondJob = await handlers.exec({
      session_id: second.session_id,
      command: "echo keep",
      background: true,
    });
    if (!("job_id" in secondJob)) throw new Error("缺少 job_id");

    await waitFor(async () => {
      const polled = await handlers.pollExec({ job_id: secondJob.job_id });
      return polled.status === "exited";
    });
    await waitFor(() => server.stats.execs.includes("sleep"));

    await handlers.disconnect({ session_id: sessionId });

    await expect(handlers.pollExec({ job_id: firstJob.job_id })).rejects.toThrow(/Job not found/);
    const kept = await handlers.pollExec({ job_id: secondJob.job_id });
    expect(kept.status).toBe("exited");
    expect(kept.stdout).toContain("ok:echo keep");

    const stillWorks = await handlers.exec({
      session_id: second.session_id,
      command: "echo alive",
    });
    if ("background" in stillWorks) throw new Error("不应返回后台任务");
    expect(stillWorks.stdout).toContain("ok:echo alive");
    await waitFor(() => server.stats.sleepClosed);
  }, 15000);

  it("调用方取消后台任务时状态归类为 cancelled", async () => {
    const { server, handlers, sessionId } = await setup();
    const controller = new AbortController();
    const started = await handlers.exec({
      session_id: sessionId,
      command: "sleep",
      background: true,
    }, controller.signal);
    if (!("job_id" in started)) throw new Error("缺少 job_id");
    await waitFor(() => server.stats.execs.includes("sleep"));

    controller.abort();
    await waitFor(async () => {
      const polled = await handlers.pollExec({ job_id: started.job_id });
      return polled.status === "cancelled";
    });
    const job = internals(handlers).jobs.get(started.job_id)!;
    expect(job.finishedAt).not.toBeNull();
    await waitFor(() => server.stats.sleepClosed);
  }, 10000);

  it("后台任务上限为 32 个运行中任务，过期终态会被惰性清理", async () => {
    const { server, handlers, sessionId } = await setup();
    const jobs = internals(handlers).jobs;
    const now = Date.now();

    for (let index = 0; index < 32; index++) {
      const id = `seed-running-${index}`;
      jobs.set(id, {
        id,
        sessionId,
        status: "running",
        stdout: "",
        stderr: "",
        exitCode: null,
        truncated: false,
        cancel: vi.fn(),
        createdAt: now,
        finishedAt: null,
      });
    }

    await expect(handlers.exec({
      session_id: sessionId,
      command: "echo rejected",
      background: true,
    })).rejects.toThrow(/Too many background jobs/);
    expect(jobs.size).toBe(32);
    expect(server.stats.execs).not.toContain("echo rejected");

    // 把一个任务改成超过 15 分钟 TTL 的终态，下一次启动应惰性清理它。
    const expired = jobs.get("seed-running-0")!;
    expired.status = "exited";
    expired.finishedAt = Date.now() - 16 * 60 * 1000;

    const started = await handlers.exec({
      session_id: sessionId,
      command: "echo accepted",
      background: true,
    });
    if (!("job_id" in started)) throw new Error("缺少 job_id");
    expect(jobs.has("seed-running-0")).toBe(false);
    expect(jobs.size).toBe(32);

    await handlers.cancelExec({ job_id: started.job_id });
  }, 15000);

  it("终态任务短暂保留可轮询，之后按 TTL 清理", async () => {
    const { handlers, sessionId } = await setup();
    const started = await handlers.exec({
      session_id: sessionId,
      command: "echo done",
      background: true,
    });
    if (!("job_id" in started)) throw new Error("缺少 job_id");

    await waitFor(async () => {
      const polled = await handlers.pollExec({ job_id: started.job_id });
      return polled.status === "exited";
    });

    const firstPoll = await handlers.pollExec({ job_id: started.job_id });
    expect(firstPoll.stdout).toContain("ok:echo done");
    const job = internals(handlers).jobs.get(started.job_id)!;
    expect(job.finishedAt).not.toBeNull();

    // 终态后再取消不能把状态改回 cancelled。
    const cancelled = await handlers.cancelExec({ job_id: started.job_id });
    expect(cancelled.status).toBe("exited");

    job.finishedAt = Date.now() - 16 * 60 * 1000;
    await expect(handlers.pollExec({ job_id: started.job_id })).rejects.toThrow(/Job not found/);
    expect(internals(handlers).jobs.has(started.job_id)).toBe(false);
  }, 10000);

  it("后台输出截断不会留下半个代理对", () => {
    const handlers = new SshToolHandlers();
    const job: JobRecord = {
      id: "surrogate-job",
      sessionId: "unused",
      status: "running",
      stdout: "",
      stderr: "",
      exitCode: null,
      truncated: false,
      cancel: () => {},
      createdAt: Date.now(),
      finishedAt: null,
    };

    internals(handlers).appendJobOutput(job, "stdout", "a".repeat(CHARACTER_LIMIT - 1) + "😀");
    expect(job.stdout.length).toBeLessThanOrEqual(CHARACTER_LIMIT);
    expect(job.truncated).toBe(true);

    const last = job.stdout.charCodeAt(job.stdout.length - 1);
    expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
    expect(last >= 0xdc00 && last <= 0xdfff).toBe(false);
  });

  it("cleanup 幂等，并释放会话、SFTP 缓存和后台任务", async () => {
    const { server, handlers, sessionId } = await setup();
    const started = await handlers.exec({
      session_id: sessionId,
      command: "sleep",
      background: true,
    });
    if (!("job_id" in started)) throw new Error("缺少 job_id");
    await waitFor(() => server.stats.execs.includes("sleep"));

    const client = internals(handlers).clients.get(sessionId)!;
    await handlers.cleanup();
    await handlers.cleanup();

    expect(handlers.listSessions().count).toBe(0);
    expect(internals(handlers).clients.size).toBe(0);
    expect(internals(handlers).sftpClients.size).toBe(0);
    expect(internals(handlers).jobs.size).toBe(0);
    expect(client.isClosed()).toBe(true);
    await waitFor(() => server.stats.sleepClosed);
  }, 10000);
});
