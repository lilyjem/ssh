import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import { SshToolHandlers } from "../src/tools/ssh-tools.js";
import { startSshTestServer, TEST_PASSWORD, TEST_USER, waitFor } from "./helpers/ssh-test-server.js";

describe("后台长任务", () => {
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
    const dir = mkdtempSync(join(tmpdir(), "ssh-mcp-job-"));
    dirs.push(dir);
    const handlers = new SshToolHandlers({
      maxReconnectAttempts: 1,
      strictHostKeyChecking: "no",
      knownHostsPath: join(dir, "known_hosts"),
    });
    const connected = await handlers.connect({
      host: "127.0.0.1",
      port: server.port,
      username: TEST_USER,
      password: TEST_PASSWORD,
      timeout: 30000,
      connect_timeout: 3000,
      keepalive_interval: 0,
    });
    return { server, handlers, sessionId: connected.session_id };
  }

  it("后台命令立刻返回，轮询能看到结束后的输出", async () => {
    const { handlers, sessionId } = await setup();
    const started = await handlers.exec({
      session_id: sessionId,
      command: "echo hi",
      background: true,
    });
    expect(started).toMatchObject({ background: true, status: "running" });
    if (!("job_id" in started)) throw new Error("缺少 job_id");

    await waitFor(async () => {
      const polled = await handlers.pollExec({ job_id: started.job_id });
      return polled.status === "exited";
    });
    const done = await handlers.pollExec({ job_id: started.job_id });
    expect(done.stdout).toContain("ok:echo hi");
    expect(done.exit_code).toBe(0);

    const tail = await handlers.pollExec({ job_id: started.job_id, stdout_offset: 3 });
    expect(tail.stdout).toBe(done.stdout.slice(3));
    expect(tail.next_stdout_offset).toBe(done.stdout.length);
  }, 5000);

  it("取消后台命令会关闭远端执行通道", async () => {
    const { server, handlers, sessionId } = await setup();
    const started = await handlers.exec({
      session_id: sessionId,
      command: "sleep",
      background: true,
    });
    if (!("job_id" in started)) throw new Error("缺少 job_id");
    await waitFor(() => server.stats.execs.includes("sleep"));

    const cancelled = await handlers.cancelExec({ job_id: started.job_id });
    expect(cancelled.status).toBe("cancelled");
    await waitFor(() => server.stats.sleepClosed);
    const polled = await handlers.pollExec({ job_id: started.job_id });
    expect(polled.status).toBe("cancelled");
  }, 5000);

  it("前台执行在调用方取消时关闭通道", async () => {
    const { server, handlers, sessionId } = await setup();
    const controller = new AbortController();
    const pending = handlers.exec({
      session_id: sessionId,
      command: "sleep",
      timeout: 30000,
    }, controller.signal);
    await waitFor(() => server.stats.execs.includes("sleep"));
    controller.abort();
    await expect(pending).rejects.toThrow(/cancel/i);
    await waitFor(() => server.stats.sleepClosed);
  }, 5000);

  it("连接中断时后台任务标记为 failed，而不是用 null 状态冒充成功", async () => {
    const { server, handlers, sessionId } = await setup();
    const started = await handlers.exec({
      session_id: sessionId,
      command: "sleep",
      background: true,
    });
    if (!("job_id" in started)) throw new Error("缺少 job_id");
    await waitFor(() => server.stats.execs.includes("sleep"));

    server.dropClients();
    await waitFor(async () => {
      const polled = await handlers.pollExec({ job_id: started.job_id });
      return polled.status === "failed";
    }, 3000);

    const failed = await handlers.pollExec({ job_id: started.job_id });
    expect(failed.status).toBe("failed");
    expect(failed.exit_code).toBeNull();
  }, 5000);
});
