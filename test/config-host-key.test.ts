import { afterEach, describe, expect, it } from "vitest";
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
