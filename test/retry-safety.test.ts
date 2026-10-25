import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import { SshClient } from "../src/services/ssh-client.js";
import { SshToolHandlers } from "../src/tools/ssh-tools.js";
import { startSshTestServer, TEST_PASSWORD, TEST_USER, waitFor } from "./helpers/ssh-test-server.js";

describe("安全重试判定", () => {
  const handlers = new SshToolHandlers();

  it("认证失败、主机密钥拒绝、超时和已开始的命令不重试", () => {
    expect(handlers.shouldRetryOperation(Object.assign(
      new Error("SSH connection error: All configured authentication methods failed"),
      { level: "client-authentication" }
    ))).toBe(false);

    expect(handlers.shouldRetryOperation(
      new Error("SSH connection error: Host denied (verification failed): host key changed")
    )).toBe(false);

    expect(handlers.shouldRetryOperation(
      new Error("Command execution timeout after 80ms")
    )).toBe(false);

    expect(handlers.shouldRetryOperation(Object.assign(
      new Error("Channel error: read ECONNRESET"),
      { commandStarted: true, retryable: false }
    ))).toBe(false);
  });

  it("尚未开始的连接错误仍然可以重试", () => {
    expect(handlers.shouldRetryOperation(new Error("Not connected"))).toBe(true);
    expect(handlers.shouldRetryOperation(new Error("SSH connection error: ECONNRESET"))).toBe(true);
  });
});

describe("操作层不重放非幂等动作", () => {
  const dirs: string[] = [];
  const closers: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const close of closers) await close();
    closers.length = 0;
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    dirs.length = 0;
  });

  async function connectedHandlers() {
    const server = await startSshTestServer();
    closers.push(() => server.close());
    const dir = mkdtempSync(join(tmpdir(), "ssh-mcp-retry-"));
    dirs.push(dir);
    const handlers = new SshToolHandlers({
      maxReconnectAttempts: 3,
      reconnectBaseDelay: 10,
      reconnectMaxDelay: 20,
      strictHostKeyChecking: "no",
      knownHostsPath: join(dir, "known_hosts"),
    });
    const result = await handlers.connect({
      host: "127.0.0.1",
      port: server.port,
      username: TEST_USER,
      password: TEST_PASSWORD,
      timeout: 2000,
      connect_timeout: 3000,
      keepalive_interval: 0,
    });
    return { server, handlers, sessionId: result.session_id };
  }

  it("命令通道已打开后失败只执行一次", async () => {
    const { handlers, sessionId } = await connectedHandlers();
    const client = (handlers as unknown as { clients: Map<string, SshClient> }).clients.get(sessionId)!;
    let calls = 0;
    client.execCommand = async () => {
      calls += 1;
      throw Object.assign(new Error("Channel error: read ECONNRESET"), {
        commandStarted: true,
        retryable: false,
      });
    };

    await expect(handlers.exec({ session_id: sessionId, command: "rm important" })).rejects.toThrow(/Channel error/);
    expect(calls).toBe(1);
  });

  it("连接尚未执行命令时仍然重试", async () => {
    const { handlers, sessionId } = await connectedHandlers();
    const client = (handlers as unknown as { clients: Map<string, SshClient> }).clients.get(sessionId)!;
    let calls = 0;
    client.execCommand = async () => {
      calls += 1;
      if (calls === 1) throw new Error("Not connected");
      return { stdout: "ok", stderr: "", exitCode: 0, truncated: false };
    };

    const result = await handlers.exec({ session_id: sessionId, command: "echo ok" });
    expect(result.stdout).toBe("ok");
    expect(calls).toBe(2);
  });

  it("认证失败的重连只尝试一次", async () => {
    const { server, handlers, sessionId } = await connectedHandlers();
    const client = (handlers as unknown as { clients: Map<string, SshClient> }).clients.get(sessionId)!;
    const before = server.stats.passwordAttempts;
    server.stats.rejectAuth = true;
    server.dropClients();
    await waitFor(() => !client.isAlive());

    await expect(handlers.exec({
      session_id: sessionId,
      command: "echo hi",
      timeout: 2000,
    })).rejects.toThrow(/authentication|Authentication|auth/i);
    expect(server.stats.passwordAttempts - before).toBe(1);
  });

  it("删除一旦发出就不因连接错误再次执行", async () => {
    const { handlers, sessionId } = await connectedHandlers();
    let calls = 0;
    const fake = {
      close() {},
      async stat() {
        return { mode: 0o100644, uid: 0, gid: 0, size: 1, atime: 0, mtime: 0 };
      },
      async deleteFile() {
        calls += 1;
        throw new Error("Channel error: read ECONNRESET");
      },
    };
    (handlers as unknown as { sftpClients: Map<string, unknown> }).sftpClients.set(sessionId, fake);

    await expect(handlers.sftpDelete({ session_id: sessionId, path: "/data.txt" })).rejects.toThrow(/Channel error/);
    expect(calls).toBe(1);
  });
});
