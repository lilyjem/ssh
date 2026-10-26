import { Client, type ConnectConfig } from "ssh2";
import { readFileSync } from "fs";
import type { ExecResult } from "../types.js";
import {
  CHARACTER_LIMIT,
  DEFAULT_KEEPALIVE_INTERVAL,
  DEFAULT_KEEPALIVE_COUNT_MAX,
} from "../constants.js";
import { expandHomePath } from "../utils/path.js";
import { SshOperationError } from "../utils/errors.js";
import {
  decideHostKey,
  DEFAULT_HOST_KEY_POLICY,
  defaultKnownHostsPath,
  formatKnownHostLine,
  readKnownHosts,
  recordKnownHost,
  type HostKeyPolicy,
} from "../utils/host-key.js";

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
  strictHostKeyChecking?: HostKeyPolicy;
  knownHostsPath?: string;
  hostFingerprint?: string;
}

interface AcceptedHostKey {
  fingerprint: string;
  keyType: string;
}

export interface CommandHandle {
  result: Promise<ExecResult>;
  /** 关闭执行通道。已经结束的命令再次调用不会报错。 */
  cancel(): void;
}

interface ExecChannel {
  stderr: { on(event: "data", listener: (data: Buffer) => void): void };
  on(event: "data", listener: (data: Buffer) => void): void;
  on(event: "exit", listener: (code: number | null) => void): void;
  on(event: "close", listener: () => void): void;
  on(event: "error", listener: (err: Error) => void): void;
  close(): void;
  destroy(): void;
  eof?(): void;
  signal?(signalName: string): void;
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
  // 同一时刻只允许一次重连，避免并发重连互相关掉
  private reconnectTask: Promise<void> | null = null;
  // 断连回调只通知一次，直到下一次连接成功
  private disconnectNotified = false;
  private hostKeyInfo: AcceptedHostKey | null = null;

  constructor(config: SshClientConfig) {
    this.config = config;
    this.client = new Client();
  }

  /**
   * 建立 SSH 连接
   * 所有回调都绑定当次创建的 client，超时或旧连接关闭不会动到后来替换上的连接。
   * @throws 连接失败时抛出错误
   */
  async connect(): Promise<void> {
    const client = this.client;
    this.hostKeyInfo = null;
    let rejection: string | null = null;

    return new Promise((resolve, reject) => {
      const connectTimeout = this.config.connectTimeout ?? DEFAULT_CONNECT_TIMEOUT;
      let settled = false;

      const settleReject = (err: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        reject(err);
      };
      const settleResolve = () => {
        if (settled || this.client !== client) return;
        settled = true;
        clearTimeout(timeoutId);
        this.connected = true;
        this.hasConnectedBefore = true;
        this.disconnectNotified = false;
        resolve();
      };

      // 超时只关闭本次 client。重连已经换上新对象时，不能再 end() 新连接。
      const timeoutId = setTimeout(() => {
        if (this.client === client) {
          try { client.end(); } catch { /* 忽略关闭错误 */ }
        }
        settleReject(new SshOperationError(`Connection timeout after ${connectTimeout}ms`, {
          retryable: true,
        }));
      }, connectTimeout);

      const connectConfig: ConnectConfig = {
        host: this.config.host,
        port: this.config.port,
        username: this.config.username,
        readyTimeout: connectTimeout,
      };

      const keepaliveInterval = this.config.keepaliveInterval ?? DEFAULT_KEEPALIVE_INTERVAL;
      connectConfig.keepaliveInterval = keepaliveInterval;
      connectConfig.keepaliveCountMax = this.config.keepaliveCountMax ?? DEFAULT_KEEPALIVE_COUNT_MAX;
      // 不要设置 hostHash，ssh2 设了以后会把原始公钥换成哈希，无法再对照 known_hosts。
      connectConfig.hostVerifier = (key: Buffer) => {
        if (this.client !== client || !Buffer.isBuffer(key)) {
          rejection = "unexpected host key format";
          return false;
        }
        try {
          const policy = this.config.strictHostKeyChecking ?? DEFAULT_HOST_KEY_POLICY;
          const knownHostsPath = this.config.knownHostsPath ?? defaultKnownHostsPath();
          const decision = decideHostKey({
            key,
            host: this.config.host,
            port: this.config.port,
            policy,
            knownHostsContent: policy === "no" ? "" : readKnownHosts(knownHostsPath),
            pinnedFingerprint: this.config.hostFingerprint,
          });
          if (!decision.accept) {
            rejection = decision.reason;
            return false;
          }
          if (decision.record) {
            recordKnownHost(knownHostsPath, formatKnownHostLine(this.config.host, this.config.port, key));
          }
          this.hostKeyInfo = {
            fingerprint: decision.fingerprint,
            keyType: decision.keyType,
          };
          return true;
        } catch (err) {
          rejection = (err as Error).message;
          return false;
        }
      };

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
          const privateKeyPath = expandHomePath(this.config.privateKeyPath);
          connectConfig.privateKey = readFileSync(privateKeyPath);
          if (this.config.passphrase) {
            connectConfig.passphrase = this.config.passphrase;
          }
        } catch (err) {
          settleReject(new SshOperationError(`Failed to read private key: ${(err as Error).message}`, {
            retryable: false,
          }));
          return;
        }
      }

      client.once("ready", () => {
        settleResolve();
      });

      client.on("error", (err: Error & { level?: string; code?: string }) => {
        if (this.client !== client || settled) return;
        const authenticationFailed = err.level === "client-authentication"
          || err.message.includes("All configured authentication methods failed");
        let message = `SSH connection error: ${err.message}`;
        if (rejection) message = `${message}: ${rejection}`;
        settleReject(new SshOperationError(message, {
          retryable: !authenticationFailed && !rejection,
          level: err.level,
        }));
      });

      client.on("close", () => {
        // 旧连接的 close 不能把后续连接标成已断开。
        if (this.client !== client) return;
        const wasConnected = this.connected;
        this.connected = false;
        if (!settled) {
          settleReject(new SshOperationError("SSH connection closed before ready", { retryable: true }));
        }
        if (wasConnected) this.notifyDisconnect();
      });

      client.connect(connectConfig);
    });
  }

  /**
   * 执行远程命令
   * timeout 只作用于本次调用；超时后关闭执行通道。
   * 通道关闭不等于远程进程一定已经结束，已脱离的进程仍可能继续运行。
   */
  async execCommand(command: string, timeout?: number, signal?: AbortSignal): Promise<ExecResult> {
    const execTimeout = timeout ?? this.config.timeout ?? DEFAULT_EXEC_TIMEOUT;
    return this.startCommand(command, { timeout: execTimeout, signal }).result;
  }

  /**
   * 启动命令但不等待结束。不传 timeout 时不主动计时，供后台任务使用。
   */
  startCommand(
    command: string,
    options?: {
      timeout?: number;
      signal?: AbortSignal;
      onStdout?: (chunk: string) => void;
      onStderr?: (chunk: string) => void;
    }
  ): CommandHandle {
    if (!this.connected) {
      throw new SshOperationError("Not connected", { retryable: true });
    }

    const execTimeout = options?.timeout;
    const execClient = this.client;
    let cancelImpl = () => {};
    const result = new Promise<ExecResult>((resolve, reject) => {
      let stdout = "";
      let stderr = "";
      let exitCode: number | null = null;
      let truncated = false;
      let settled = false;
      let channel: ExecChannel | null = null;

      // 先发 EOF 再关闭。只发 CLOSE 时，服务端会一直等结束事件，通道看起来没有关掉。
      const stopChannel = (target: ExecChannel | null) => {
        if (!target) return;
        try { target.signal?.("TERM"); } catch { /* 部分服务端不接受信号 */ }
        try { target.eof?.(); } catch { /* 通道可能已经结束 */ }
        try { target.close(); } catch { /* 通道可能已经关闭 */ }
        try { target.destroy(); } catch { /* 忽略重复销毁 */ }
      };

      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      const failSettled = (error: Error) => {
        if (settled) return;
        settled = true;
        if (timeoutId) clearTimeout(timeoutId);
        reject(error);
      };
      if (execTimeout !== undefined) {
        timeoutId = setTimeout(() => {
          stopChannel(channel);
          failSettled(new SshOperationError(
            `Command execution timeout after ${execTimeout}ms; the execution channel was closed`,
            { retryable: false, timedOut: true, commandStarted: channel !== null }
          ));
        }, execTimeout);
      }
      cancelImpl = () => {
        stopChannel(channel);
        failSettled(new SshOperationError("Command cancelled", {
          retryable: false,
          commandStarted: channel !== null,
        }));
      };
      if (options?.signal?.aborted) cancelImpl();
      else options?.signal?.addEventListener("abort", () => cancelImpl(), { once: true });

      execClient.exec(command, (err, opened) => {
        const execChannel = opened as ExecChannel | undefined;
        if (settled) {
          stopChannel(execChannel ?? null);
          return;
        }
        if (err || !execChannel) {
          settled = true;
          clearTimeout(timeoutId);
          const failure = err ?? new Error("missing channel");
          const coded = failure as Error & { level?: string; code?: string };
          reject(new SshOperationError(`Failed to execute command: ${failure.message}`, {
            retryable: true,
            commandStarted: false,
            level: coded.level,
          }));
          return;
        }

        // 通道已经打开，命令可能已经在远端开始。之后的失败不再重放。
        channel = execChannel;

        const appendOutput = (
          data: Buffer,
          current: string,
          push: (text: string) => void
        ): string => {
          const chunk = data.toString();
          const stored = current.length + chunk.length > CHARACTER_LIMIT
            ? chunk.slice(0, CHARACTER_LIMIT - current.length)
            : chunk;
          if (stored.length < chunk.length) truncated = true;
          if (stored) push(stored);
          return current + stored;
        };

        execChannel.on("data", (data: Buffer) => {
          if (settled) return;
          stdout = appendOutput(data, stdout, (text) => options?.onStdout?.(text));
        });

        execChannel.stderr.on("data", (data: Buffer) => {
          if (settled) return;
          stderr = appendOutput(data, stderr, (text) => options?.onStderr?.(text));
        });

        execChannel.on("exit", (code: number | null) => {
          exitCode = code;
        });

        execChannel.on("close", () => {
          if (settled) return;
          settled = true;
          clearTimeout(timeoutId);
          resolve({ stdout, stderr, exit_code: exitCode, truncated });
        });

        execChannel.on("error", (channelErr: Error & { level?: string; code?: string }) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeoutId);
          stopChannel(execChannel);
          reject(new SshOperationError(`Channel error: ${channelErr.message}`, {
            retryable: false,
            commandStarted: true,
            level: channelErr.level,
          }));
        });
      });
    });

    return {
      result,
      cancel: () => cancelImpl(),
    };
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
      strictHostKeyChecking: this.config.strictHostKeyChecking ?? DEFAULT_HOST_KEY_POLICY,
      knownHostsPath: this.config.knownHostsPath ?? defaultKnownHostsPath(),
    };
  }

  /** 当前连接配置的副本（不含敏感信息）。 */
  getConfig(): SshClientConfig {
    return { ...this.config };
  }

  /** 本次握手接受的主机密钥。连接未完成时为 null。 */
  getHostKey(): AcceptedHostKey | null {
    return this.hostKeyInfo ? { ...this.hostKeyInfo } : null;
  }

  /** 连接是否仍然可用。 */
  isAlive(): boolean {
    return this.connected;
  }

  /** 注册断连回调；同一段断开只通知一次。 */
  onDisconnect(callback: () => void): void {
    this.disconnectCallbacks.push(callback);
  }

  /**
   * 重新连接。并发调用共用同一次握手，不会各自新建一条连接。
   */
  async reconnect(): Promise<void> {
    if (this.reconnectTask) return this.reconnectTask;
    const task = this.reconnectInner().finally(() => {
      if (this.reconnectTask === task) this.reconnectTask = null;
    });
    this.reconnectTask = task;
    return task;
  }

  private async reconnectInner(): Promise<void> {
    const previous = this.client;
    const wasConnected = this.connected;
    this.connected = false;
    if (wasConnected) this.notifyDisconnect();
    try {
      previous.on("error", () => {});
      previous.end();
    } catch {
      // 握手未完成时，end() 可能在发送 disconnect 前抛出，这时 socket 还没关。
    }
    try {
      previous.destroy();
    } catch {
      // 忽略销毁错误
    }
    this.client = new Client();
    this.hostKeyInfo = null;
    await this.connect();
  }

  private notifyDisconnect(): void {
    if (this.disconnectNotified) return;
    this.disconnectNotified = true;
    for (const cb of this.disconnectCallbacks) {
      try { cb(); } catch { /* 忽略回调中的错误 */ }
    }
  }

  /** 底层 ssh2 Client，用于打开 SFTP 或执行通道。 */
  getClient(): Client {
    return this.client;
  }

  /** 断开连接并释放资源。 */
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
