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

  // 如果提供了 host 和 username，则构建服务器配置
  if (host && username) {
    config.server = {
      host,
      port: parseInt(process.env.SSH_PORT || "22", 10),
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
    config.timeout = parseInt(process.env.SSH_TIMEOUT, 10);
  }

  if (process.env.SSH_CONNECT_TIMEOUT) {
    config.connectTimeout = parseInt(process.env.SSH_CONNECT_TIMEOUT, 10);
  }

  if (process.env.SSH_KEEPALIVE_INTERVAL) {
    config.keepaliveInterval = parseInt(process.env.SSH_KEEPALIVE_INTERVAL, 10);
  }

  if (process.env.SSH_KEEPALIVE_COUNT) {
    config.keepaliveCountMax = parseInt(process.env.SSH_KEEPALIVE_COUNT, 10);
  }

  if (process.env.SSH_MAX_RECONNECT_ATTEMPTS) {
    config.maxReconnectAttempts = parseInt(process.env.SSH_MAX_RECONNECT_ATTEMPTS, 10);
  }

  if (process.env.SSH_RECONNECT_BASE_DELAY) {
    config.reconnectBaseDelay = parseInt(process.env.SSH_RECONNECT_BASE_DELAY, 10);
  }

  if (process.env.SSH_RECONNECT_MAX_DELAY) {
    config.reconnectMaxDelay = parseInt(process.env.SSH_RECONNECT_MAX_DELAY, 10);
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
    const sftpTimeout = parseInt(process.env.SSH_SFTP_TIMEOUT, 10);
    if (!Number.isFinite(sftpTimeout) || sftpTimeout < 1000 || sftpTimeout > 300000) {
      throw new Error("SSH_SFTP_TIMEOUT must be an integer from 1000 to 300000");
    }
    config.sftpTimeout = sftpTimeout;
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
