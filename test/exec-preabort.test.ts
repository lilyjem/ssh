import { EventEmitter } from "events";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SshClient } from "../src/services/ssh-client.js";
import { startSshTestServer, TEST_PASSWORD, TEST_USER } from "./helpers/ssh-test-server.js";

type ExecCallback = (error: Error | null, channel?: unknown) => void;

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

function connectedClient(onExec?: (callback: ExecCallback) => void) {
  const client = new SshClient({
    host: "127.0.0.1",
    port: 22,
    username: "tester",
    password: "secret",
    timeout: 2000,
  });
  (client as unknown as { connected: boolean }).connected = true;
  const channel = fakeChannel();
  const exec = vi.fn((_command: string, callback: ExecCallback) => {
    if (onExec) onExec(callback);
    else callback(null, channel);
  });
  (client.getClient() as unknown as { exec: typeof exec }).exec = exec;
  return { client, channel, exec };
}

describe("ssh 取消后不发送命令", () => {
  it("预取消的 signal 不调用 ssh2 exec，并返回不可重试的取消错误", async () => {
    const { client, exec } = connectedClient();
    const controller = new AbortController();
    controller.abort();
    const addSpy = vi.spyOn(controller.signal, "addEventListener");

    const error = await client.execCommand("rm important", 2000, controller.signal)
      .catch((err: Error) => err);

    expect(exec).not.toHaveBeenCalled();
    expect(addSpy).not.toHaveBeenCalled();
    expect(error).toMatchObject({
      retryable: false,
      commandStarted: false,
      cancelled: true,
    });
  });

  it("请求已发出但回调未返回时取消，保守标记 commandStarted", async () => {
    let callback: ExecCallback | undefined;
    const { client, channel } = connectedClient((cb) => {
      callback = cb;
    });
    const controller = new AbortController();
    const handle = client.startCommand("rm important", {
      timeout: 2000,
      signal: controller.signal,
    });

    controller.abort();
    const error = await handle.result.catch((err: Error) => err);
    expect(error).toMatchObject({
      retryable: false,
      commandStarted: true,
      cancelled: true,
    });

    // 迟到的 exec 回调仍然必须关闭通道，不能让它复活。
    callback?.(null, channel);
    expect(channel.close).toHaveBeenCalled();
    expect(channel.destroy).toHaveBeenCalled();
  });

  it("真实 SSH 会话中预取消不会在远端执行命令", async () => {
    const server = await startSshTestServer();
    const dir = mkdtempSync(join(tmpdir(), "ssh-mcp-preabort-"));
    const client = new SshClient({
      host: "127.0.0.1",
      port: server.port,
      username: TEST_USER,
      password: TEST_PASSWORD,
      timeout: 2000,
      connectTimeout: 3000,
      keepaliveInterval: 0,
      strictHostKeyChecking: "no",
      knownHostsPath: join(dir, "known_hosts"),
    });

    try {
      await client.connect();
      const controller = new AbortController();
      controller.abort();

      const error = await client.execCommand("echo leaked", 2000, controller.signal)
        .catch((err: Error) => err);
      expect(error).toMatchObject({
        retryable: false,
        commandStarted: false,
        cancelled: true,
      });

      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(server.stats.execs).toHaveLength(0);

      // 取消不应破坏随后的正常执行。
      const result = await client.execCommand("echo hi", 2000);
      expect(result.stdout).toContain("ok:echo hi");
      expect(server.stats.execs).toEqual(["echo hi"]);
    } finally {
      await client.close();
      await server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
