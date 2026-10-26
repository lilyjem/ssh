/**
 * 服务器配置模块
 * 从环境变量读取预配置的服务器信息
 */

// 服务器配置接口
export interface ServerConfig {
  host: string;
  port: number;
  username: string;
  password?: string;
  privateKey?: string;
  privateKeyPath?: string;
  passphrase?: string;
}

// 全局配置接口
export interface GlobalConfig {
  server?: ServerConfig;
  timeout?: number;
  connectTimeout?: number;
  keepaliveInterval?: number;
  keepaliveCountMax?: number;
  maxReconnectAttempts?: number;
  reconnectBaseDelay?: number;
  reconnectMaxDelay?: number;
  strictHostKeyChecking?: "yes" | "accept-new" | "no";
  knownHostsPath?: string;
  hostFingerprint?: string;
  sftpTimeout?: number;
}

/**
 * 解析完整的环境变量数字字符串。
 * parseInt("10ms") 会静默得到 10，这里要求整个字符串都是数字，并且落在合理范围内。
 */
function parseIntegerEnv(name: string, value: string, min: number, max: number): number {
  const text = value.trim();
  if (!/^[+-]?\d+$/.test(text)) {
    throw new Error(`${name} must be an integer from ${min} to ${max}, received: ${value}`);
  }
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}, received: ${value}`);
  }
  return parsed;
}

// 环境变量允许的数值范围，与工具参数和 README 中的文档保持一致。
const PORT_RANGE = [1, 65535] as const;
const TIMEOUT_RANGE = [1000, 300000] as const;
const CONNECT_TIMEOUT_RANGE = [1000, 60000] as const;
const KEEPALIVE_INTERVAL_RANGE = [0, 3600000] as const;
const KEEPALIVE_COUNT_RANGE = [1, 100] as const;
const RECONNECT_ATTEMPTS_RANGE = [1, 1000] as const;
const RECONNECT_DELAY_RANGE = [1, 600000] as const;
const SFTP_TIMEOUT_RANGE = [1000, 300000] as const;

/**
 * 从环境变量加载服务器配置
 * 支持的环境变量：
 * - SSH_HOST: 服务器地址（必填）
 * - SSH_PORT: SSH 端口（默认 22）
 * - SSH_USERNAME: 用户名（必填）
 * - SSH_PASSWORD: 密码
 * - SSH_PRIVATE_KEY: 私钥内容（Base64 编码）
 * - SSH_PRIVATE_KEY_PATH: 私钥文件路径
 * - SSH_PASSPHRASE: 私钥密码
 * - SSH_TIMEOUT: 命令执行超时（毫秒）
 * - SSH_CONNECT_TIMEOUT: 连接超时（毫秒）
 * - SSH_STRICT_HOST_KEY_CHECKING: yes | accept-new | no，默认 accept-new
 * - SSH_KNOWN_HOSTS: known_hosts 文件路径，默认 ~/.ssh/known_hosts
 * - SSH_HOST_FINGERPRINT: 固定的 SHA256 主机指纹
 * - SSH_SFTP_TIMEOUT: SFTP 操作超时（毫秒），默认 30000
 */
export function loadConfigFromEnv(): GlobalConfig {
  const config: GlobalConfig = {};

  const host = process.env.SSH_HOST;
  const username = process.env.SSH_USERNAME;
  const port = process.env.SSH_PORT
    ? parseIntegerEnv("SSH_PORT", process.env.SSH_PORT, ...PORT_RANGE)
    : 22;

  // 如果提供了 host 和 username，则构建服务器配置
  if (host && username) {
    config.server = {
      host,
      port,
      username,
    };

    // 密码认证
    if (process.env.SSH_PASSWORD) {
      config.server.password = process.env.SSH_PASSWORD;
    }

    // 私钥认证：既接受原始 PEM，也接受 Base64 编码后的 PEM。
    if (process.env.SSH_PRIVATE_KEY) {
      const value = process.env.SSH_PRIVATE_KEY;
      const decoded = value.includes("-----BEGIN")
        ? value
        : Buffer.from(value, "base64").toString("utf-8");
      if (!decoded.includes("-----BEGIN")) {
        throw new Error("SSH_PRIVATE_KEY must be a PEM private key or its Base64 encoding");
      }
      config.server.privateKey = decoded;
    }

    // 私钥文件路径
    if (process.env.SSH_PRIVATE_KEY_PATH) {
      config.server.privateKeyPath = process.env.SSH_PRIVATE_KEY_PATH;
    }

    // 私钥密码
    if (process.env.SSH_PASSPHRASE) {
      config.server.passphrase = process.env.SSH_PASSPHRASE;
    }
  }

  // 超时配置
  if (process.env.SSH_TIMEOUT) {
    config.timeout = parseIntegerEnv("SSH_TIMEOUT", process.env.SSH_TIMEOUT, ...TIMEOUT_RANGE);
  }

  if (process.env.SSH_CONNECT_TIMEOUT) {
    config.connectTimeout = parseIntegerEnv(
      "SSH_CONNECT_TIMEOUT",
      process.env.SSH_CONNECT_TIMEOUT,
      ...CONNECT_TIMEOUT_RANGE
    );
  }

  if (process.env.SSH_KEEPALIVE_INTERVAL) {
    config.keepaliveInterval = parseIntegerEnv(
      "SSH_KEEPALIVE_INTERVAL",
      process.env.SSH_KEEPALIVE_INTERVAL,
      ...KEEPALIVE_INTERVAL_RANGE
    );
  }

  if (process.env.SSH_KEEPALIVE_COUNT) {
    config.keepaliveCountMax = parseIntegerEnv(
      "SSH_KEEPALIVE_COUNT",
      process.env.SSH_KEEPALIVE_COUNT,
      ...KEEPALIVE_COUNT_RANGE
    );
  }

  if (process.env.SSH_MAX_RECONNECT_ATTEMPTS) {
    config.maxReconnectAttempts = parseIntegerEnv(
      "SSH_MAX_RECONNECT_ATTEMPTS",
      process.env.SSH_MAX_RECONNECT_ATTEMPTS,
      ...RECONNECT_ATTEMPTS_RANGE
    );
  }

  if (process.env.SSH_RECONNECT_BASE_DELAY) {
    config.reconnectBaseDelay = parseIntegerEnv(
      "SSH_RECONNECT_BASE_DELAY",
      process.env.SSH_RECONNECT_BASE_DELAY,
      ...RECONNECT_DELAY_RANGE
    );
  }

  if (process.env.SSH_RECONNECT_MAX_DELAY) {
    config.reconnectMaxDelay = parseIntegerEnv(
      "SSH_RECONNECT_MAX_DELAY",
      process.env.SSH_RECONNECT_MAX_DELAY,
      ...RECONNECT_DELAY_RANGE
    );
  }

  const hostKeyPolicy = process.env.SSH_STRICT_HOST_KEY_CHECKING;
  if (hostKeyPolicy) {
    if (hostKeyPolicy !== "yes" && hostKeyPolicy !== "accept-new" && hostKeyPolicy !== "no") {
      throw new Error(
        `SSH_STRICT_HOST_KEY_CHECKING must be yes, accept-new, or no, received: ${hostKeyPolicy}`
      );
    }
    config.strictHostKeyChecking = hostKeyPolicy;
  }

  if (process.env.SSH_KNOWN_HOSTS) {
    config.knownHostsPath = process.env.SSH_KNOWN_HOSTS;
  }

  if (process.env.SSH_HOST_FINGERPRINT) {
    config.hostFingerprint = process.env.SSH_HOST_FINGERPRINT;
  }

  if (process.env.SSH_SFTP_TIMEOUT) {
    config.sftpTimeout = parseIntegerEnv(
      "SSH_SFTP_TIMEOUT",
      process.env.SSH_SFTP_TIMEOUT,
      ...SFTP_TIMEOUT_RANGE
    );
  }

  return config;
}

/**
 * 验证服务器配置是否完整
 */
export function validateServerConfig(config: ServerConfig): string | null {
  if (!config.host) {
    return "Missing host";
  }
  if (!config.username) {
    return "Missing username";
  }
  if (!config.password && !config.privateKey && !config.privateKeyPath) {
    return "Missing authentication method (password or private key)";
  }
  return null;
}

/**
 * 检查是否配置了预设服务器
 */
export function hasPresetServer(config: GlobalConfig): boolean {
  return !!config.server;
}
