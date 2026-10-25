import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { Client } from "ssh2";
import { afterEach, describe, expect, it } from "vitest";
import { SshClient } from "../src/services/ssh-client.js";
import {
  startGatedProxy,
  startSshTestServer,
  TEST_PASSWORD,
  TEST_USER,
  waitFor,
} from "./helpers/ssh-test-server.js";

function delayEmit(client: Client, ms: number): void {
  const original = client.emit.bind(client);
  client.emit = ((event: string | symbol, ...args: unknown[]) => {
    if (event === "close" || event === "error") {
      setTimeout(() => original(event, ...args), ms);
      return true;
    }
    return original(event, ...args);
  }) as Client["emit"];
}

describe("并发重连不会拆掉新连接", () => {
  const closers: Array<() => Promise<void>> = [];
  const dirs: string[] = [];

  afterEach(async () => {
    for (const close of closers) await close();
    closers.length = 0;
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    dirs.length = 0;
  });

  it("旧连接的超时回调不会关闭后建立的连接", async () => {
    const server = await startSshTestServer();
    const proxy = await startGatedProxy(server.port);
    closers.push(() => proxy.close(), () => server.close());
    const dir = mkdtempSync(join(tmpdir(), "ssh-mcp-reconnect-"));
    dirs.push(dir);

    const client = new SshClient({
      host: "127.0.0.1",
      port: proxy.port,
      username: TEST_USER,
      password: TEST_PASSWORD,
      connectTimeout: 300,
      timeout: 2000,
      keepaliveInterval: 0,
      strictHostKeyChecking: "no",
      knownHostsPath: join(dir, "known_hosts"),
    });

    const first = client.connect().then(() => "up" as const, (error: Error) => error);
    await waitFor(() => proxy.accepted >= 1);
    delayEmit(client.getClient(), 1000);
    const second = client.reconnect();

    await expect(second).resolves.toBeUndefined();
    expect(client.isAlive()).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(client.isAlive()).toBe(true);
    const result = await client.execCommand("echo hi", 2000);
    expect(result.stdout).toContain("ok:echo hi");

    const firstResult = await first;
    expect(firstResult).toBeInstanceOf(Error);
    expect(client.isAlive()).toBe(true);
  });

  it("同一会话的并发重连共用一次连接", async () => {
    const server = await startSshTestServer();
    closers.push(() => server.close());
    const dir = mkdtempSync(join(tmpdir(), "ssh-mcp-reconnect-"));
    dirs.push(dir);
    const client = new SshClient({
      host: "127.0.0.1",
      port: server.port,
      username: TEST_USER,
      password: TEST_PASSWORD,
      connectTimeout: 3000,
      timeout: 2000,
      keepaliveInterval: 0,
      strictHostKeyChecking: "no",
      knownHostsPath: join(dir, "known_hosts"),
    });
    await client.connect();
    server.dropClients();
    await waitFor(() => !client.isAlive());

    await Promise.all([client.reconnect(), client.reconnect()]);
    expect(client.isAlive()).toBe(true);
    const result = await client.execCommand("echo hi", 2000);
    expect(result.stdout).toContain("ok:echo hi");
    expect(server.stats.passwordAttempts).toBe(2);
  });
});
