import { describe, it, expect, vi } from "vitest";
import { SshClient } from "../src/services/ssh-client.js";

describe("SshClient keepalive 配置", () => {
  it("默认启用 keepalive", () => {
    const client = new SshClient({
      host: "test.example.com",
      port: 22,
      username: "testuser",
      password: "testpass",
    });

    const config = client.getConnectConfig();
    expect(config.keepaliveInterval).toBe(10000);
    expect(config.keepaliveCountMax).toBe(3);
  });

  it("支持自定义 keepalive 参数", () => {
    const client = new SshClient({
      host: "test.example.com",
      port: 22,
      username: "testuser",
      password: "testpass",
      keepaliveInterval: 5000,
      keepaliveCountMax: 5,
    });

    const config = client.getConnectConfig();
    expect(config.keepaliveInterval).toBe(5000);
    expect(config.keepaliveCountMax).toBe(5);
  });

  it("keepaliveInterval 设为 0 时禁用 keepalive", () => {
    const client = new SshClient({
      host: "test.example.com",
      port: 22,
      username: "testuser",
      password: "testpass",
      keepaliveInterval: 0,
    });

    const config = client.getConnectConfig();
    expect(config.keepaliveInterval).toBe(0);
  });
});
