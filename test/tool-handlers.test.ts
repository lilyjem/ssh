import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createTestSshServer, type TestSshServer } from "./ssh-server.fixture";
import { SshToolHandlers } from "../src/tools/ssh-tools";

describe("SshToolHandlers", () => {
  let server: TestSshServer;
  let handlers: SshToolHandlers;

  // 在所有测试前启动测试 SSH 服务器
  beforeAll(async () => {
    server = await createTestSshServer();
  });

  // 在所有测试后关闭服务器
  afterAll(async () => {
    await server.close();
  });

  // 每个测试前创建新的 handlers 实例
  beforeEach(() => {
    handlers = new SshToolHandlers();
  });

  describe("ssh_connect", () => {
    it("connects with valid credentials and returns session_id", async () => {
      const result = await handlers.connect({
        host: server.config.host,
        port: server.config.port,
        username: server.config.username,
        password: server.config.password,
      });

      expect(result.session_id).toBeDefined();
      expect(typeof result.session_id).toBe("string");
      expect(result.message).toContain("Connected");

      // 清理
      await handlers.disconnect({ session_id: result.session_id });
    });

    it("rejects connection with invalid credentials", async () => {
      await expect(
        handlers.connect({
          host: server.config.host,
          port: server.config.port,
          username: server.config.username,
          password: "wrongpassword",
        })
      ).rejects.toThrow();
    });

    it("requires at least one auth method", async () => {
      await expect(
        handlers.connect({
          host: server.config.host,
          port: server.config.port,
          username: server.config.username,
        })
      ).rejects.toThrow(/authentication/i);
    });
  });

  describe("ssh_exec", () => {
    it("executes command on connected session", async () => {
      const connectResult = await handlers.connect({
        host: server.config.host,
        port: server.config.port,
        username: server.config.username,
        password: server.config.password,
      });

      const execResult = await handlers.exec({
        session_id: connectResult.session_id,
        command: "echo hello",
      });

      expect(execResult.stdout.trim()).toBe("hello");
      expect(execResult.exit_code).toBe(0);

      // 清理
      await handlers.disconnect({ session_id: connectResult.session_id });
    });

    it("rejects exec for missing session", async () => {
      await expect(
        handlers.exec({
          session_id: "non-existent-session-id",
          command: "ls",
        })
      ).rejects.toThrow(/session/i);
    });

    it("rejects empty command", async () => {
      const connectResult = await handlers.connect({
        host: server.config.host,
        port: server.config.port,
        username: server.config.username,
        password: server.config.password,
      });

      await expect(
        handlers.exec({
          session_id: connectResult.session_id,
          command: "",
        })
      ).rejects.toThrow(/command/i);

      // 清理
      await handlers.disconnect({ session_id: connectResult.session_id });
    });
  });

  describe("ssh_list_sessions", () => {
    it("returns empty list when no sessions", () => {
      const result = handlers.listSessions();
      expect(result.sessions).toEqual([]);
      expect(result.count).toBe(0);
    });

    it("returns list of active sessions", async () => {
      const connectResult = await handlers.connect({
        host: server.config.host,
        port: server.config.port,
        username: server.config.username,
        password: server.config.password,
      });

      const listResult = handlers.listSessions();
      expect(listResult.sessions).toHaveLength(1);
      expect(listResult.count).toBe(1);
      expect(listResult.sessions[0].session_id).toBe(connectResult.session_id);
      expect(listResult.sessions[0].host).toBe(server.config.host);

      // 清理
      await handlers.disconnect({ session_id: connectResult.session_id });
    });
  });

  describe("ssh_disconnect", () => {
    it("disconnects an active session", async () => {
      const connectResult = await handlers.connect({
        host: server.config.host,
        port: server.config.port,
        username: server.config.username,
        password: server.config.password,
      });

      const disconnectResult = await handlers.disconnect({
        session_id: connectResult.session_id,
      });

      expect(disconnectResult.success).toBe(true);
      expect(disconnectResult.message).toContain("Disconnected");

      // 验证会话已被移除
      const listResult = handlers.listSessions();
      expect(listResult.sessions).toHaveLength(0);
    });

    it("returns error for non-existent session", async () => {
      await expect(
        handlers.disconnect({
          session_id: "non-existent-session-id",
        })
      ).rejects.toThrow(/session/i);
    });
  });

  describe("cleanup", () => {
    it("closes all sessions on cleanup", async () => {
      // 创建多个会话
      await handlers.connect({
        host: server.config.host,
        port: server.config.port,
        username: server.config.username,
        password: server.config.password,
      });

      await handlers.connect({
        host: server.config.host,
        port: server.config.port,
        username: server.config.username,
        password: server.config.password,
      });

      expect(handlers.listSessions().count).toBe(2);

      // 清理所有会话
      await handlers.cleanup();

      expect(handlers.listSessions().count).toBe(0);
    });
  });
});
