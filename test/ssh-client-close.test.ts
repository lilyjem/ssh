import net from "net";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import { SshClient } from "../src/services/ssh-client.js";
import { SshToolHandlers } from "../src/tools/ssh-tools.js";
import {
  startGatedProxy,
  startSshTestServer,
  TEST_PASSWORD,
  TEST_USER,
  waitFor,
} from "./helpers/ssh-test-server.js";

interface DelayedProxy {
  port: number;
  accepted: () => number;
  release: () => void;
  close: () => Promise<void>;
}

/**
 * 第一条连接立即转发，后续连接先挂起，直到测试显式 release()。
 * 用于把 reconnect 的握手卡在中间，从而稳定复现 disconnect/reconnect 竞态。
 */
async function startDelayedSecondHopProxy(targetPort: number): Promise<DelayedProxy> {
  const sockets = new Set<net.Socket>();
  const upstreams = new Set<net.Socket>();
  const held: Array<() => void> = [];
  let accepted = 0;
  let closing = false;

  const proxy = net.createServer((socket) => {
    const index = ++accepted;
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    if (closing) {
      socket.destroy();
      return;
    }

    const connectUpstream = () => {
      if (closing || socket.destroyed) {
        socket.destroy();
        return;
      }
      const upstream = net.connect(targetPort, "127.0.0.1");
      upstreams.add(upstream);
      upstream.on("close", () => upstreams.delete(upstream));
      upstream.on("error", () => socket.destroy());
      socket.on("close", () => upstream.destroy());
      upstream.on("close", () => socket.destroy());
      socket.pipe(upstream);
      upstream.pipe(socket);
    };

    if (index === 1) {
      connectUpstream();
      return;
    }
    held.push(connectUpstream);
  });

  await new Promise<void>((resolve, reject) => {
    proxy.once("error", reject);
    proxy.listen(0, "127.0.0.1", () => resolve());
  });
  const address = proxy.address();
  if (!address || typeof address === "string") throw new Error("proxy has no TCP port");

  return {
    port: address.port,
    accepted: () => accepted,
    release: () => {
      for (const connect of held.splice(0)) connect();
    },
    close: () => new Promise<void>((resolve) => {
      closing = true;
      held.length = 0;
      for (const socket of sockets) socket.destroy();
      for (const upstream of upstreams) upstream.destroy();
      proxy.close(() => resolve());
      setTimeout(resolve, 500);
    }),
  };
}

function sshConfig(port: number, knownHostsPath: string) {
  return {
    host: "127.0.0.1",
    port,
    username: TEST_USER,
    password: TEST_PASSWORD,
    timeout: 2000,
    connectTimeout: 3000,
    keepaliveInterval: 0,
    strictHostKeyChecking: "no" as const,
    knownHostsPath,
  };
}

describe("SshClient 显式关闭", () => {
  const closers: Array<() => Promise<void>> = [];
  const dirs: string[] = [];

  afterEach(async () => {
    for (const close of closers) await close();
    closers.length = 0;
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    dirs.length = 0;
  });

  function tempDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    dirs.push(dir);
    return dir;
  }

  it("close 同步生效、幂等且有界，之后拒绝 connect/reconnect/exec", async () => {
    const client = new SshClient({
      host: "127.0.0.1",
      port: 1,
      username: TEST_USER,
      password: TEST_PASSWORD,
      privateKey: "not-a-real-key",
      passphrase: "secret-passphrase",
    });

    const started = Date.now();
    const first = client.close();
    expect(client.isClosed()).toBe(true);
    expect(client.isAlive()).toBe(false);
    expect(client.close()).toBe(first);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const bounded = new Promise((resolve) => {
      timeout = setTimeout(() => resolve("timeout"), 2000);
    });
    await expect(Promise.race([first, bounded])).resolves.not.toBe("timeout");
    if (timeout) clearTimeout(timeout);
    expect(Date.now() - started).toBeLessThan(2000);

    await expect(client.connect()).rejects.toMatchObject({
      retryable: false,
      cancelled: true,
    });
    await expect(client.reconnect()).rejects.toMatchObject({
      retryable: false,
      cancelled: true,
    });
    await expect(client.execCommand("echo hi")).rejects.toMatchObject({
      retryable: false,
      cancelled: true,
    });
    expect(() => client.startCommand("echo hi")).toThrow(/closed/i);

    const config = client.getConfig();
    expect(config.host).toBe("127.0.0.1");
    expect(config.port).toBe(1);
    expect((config as Record<string, unknown>).password).toBeUndefined();
    expect((config as Record<string, unknown>).privateKey).toBeUndefined();
    expect((config as Record<string, unknown>).passphrase).toBeUndefined();
  });

  it("握手期间 close 会销毁当前连接，迟到的 ready 不能恢复连接", async () => {
    const server = await startSshTestServer();
    const proxy = await startGatedProxy(server.port);
    closers.push(() => proxy.close(), () => server.close());
    const dir = tempDir("ssh-mcp-close-handshake-");
    const client = new SshClient(sshConfig(proxy.port, join(dir, "known_hosts")));

    const connecting = client.connect().then(
      () => "up" as const,
      (error: Error) => error
    );
    await waitFor(() => proxy.accepted >= 1);

    await client.close();
    expect(client.isClosed()).toBe(true);
    expect(client.isAlive()).toBe(false);

    const outcome = await connecting;
    expect(outcome).toBeInstanceOf(Error);
    expect(outcome).toMatchObject({ retryable: false, cancelled: true });

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(client.isAlive()).toBe(false);
    expect(proxy.accepted).toBe(1);
    await expect(client.reconnect()).rejects.toMatchObject({ cancelled: true });
  });

  it("普通传输中断不设置 closed，仍可重连", async () => {
    const server = await startSshTestServer();
    closers.push(() => server.close());
    const dir = tempDir("ssh-mcp-transport-loss-");
    const client = new SshClient(sshConfig(server.port, join(dir, "known_hosts")));

    try {
      await client.connect();
      server.dropClients();
      await waitFor(() => !client.isAlive());
      expect(client.isClosed()).toBe(false);

      await client.reconnect();
      expect(client.isAlive()).toBe(true);
      const result = await client.execCommand("echo hi", 2000);
      expect(result.stdout).toContain("ok:echo hi");
    } finally {
      await client.close();
    }
  });

  it("重连握手期间 disconnect 不会留下已认证但未登记连接", async () => {
    const server = await startSshTestServer();
    const proxy = await startDelayedSecondHopProxy(server.port);
    closers.push(() => proxy.close(), () => server.close());
    const dir = tempDir("ssh-mcp-reconnect-close-");
    const handlers = new SshToolHandlers({
      maxReconnectAttempts: 1,
      reconnectBaseDelay: 10,
      reconnectMaxDelay: 20,
      strictHostKeyChecking: "no",
      knownHostsPath: join(dir, "known_hosts"),
    });

    const connected = await handlers.connect({
      host: "127.0.0.1",
      port: proxy.port,
      username: TEST_USER,
      password: TEST_PASSWORD,
      timeout: 2000,
      connect_timeout: 3000,
      keepalive_interval: 0,
    });
    const sessionId = connected.session_id;
    const state = handlers as unknown as {
      clients: Map<string, SshClient>;
      registry: { size: number };
    };
    const client = state.clients.get(sessionId);
    if (!client) throw new Error("client missing after connect");
    const attemptsBefore = server.stats.passwordAttempts;

    server.dropClients();
    await waitFor(() => !client.isAlive(), 3000);

    const reconnect = client.reconnect().then(
      () => "reconnected" as const,
      (error: Error) => `reconnect-error:${error.message}`
    );
    await waitFor(() => proxy.accepted() >= 2, 3000);

    const disconnected = await handlers.disconnect({ session_id: sessionId });
    expect(disconnected.success).toBe(true);
    expect(await reconnect).toContain("reconnect-error");

    expect(client.isClosed()).toBe(true);
    expect(client.isAlive()).toBe(false);
    expect(state.registry.size).toBe(0);
    expect(state.clients.size).toBe(0);

    // 被挂起的第二次握手在 disconnect 之后才放行。若竞态存在，远端会多一次认证。
    proxy.release();
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(server.stats.passwordAttempts).toBe(attemptsBefore);

    const leaked = await client.execCommand("echo leaked-after-disconnect", 1000)
      .catch((error: Error) => error);
    expect(leaked).toMatchObject({ retryable: false, cancelled: true });
    expect(server.stats.execs.some((command) => command.includes("leaked-after-disconnect"))).toBe(false);
  });
});
