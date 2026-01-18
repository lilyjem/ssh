import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestSshServer, type TestSshServer } from "./ssh-server.fixture";
import { SshClient } from "../src/services/ssh-client";

describe("SshClient", () => {
  let server: TestSshServer;

  // 在所有测试前启动测试 SSH 服务器
  beforeAll(async () => {
    server = await createTestSshServer();
  });

  // 在所有测试后关闭服务器
  afterAll(async () => {
    await server.close();
  });

  describe("connect", () => {
    it("connects with valid credentials", async () => {
      const client = new SshClient({
        host: server.config.host,
        port: server.config.port,
        username: server.config.username,
        password: server.config.password,
      });

      await client.connect();
      expect(client.isConnected()).toBe(true);
      await client.close();
    });

    it("rejects invalid credentials", async () => {
      const client = new SshClient({
        host: server.config.host,
        port: server.config.port,
        username: server.config.username,
        password: "wrongpassword",
      });

      await expect(client.connect()).rejects.toThrow();
    });
  });

  describe("execCommand", () => {
    it("executes a command and returns stdout", async () => {
      const client = new SshClient({
        host: server.config.host,
        port: server.config.port,
        username: server.config.username,
        password: server.config.password,
      });

      await client.connect();

      // 使用跨平台的命令
      const result = await client.execCommand("echo ok");
      
      // Windows 的 echo 会保留换行，Unix 也会
      expect(result.stdout.trim()).toBe("ok");
      expect(result.exitCode).toBe(0);
      expect(result.truncated).toBe(false);

      await client.close();
    });

    it("captures stderr", async () => {
      const client = new SshClient({
        host: server.config.host,
        port: server.config.port,
        username: server.config.username,
        password: server.config.password,
      });

      await client.connect();

      // 执行一个会输出到 stderr 的命令
      // Windows: echo error 1>&2
      // Unix: echo error >&2
      const isWindows = process.platform === "win32";
      const command = isWindows ? "echo error 1>&2" : "echo error >&2";
      const result = await client.execCommand(command);

      expect(result.stderr.trim()).toBe("error");

      await client.close();
    });

    it("returns non-zero exit code for failed commands", async () => {
      const client = new SshClient({
        host: server.config.host,
        port: server.config.port,
        username: server.config.username,
        password: server.config.password,
      });

      await client.connect();

      // 执行一个会失败的命令
      const result = await client.execCommand("exit 42");

      expect(result.exitCode).toBe(42);

      await client.close();
    });

    it("throws when not connected", async () => {
      const client = new SshClient({
        host: server.config.host,
        port: server.config.port,
        username: server.config.username,
        password: server.config.password,
      });

      await expect(client.execCommand("echo test")).rejects.toThrow(
        "Not connected"
      );
    });
  });

  describe("timeout", () => {
    it("times out long-running commands", async () => {
      const client = new SshClient({
        host: server.config.host,
        port: server.config.port,
        username: server.config.username,
        password: server.config.password,
        timeout: 500, // 500ms 超时
      });

      await client.connect();

      // 执行一个会超时的命令
      // Windows: ping -n 10 127.0.0.1 (约 10 秒)
      // Unix: sleep 10
      const isWindows = process.platform === "win32";
      const command = isWindows ? "ping -n 10 127.0.0.1" : "sleep 10";

      await expect(client.execCommand(command)).rejects.toThrow(/timeout/i);

      await client.close();
    }, 10000); // 增加测试超时时间
  });
});
