import { Client, type ConnectConfig } from "ssh2";
import { readFileSync } from "fs";
import { StringDecoder } from "string_decoder";
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

/** 可供诊断和测试查看的配置；不包含密码、私钥或口令。 */
export type SshPublicConfig = Omit<SshClientConfig, "password" | "privateKey" | "passphrase">;

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
  stderr: {
    on(event: "data", listener: (data: Buffer) => void): void;
    on(event: "end", listener: () => void): void;
  };
  on(event: "data", listener: (data: Buffer) => void): void;
  on(event: "exit", listener: (code: number | null, signal?: string) => void): void;
  on(event: "close", listener: () => void): void;
  on(event: "error", listener: (err: Error) => void): void;
  on(event: "end", listener: () => void): void;
  close(): void;
  destroy(): void;
  eof?(): void;
  signal?(signalName: string): void;
}

// 默认超时时间
const DEFAULT_EXEC_TIMEOUT = 30000; // 30 秒
const DEFAULT_CONNECT_TIMEOUT = 10000; // 10 秒
// close() 的兜底等待时间：即使底层不发出 close 事件也必须在有限时间内返回
const CLOSE_SETTLE_TIMEOUT = 500;

const isHighSurrogate = (code: number): boolean => code >= 0xd800 && code <= 0xdbff;

/**
 * SSH 客户端封装
 * 提供连接、执行命令、关闭等功能
 */
export class SshClient {
  private client: Client;
  private config: SshClientConfig;
  private connected: boolean = false;
  // 显式关闭后永久为 true。传输层断开不会设置它，仍允许重连。
  private closed: boolean = false;
  private closePromise: Promise<void> | null = null;
  // 断连回调列表
  private disconnectCallbacks: Array<() => void> = [];
  // 标记是否曾成功连接过
  private hasConnectedBefore: boolean = false;
  // 同一时刻只允许一次重连，避免并发重连互相关掉
  private reconnectTask: Promise<void> | null = null;
  // 断连回调只通知一次，直到下一次连接成功
  private disconnectNotified = false;
  private hostKeyInfo: AcceptedHostKey | null = null;
  // 正在进行的 connect()：close() 时必须立刻让它们失败，避免握手悬挂。
  private pendingConnectRejects: Set<(error: Error) => void> = new Set();
  // 已开始的 exec：close() 时主动关闭通道，保证结果一定会落地。
  private activeExecCancels: Set<() => void> = new Set();

  constructor(config: SshClientConfig) {
    this.config = config;
    this.client = new Client();
  }

  private closedError(): SshOperationError {
    return new SshOperationError("SSH client is closed", {
      retryable: false,
      commandStarted: false,
      cancelled: true,
    });
  }

  /**
   * 建立 SSH 连接
   * 所有回调都绑定当次创建的 client，超时或旧连接关闭不会动到后来替换上的连接。
   * @throws 连接失败时抛出错误
   */
  async connect(): Promise<void> {
    if (this.closed) throw this.closedError();
    const client = this.client;
    this.hostKeyInfo = null;
    let rejection: string | null = null;

    return new Promise((resolve, reject) => {
      const connectTimeout = this.config.connectTimeout ?? DEFAULT_CONNECT_TIMEOUT;
      let settled = false;
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      let unregisterPending = () => {};

      const settleReject = (err: Error) => {
        if (settled) return;
        settled = true;
        if (timeoutId !== undefined) clearTimeout(timeoutId);
        unregisterPending();
        reject(err);
      };
      const settleResolve = () => {
        if (settled) return;
        if (this.client !== client) {
          settleReject(new SshOperationError("SSH connection was replaced by a newer attempt", {
            retryable: true,
          }));
          return;
        }
        // close() 之后即使底层迟到了 ready，也不能把客户端重新标成可用。
        if (this.closed) {
          try { client.destroy(); } catch { /* 忽略关闭错误 */ }
          settleReject(this.closedError());
          return;
        }
        settled = true;
        if (timeoutId !== undefined) clearTimeout(timeoutId);
        unregisterPending();
        this.connected = true;
        this.hasConnectedBefore = true;
        this.disconnectNotified = false;
        resolve();
      };

      const pendingReject = (error: Error) => settleReject(error);
      this.pendingConnectRejects.add(pendingReject);
      unregisterPending = () => {
        this.pendingConnectRejects.delete(pendingReject);
      };

      // 超时只关闭本次 client。重连已经换上新对象时，不能再 end() 新连接。
      timeoutId = setTimeout(() => {
        if (this.client === client) {
          try { client.end(); } catch { /* 忽略关闭错误 */ }
          try { client.destroy(); } catch { /* 握手可能已经自行结束 */ }
        }
        settleReject(this.closed
          ? this.closedError()
          : new SshOperationError(`Connection timeout after ${connectTimeout}ms`, {
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
        if (this.closed || this.client !== client || !Buffer.isBuffer(key)) {
          rejection = this.closed ? "client is closed" : "unexpected host key format";
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
        if (this.closed) {
          settleReject(this.closedError());
          return;
        }
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
        if (wasConnected) this.notifyDisconnect();
        if (!settled) {
          settleReject(this.closed
            ? this.closedError()
            : new SshOperationError("SSH connection closed before ready", { retryable: true }));
        }
      });

      if (this.closed) {
        settleReject(this.closedError());
        return;
      }
      try {
        client.connect(connectConfig);
      } catch (err) {
        settleReject(new SshOperationError(`SSH connection error: ${(err as Error).message}`, {
          retryable: true,
        }));
      }
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
    if (this.closed) throw this.closedError();
    if (!this.connected) {
      throw new SshOperationError("Not connected", { retryable: true });
    }

    const execTimeout = options?.timeout;
    const signal = options?.signal;
    const execClient = this.client;
    let settled = false;
    let cancelImpl = () => {};
    const result = new Promise<ExecResult>((resolve, reject) => {
      const stdoutDecoder = new StringDecoder("utf8");
      const stderrDecoder = new StringDecoder("utf8");
      let stdout = "";
      let stderr = "";
      let exitCode: number | null = null;
      // SSH2 的 exit 事件本身是可选的；只有真正收到 exit（哪怕状态为 null）才算有退出状态。
      let exitEventSeen = false;
      let truncated = false;
      let channel: ExecChannel | null = null;
      let execRequestSent = false;
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      let abortListenerAttached = false;
      let unregisterActive = () => {};

      // 先发 EOF 再关闭。只发 CLOSE 时，服务端会一直等结束事件，通道看起来没有关掉。
      const stopChannel = (target: ExecChannel | null) => {
        if (!target) return;
        try { target.signal?.("TERM"); } catch { /* 部分服务端不接受信号 */ }
        try { target.eof?.(); } catch { /* 通道可能已经结束 */ }
        try { target.close(); } catch { /* 通道可能已经关闭 */ }
        try { target.destroy(); } catch { /* 忽略重复销毁 */ }
      };

      const pushStdout = (text: string) => {
        try { options?.onStdout?.(text); } catch { /* 输出回调不能阻止结果落地 */ }
      };
      const pushStderr = (text: string) => {
        try { options?.onStderr?.(text); } catch { /* 输出回调不能阻止结果落地 */ }
      };

      // 按字符上限截断，且不留下半个代理对（surrogate pair）。
      const appendOutput = (
        text: string,
        current: string,
        push: (text: string) => void
      ): string => {
        if (!text) return current;
        if (current.length >= CHARACTER_LIMIT) {
          truncated = true;
          return current;
        }
        const room = CHARACTER_LIMIT - current.length;
        let stored = text.length > room ? text.slice(0, room) : text;
        if (stored.length > 0 && isHighSurrogate(stored.charCodeAt(stored.length - 1))) {
          stored = stored.slice(0, -1);
        }
        if (stored.length < text.length) truncated = true;
        if (stored) push(stored);
        return current + stored;
      };

      const flushDecoders = () => {
        // StringDecoder.end() 会输出被拆分的多字节字符剩余部分；重复调用返回空串。
        stdout = appendOutput(stdoutDecoder.end(), stdout, pushStdout);
        stderr = appendOutput(stderrDecoder.end(), stderr, pushStderr);
      };

      const cleanup = () => {
        if (timeoutId !== undefined) {
          clearTimeout(timeoutId);
          timeoutId = undefined;
        }
        if (abortListenerAttached && signal) {
          signal.removeEventListener("abort", onAbort);
          abortListenerAttached = false;
        }
        unregisterActive();
      };

      const failSettled = (error: Error) => {
        if (settled) return;
        flushDecoders();
        settled = true;
        cleanup();
        reject(error);
      };

      const succeedSettled = () => {
        if (settled) return;
        flushDecoders();
        settled = true;
        cleanup();
        resolve({ stdout, stderr, exit_code: exitCode, truncated });
      };

      cancelImpl = () => {
        if (settled) return;
        stopChannel(channel);
        failSettled(new SshOperationError("Command cancelled", {
          retryable: false,
          // 请求已发出但回调还没回来时，远端可能看到了命令，保守标记为已开始。
          commandStarted: channel !== null || execRequestSent,
          cancelled: true,
        }));
      };

      const onAbort = () => cancelImpl();

      this.activeExecCancels.add(cancelImpl);
      unregisterActive = () => {
        this.activeExecCancels.delete(cancelImpl);
      };

      // 先处理已经取消的 signal：绝不能把命令发给远端。
      if (signal) {
        if (signal.aborted) {
          cancelImpl();
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
        abortListenerAttached = true;
      }

      if (execTimeout !== undefined) {
        timeoutId = setTimeout(() => {
          stopChannel(channel);
          failSettled(new SshOperationError(
            `Command execution timeout after ${execTimeout}ms; the execution channel was closed`,
            {
              retryable: false,
              timedOut: true,
              commandStarted: channel !== null || execRequestSent,
            }
          ));
        }, execTimeout);
      }

      // signal 监听器或自定义实现可能在 setup 期间同步触发取消。
      if (settled) return;

      execRequestSent = true;
      try {
        execClient.exec(command, (err, opened) => {
          const execChannel = opened as ExecChannel | undefined;
          if (settled) {
            stopChannel(execChannel ?? null);
            return;
          }
          if (err || !execChannel) {
            const failure = err ?? new Error("missing channel");
            const coded = failure as Error & { level?: string; code?: string };
            failSettled(new SshOperationError(`Failed to execute command: ${failure.message}`, {
              // 回调失败时通道没有打开，命令尚未开始，只有这种明确的启动前错误可以安全重试。
              retryable: !this.closed,
              commandStarted: false,
              level: coded.level,
            }));
            return;
          }

          // 通道已经打开，命令可能已经在远端开始。之后的失败不再重放。
          channel = execChannel;

          execChannel.on("data", (data: Buffer) => {
            if (settled) return;
            stdout = appendOutput(stdoutDecoder.write(data), stdout, pushStdout);
          });

          execChannel.stderr.on("data", (data: Buffer) => {
            if (settled) return;
            stderr = appendOutput(stderrDecoder.write(data), stderr, pushStderr);
          });

          execChannel.on("end", () => {
            if (settled) return;
            stdout = appendOutput(stdoutDecoder.end(), stdout, pushStdout);
          });
          execChannel.stderr.on("end", () => {
            if (settled) return;
            stderr = appendOutput(stderrDecoder.end(), stderr, pushStderr);
          });

          execChannel.on("exit", (code: number | null) => {
            if (settled) return;
            exitEventSeen = true;
            exitCode = code ?? null;
          });

          execChannel.on("close", () => {
            if (settled) return;
            if (!exitEventSeen) {
              // 没有 exit 事件说明连接在命令结果返回前断了，不能当成成功。
              failSettled(new SshOperationError(
                "SSH channel closed before the remote command reported an exit status; the command result is unknown",
                {
                  retryable: false,
                  commandStarted: true,
                }
              ));
              return;
            }
            succeedSettled();
          });

          execChannel.on("error", (channelErr: Error & { level?: string; code?: string }) => {
            if (settled) return;
            stopChannel(execChannel);
            failSettled(new SshOperationError(`Channel error: ${channelErr.message}`, {
              retryable: false,
              commandStarted: true,
              level: channelErr.level,
            }));
          });
        });
      } catch (err) {
        const failure = err as Error & { level?: string; code?: string };
        failSettled(new SshOperationError(`Failed to execute command: ${failure.message}`, {
          retryable: !this.closed,
          commandStarted: false,
          level: failure.level,
        }));
      }
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

  /** 当前连接配置的公开副本（不含密码、私钥、口令）。 */
  getConfig(): SshPublicConfig {
    const { password: _password, privateKey: _privateKey, passphrase: _passphrase, ...safe } = this.config;
    return safe;
  }

  /** 本次握手接受的主机密钥。连接未完成时为 null。 */
  getHostKey(): AcceptedHostKey | null {
    return this.hostKeyInfo ? { ...this.hostKeyInfo } : null;
  }

  /** 连接是否仍然可用。 */
  isAlive(): boolean {
    return this.connected;
  }

  /** 是否已经显式关闭。关闭后不会再连接或执行命令。 */
  isClosed(): boolean {
    return this.closed;
  }

  /** 注册断连回调；同一段断开只通知一次。 */
  onDisconnect(callback: () => void): void {
    this.disconnectCallbacks.push(callback);
  }

  /**
   * 重新连接。并发调用共用同一次握手，不会各自新建一条连接。
   */
  async reconnect(): Promise<void> {
    if (this.closed) throw this.closedError();
    if (this.reconnectTask) return this.reconnectTask;
    const task = this.reconnectInner().finally(() => {
      if (this.reconnectTask === task) this.reconnectTask = null;
    });
    this.reconnectTask = task;
    return task;
  }

  private async reconnectInner(): Promise<void> {
    if (this.closed) throw this.closedError();

    // 旧握手已经被替换，及时让它的调用方失败，避免悬挂的 connect Promise。
    const replaced = new SshOperationError("SSH connection replaced by reconnect", {
      retryable: true,
    });
    for (const rejectPending of [...this.pendingConnectRejects]) {
      try { rejectPending(replaced); } catch { /* 忽略旧握手的结算错误 */ }
    }

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

  /**
   * 断开连接并释放资源。
   * 同步设置关闭标记，后续 connect/reconnect/exec 都会被拒绝；即使正在握手也会被销毁。
   * 重复调用返回同一个 Promise，且最多等待有限时间。
   */
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;

    this.closed = true;
    const wasConnected = this.connected;
    this.connected = false;
    if (wasConnected) this.notifyDisconnect();

    // 让所有尚未完成的握手立即以“已关闭”失败。
    for (const rejectPending of [...this.pendingConnectRejects]) {
      try { rejectPending(this.closedError()); } catch { /* 忽略重复结算 */ }
    }
    this.pendingConnectRejects.clear();

    // 主动取消执行中的命令，避免底层不触发 close 时结果永远悬挂。
    for (const cancel of [...this.activeExecCancels]) {
      try { cancel(); } catch { /* 命令可能已经结束 */ }
    }
    this.activeExecCancels.clear();

    const client = this.client;
    const task = new Promise<void>((resolve) => {
      let done = false;
      const timer = setTimeout(finish, CLOSE_SETTLE_TIMEOUT);
      function finish(): void {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try { client.removeListener("close", finish); } catch { /* 忽略重复移除 */ }
        resolve();
      }
      try { client.once("close", finish); } catch { /* 已关闭的 client 可能不接受监听 */ }
      try { client.on("error", () => {}); } catch { /* 忽略底层错误 */ }
      try { client.end(); } catch { /* 握手未完成时可能没有 socket */ }
      try { client.destroy(); } catch { /* 忽略重复销毁 */ }
    });
    this.closePromise = task;
    return task;
  }
}
