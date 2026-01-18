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

    // 私钥认证（Base64 编码的私钥内容）
    if (process.env.SSH_PRIVATE_KEY) {
      try {
        config.server.privateKey = Buffer.from(
          process.env.SSH_PRIVATE_KEY,
          "base64"
        ).toString("utf-8");
      } catch {
        // 如果不是 Base64，直接使用原始值
        config.server.privateKey = process.env.SSH_PRIVATE_KEY;
      }
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
