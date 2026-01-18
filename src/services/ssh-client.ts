import { Client, type ConnectConfig } from "ssh2";
import { readFileSync } from "fs";
import type { ExecResult } from "../types.js";
import { CHARACTER_LIMIT } from "../constants.js";

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
          connectConfig.privateKey = readFileSync(this.config.privateKeyPath);
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
        resolve();
      });

      // 监听错误事件
      this.client.once("error", (err) => {
        clearTimeout(timeoutId);
        this.connected = false;
        reject(new Error(`SSH connection error: ${err.message}`));
      });

      // 监听关闭事件
      this.client.once("close", () => {
        this.connected = false;
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
