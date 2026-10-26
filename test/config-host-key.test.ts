import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfigFromEnv } from "../src/config.js";

const KEYS = [
  "SSH_STRICT_HOST_KEY_CHECKING",
  "SSH_KNOWN_HOSTS",
  "SSH_HOST_FINGERPRINT",
] as const;

const previous = new Map<string, string | undefined>();

function restoreEnv(): void {
  for (const key of KEYS) {
    const value = previous.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

describe("主机密钥环境变量", () => {
  afterEach(() => {
    restoreEnv();
  });

  it("读取策略、known_hosts 路径和固定指纹", () => {
    for (const key of KEYS) previous.set(key, process.env[key]);
    process.env.SSH_STRICT_HOST_KEY_CHECKING = "yes";
    process.env.SSH_KNOWN_HOSTS = "/tmp/ssh-mcp-known-hosts";
    process.env.SSH_HOST_FINGERPRINT = "SHA256:abc";

    const config = loadConfigFromEnv();
    expect(config.strictHostKeyChecking).toBe("yes");
    expect(config.knownHostsPath).toBe("/tmp/ssh-mcp-known-hosts");
    expect(config.hostFingerprint).toBe("SHA256:abc");
  });

  it("无效策略直接失败，而不是静默忽略", () => {
    for (const key of KEYS) previous.set(key, process.env[key]);
    process.env.SSH_STRICT_HOST_KEY_CHECKING = "maybe";
    expect(() => loadConfigFromEnv()).toThrow(/SSH_STRICT_HOST_KEY_CHECKING/);
  });
});

describe("SSH_PRIVATE_KEY 解析", () => {
  const ENV_KEYS = ["SSH_HOST", "SSH_USERNAME", "SSH_PRIVATE_KEY"] as const;
  const saved = new Map<string, string | undefined>();
  const pem = "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----\n";

  afterEach(() => {
    for (const key of ENV_KEYS) {
      const value = saved.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  function load(privateKey: string): string | undefined {
    for (const key of ENV_KEYS) saved.set(key, process.env[key]);
    process.env.SSH_HOST = "example.com";
    process.env.SSH_USERNAME = "deploy";
    process.env.SSH_PRIVATE_KEY = privateKey;
    return loadConfigFromEnv().server?.privateKey;
  }

  it("接受原始 PEM 和 Base64 编码的 PEM", () => {
    expect(load(pem)).toBe(pem);
    expect(load(Buffer.from(pem).toString("base64"))).toBe(pem);
  });

  it("既不是 PEM 也不是 Base64 时直接失败", () => {
    expect(() => load("not-a-key")).toThrow(/SSH_PRIVATE_KEY/);
  });
});

describe("数值环境变量解析", () => {
  const NUMERIC_KEYS = [
    "SSH_HOST",
    "SSH_USERNAME",
    "SSH_PORT",
    "SSH_TIMEOUT",
    "SSH_CONNECT_TIMEOUT",
    "SSH_KEEPALIVE_INTERVAL",
    "SSH_KEEPALIVE_COUNT",
    "SSH_MAX_RECONNECT_ATTEMPTS",
    "SSH_RECONNECT_BASE_DELAY",
    "SSH_RECONNECT_MAX_DELAY",
    "SSH_SFTP_TIMEOUT",
  ] as const;
  const saved = new Map<string, string | undefined>();

  function load(): ReturnType<typeof loadConfigFromEnv> {
    return loadConfigFromEnv();
  }

  beforeEach(() => {
    for (const key of NUMERIC_KEYS) {
      saved.set(key, process.env[key]);
      delete process.env[key];
    }
    process.env.SSH_HOST = "example.com";
    process.env.SSH_USERNAME = "deploy";
  });

  afterEach(() => {
    for (const key of NUMERIC_KEYS) {
      const value = saved.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("读取有效整数和 0 值 keepalive", () => {
    process.env.SSH_PORT = "2222";
    process.env.SSH_TIMEOUT = "5000";
    process.env.SSH_CONNECT_TIMEOUT = "4000";
    process.env.SSH_KEEPALIVE_INTERVAL = "0";
    process.env.SSH_KEEPALIVE_COUNT = "5";
    process.env.SSH_MAX_RECONNECT_ATTEMPTS = "4";
    process.env.SSH_RECONNECT_BASE_DELAY = "20";
    process.env.SSH_RECONNECT_MAX_DELAY = "200";
    process.env.SSH_SFTP_TIMEOUT = "6000";

    const config = load();
    expect(config.server?.port).toBe(2222);
    expect(config.timeout).toBe(5000);
    expect(config.connectTimeout).toBe(4000);
    expect(config.keepaliveInterval).toBe(0);
    expect(config.keepaliveCountMax).toBe(5);
    expect(config.maxReconnectAttempts).toBe(4);
    expect(config.reconnectBaseDelay).toBe(20);
    expect(config.reconnectMaxDelay).toBe(200);
    expect(config.sftpTimeout).toBe(6000);
  });

  it.each([
    ["SSH_PORT", "22abc"],
    ["SSH_PORT", "0"],
    ["SSH_PORT", "65536"],
    ["SSH_PORT", "22.5"],
    ["SSH_TIMEOUT", "999"],
    ["SSH_TIMEOUT", "300001"],
    ["SSH_TIMEOUT", "5000ms"],
    ["SSH_CONNECT_TIMEOUT", "999"],
    ["SSH_CONNECT_TIMEOUT", "60001"],
    ["SSH_KEEPALIVE_INTERVAL", "-1"],
    ["SSH_KEEPALIVE_INTERVAL", "1.5"],
    ["SSH_KEEPALIVE_COUNT", "0"],
    ["SSH_KEEPALIVE_COUNT", "2.5"],
    ["SSH_MAX_RECONNECT_ATTEMPTS", "0"],
    ["SSH_MAX_RECONNECT_ATTEMPTS", "1.5"],
    ["SSH_RECONNECT_BASE_DELAY", "0"],
    ["SSH_RECONNECT_BASE_DELAY", "12abc"],
    ["SSH_RECONNECT_MAX_DELAY", "-5"],
    ["SSH_RECONNECT_MAX_DELAY", "NaN"],
    ["SSH_SFTP_TIMEOUT", "999"],
    ["SSH_SFTP_TIMEOUT", "10s"],
  ])("%s=%s 明确拒绝而不是截断", (key, value) => {
    process.env[key] = value;
    expect(() => load()).toThrow(new RegExp(key));
  });

  it("解析整个字符串而不是 parseInt 截断", () => {
    process.env.SSH_TIMEOUT = "5000abc";
    expect(() => load()).toThrow(/SSH_TIMEOUT/);
  });
});
