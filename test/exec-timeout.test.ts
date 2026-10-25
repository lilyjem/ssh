import { EventEmitter } from "events";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SshClient } from "../src/services/ssh-client.js";
import { SshToolHandlers } from "../src/tools/ssh-tools.js";
import { startSshTestServer, TEST_PASSWORD, TEST_USER, waitFor } from "./helpers/ssh-test-server.js";

function fakeChannel() {
  const channel = new EventEmitter() as EventEmitter & {
    stderr: EventEmitter;
    close: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
    signal: ReturnType<typeof vi.fn>;
  };
  channel.stderr = new EventEmitter();
  channel.close = vi.fn();
  channel.destroy = vi.fn();
  channel.signal = vi.fn();
  return channel;
}

function connectedClient(timeout = 400): { client: SshClient; channel: ReturnType<typeof fakeChannel> } {
  const client = new SshClient({
    host: "127.0.0.1",
    port: 22,
    username: "tester",
    password: "secret",
    timeout,
  });
  (client as unknown as { connected: boolean }).connected = true;
  const channel = fakeChannel();
  client.getClient().exec = ((_command: string, callback: (err: Error | null, channel: unknown) => void) => {
    callback(null, channel);
    return client.getClient();
  }) as typeof client.getClient extends () => infer T ? T extends { exec: infer E } ? E : never : never;
  return { client, channel };
}

describe("ssh_exec 超时", () => {
  it("使用本次传入的超时，并关闭执行通道", async () => {
    const { client, channel } = connectedClient(400);
    const error = await client.execCommand("sleep", 80).catch((err: Error) => err);

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain("80");
    expect(error).toMatchObject({ timedOut: true, retryable: false });
    expect(channel.signal).toHaveBeenCalledWith("TERM");
    expect(channel.close).toHaveBeenCalled();
    expect(channel.destroy).toHaveBeenCalled();
  });

  it("超时后才打开的通道也会被关闭，且不会把结果当成成功", async () => {
    const client = new SshClient({
      host: "127.0.0.1",
      port: 22,
      username: "tester",
      password: "secret",
      timeout: 40,
    });
    (client as unknown as { connected: boolean }).connected = true;
    const channel = fakeChannel();
    let open: (() => void) | undefined;
    client.getClient().exec = ((_command: string, callback: (err: Error | null, channel: unknown) => void) => {
      open = () => callback(null, channel);
      return client.getClient();
    }) as typeof client.getClient extends () => infer T ? T extends { exec: infer E } ? E : never : never;

    const error = await client.execCommand("sleep", 40).catch((err: Error) => err);
    expect(error.message).toContain("40");
    open?.();
    expect(channel.close).toHaveBeenCalled();

    channel.emit("close");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect((error as { timedOut?: boolean }).timedOut).toBe(true);
  });

  it("通道打开后的错误标记命令已开始，不能再重试", async () => {
    const { client, channel } = connectedClient(2000);
    const pending = client.execCommand("rm important");
    channel.emit("data", Buffer.from("partial"));
    channel.emit("error", Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }));

    const error = await pending.catch((err: Error) => err);
    expect(error.message).toContain("Channel error");
    expect(error).toMatchObject({ commandStarted: true, retryable: false });
  });
});

describe("ssh_exec 超时会传到真实会话", () => {
  const closers: Array<() => Promise<void>> = [];
  const dirs: string[] = [];

  afterEach(async () => {
    for (const close of closers) await close();
    closers.length = 0;
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    dirs.length = 0;
  });

  it("单次 timeout 覆盖连接默认值，并让远端执行通道关闭", async () => {
    const server = await startSshTestServer();
    closers.push(() => server.close());
    const dir = mkdtempSync(join(tmpdir(), "ssh-mcp-timeout-"));
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
      timeout: 4000,
      connect_timeout: 3000,
      keepalive_interval: 0,
    });

    const start = Date.now();
    await expect(handlers.exec({
      session_id: connected.session_id,
      command: "sleep",
      timeout: 1000,
    })).rejects.toThrow(/Command execution timeout after 1000ms/);
    expect(Date.now() - start).toBeLessThan(2000);
    await waitFor(() => server.stats.sleepClosed, 1000);
    expect(server.stats.execs.filter((command) => command === "sleep")).toHaveLength(1);

    const result = await handlers.exec({
      session_id: connected.session_id,
      command: "echo hi",
      timeout: 2000,
    });
    expect(result.stdout).toContain("ok:echo hi");
  });
});
