import { describe, it, expect } from "vitest";
import { SshToolHandlers } from "../src/tools/ssh-tools.js";

describe("SshToolHandlers 连接错误判断", () => {
  it("isConnectionError 正确识别连接相关错误", () => {
    const handlers = new SshToolHandlers();

    const connectionErrors = [
      "Not connected",
      "SSH connection error: ECONNRESET",
      "Channel error: read ECONNRESET",
      "Connection timeout after 10000ms",
      "SFTP not initialized",
    ];

    const nonConnectionErrors = [
      "command cannot be empty",
      "At least one authentication method is required",
      "command exceeds 1000 characters",
    ];

    for (const msg of connectionErrors) {
      expect(
        handlers.shouldRetryOperation(new Error(msg)),
        `应该重试: ${msg}`
      ).toBe(true);
    }

    for (const msg of nonConnectionErrors) {
      expect(
        handlers.shouldRetryOperation(new Error(msg)),
        `不应重试: ${msg}`
      ).toBe(false);
    }
  });
});

describe("SshToolHandlers SFTP 缓存清理", () => {
  it("invalidateSftpClient 移除指定会话的 SFTP 缓存", () => {
    const handlers = new SshToolHandlers();
    expect(() => handlers.invalidateSftpClient("non-existent")).not.toThrow();
  });
});
