import { Client, type ConnectConfig } from "ssh2";
import { readFileSync } from "fs";
import type { ExecResult } from "../types.js";
import {
  CHARACTER_LIMIT,
  DEFAULT_KEEPALIVE_INTERVAL,
  DEFAULT_KEEPALIVE_COUNT_MAX,
} from "../constants.js";
import { expandHomePath } from "../utils/path.js";

// SSH 客户端配置
export interface SshClientConfig {
  host: string;
  port: number;
  username: string;
  password?: string;
  privateKey?: string | Buffer;
  privateKeyPath?: string;
  passphrase?: string;
  timeout?: number; // 命令执行超时时间（毫秒），默认 30 秒
  connectTimeout?: number; // 连接超时时间（毫秒），默认 10 秒
  keepaliveInterval?: number; // keepalive 探测间隔（毫秒），0 表示禁用
  keepaliveCountMax?: number; // 最大无响应次数
}

// 默认超时时间
const DEFAULT_EXEC_TIMEOUT = 30000; // 30 秒
const DEFAULT_CONNECT_TIMEOUT = 10000; // 10 秒

/**
 * SSH 客户端封装
 * 提供连接、执行命令、关闭等功能
 */
export class SshClient {
  private client: Client;
  private config: SshClientConfig;
  private connected: boolean = false;
  // 断连回调列表
  private disconnectCallbacks: Array<() => void> = [];
  // 标记是否曾成功连接过
  private hasConnectedBefore: boolean = false;

  constructor(config: SshClientConfig) {
    this.config = config;
    this.client = new Client();
  }

  /**
   * 建立 SSH 连接
   * @throws 连接失败时抛出错误
   */
  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const connectTimeout = this.config.connectTimeout ?? DEFAULT_CONNECT_TIMEOUT;

      // 设置连接超时定时器
      const timeoutId = setTimeout(() => {
        // 防止 end() 触发未捕获的 error 事件
        this.client.on("error", () => {});
        this.client.end();
        reject(new Error(`Connection timeout after ${connectTimeout}ms`));
      }, connectTimeout);

      // 准备连接配置
      const connectConfig: ConnectConfig = {
        host: this.config.host,
        port: this.config.port,
        username: this.config.username,
        readyTimeout: connectTimeout,
      };

      // 设置 keepalive，防止空闲连接被中间设备断开
      const keepaliveInterval = this.config.keepaliveInterval ?? DEFAULT_KEEPALIVE_INTERVAL;
      connectConfig.keepaliveInterval = keepaliveInterval;
      connectConfig.keepaliveCountMax = this.config.keepaliveCountMax ?? DEFAULT_KEEPALIVE_COUNT_MAX;

      // 设置认证方式
      if (this.config.password) {
        connectConfig.password = this.config.password;
      }

      if (this.config.privateKey) {
        connectConfig.privateKey = this.config.privateKey;
        if (this.config.passphrase) {
          connectConfig.passphrase = this.config.passphrase;
        }
      } else if (this.config.privateKeyPath) {
        try {
          // Node.js 不会自动展开 `~`，这里兼容 README 和 Cursor 配置中的常见写法。
          const privateKeyPath = expandHomePath(this.config.privateKeyPath);
          connectConfig.privateKey = readFileSync(privateKeyPath);
          if (this.config.passphrase) {
            connectConfig.passphrase = this.config.passphrase;
          }
        } catch (err) {
          clearTimeout(timeoutId);
          reject(new Error(`Failed to read private key: ${(err as Error).message}`));
          return;
        }
      }

      // 监听连接就绪事件
      this.client.once("ready", () => {
        clearTimeout(timeoutId);
        this.connected = true;
        this.hasConnectedBefore = true;
        resolve();
      });

      // 监听错误事件
      this.client.once("error", (err) => {
        clearTimeout(timeoutId);
        this.connected = false;
        reject(new Error(`SSH connection error: ${err.message}`));
      });

      // 监听关闭事件，触发断连回调
      this.client.on("close", () => {
        const wasConnected = this.connected;
        this.connected = false;
        if (wasConnected) {
          for (const cb of this.disconnectCallbacks) {
            try { cb(); } catch { /* 忽略回调中的错误 */ }
          }
        }
      });

      // 发起连接
      this.client.connect(connectConfig);
    });
  }

  /**
   * 执行远程命令
   * @param command 要执行的命令
   * @returns 执行结果（stdout、stderr、exitCode、truncated）
   * @throws 未连接或执行失败时抛出错误
   */
  async execCommand(command: string): Promise<ExecResult> {
    if (!this.connected) {
      throw new Error("Not connected");
    }

    const execTimeout = this.config.timeout ?? DEFAULT_EXEC_TIMEOUT;

    return new Promise((resolve, reject) => {
      let stdout = "";
      let stderr = "";
      let exitCode: number | null = null;
      let truncated = false;
      let timedOut = false;

      // 设置执行超时定时器
      const timeoutId = setTimeout(() => {
        timedOut = true;
        // 尝试关闭通道
        reject(new Error(`Command execution timeout after ${execTimeout}ms`));
      }, execTimeout);

      this.client.exec(command, (err, channel) => {
        if (err) {
          clearTimeout(timeoutId);
          reject(new Error(`Failed to execute command: ${err.message}`));
          return;
        }

        // 收集 stdout
        channel.on("data", (data: Buffer) => {
          if (timedOut) return;

          const chunk = data.toString();
          if (stdout.length + chunk.length > CHARACTER_LIMIT) {
            // 截断输出
            stdout += chunk.slice(0, CHARACTER_LIMIT - stdout.length);
            truncated = true;
          } else {
            stdout += chunk;
          }
        });

        // 收集 stderr
        channel.stderr.on("data", (data: Buffer) => {
          if (timedOut) return;

          const chunk = data.toString();
          if (stderr.length + chunk.length > CHARACTER_LIMIT) {
            // 截断输出
            stderr += chunk.slice(0, CHARACTER_LIMIT - stderr.length);
            truncated = true;
          } else {
            stderr += chunk;
          }
        });

        // 监听退出事件
        channel.on("exit", (code: number | null) => {
          exitCode = code;
        });

        // 监听关闭事件
        channel.on("close", () => {
          if (timedOut) return;

          clearTimeout(timeoutId);
          resolve({
            stdout,
            stderr,
            exitCode,
            truncated,
          });
        });

        // 监听错误事件
        channel.on("error", (channelErr: Error) => {
          if (timedOut) return;

          clearTimeout(timeoutId);
          reject(new Error(`Channel error: ${channelErr.message}`));
        });
      });
    });
  }

  /**
   * 获取将要传给 ssh2 的连接配置（用于测试和调试）
   * 不包含敏感信息（密码/私钥）
   */
  getConnectConfig(): Record<string, unknown> {
    const keepaliveInterval = this.config.keepaliveInterval ?? DEFAULT_KEEPALIVE_INTERVAL;
    return {
      host: this.config.host,
      port: this.config.port,
      username: this.config.username,
      keepaliveInterval,
      keepaliveCountMax: this.config.keepaliveCountMax ?? DEFAULT_KEEPALIVE_COUNT_MAX,
      readyTimeout: this.config.connectTimeout ?? DEFAULT_CONNECT_TIMEOUT,
    };
  }

  /**
   * 获取存储的连接配置（用于重连决策）
   */
  getConfig(): SshClientConfig {
    return { ...this.config };
  }

  /**
   * 检查连接是否存活
   * 基于内部状态标志判断，不发送网络探测
   */
  isAlive(): boolean {
    return this.connected;
  }

  /**
   * 注册断连回调，在连接意外断开时触发
   */
  onDisconnect(callback: () => void): void {
    this.disconnectCallbacks.push(callback);
  }

  /**
   * 重新连接：关闭旧连接，创建新的 ssh2 Client，使用存储的配置重连
   */
  async reconnect(): Promise<void> {
    // 强制关闭旧连接（忽略错误）
    try {
      this.client.on("error", () => {});
      this.client.end();
    } catch {
      // 忽略关闭错误
    }
    this.connected = false;

    // 创建全新的 ssh2 Client 实例
    this.client = new Client();

    // 使用存储的配置重新连接
    await this.connect();
  }

  /**
   * 检查是否已连接
   */
  isConnected(): boolean {
    return this.connected;
  }

  /**
   * 获取底层 SSH 客户端实例
   * 用于高级操作或测试
   */
  getClient(): Client {
    return this.client;
  }

  /**
   * 关闭 SSH 连接
   */
  async close(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.connected) {
        resolve();
        return;
      }

      this.client.once("close", () => {
        this.connected = false;
        resolve();
      });

      this.client.end();
    });
  }
}
