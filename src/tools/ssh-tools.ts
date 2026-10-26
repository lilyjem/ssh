import { randomUUID } from "crypto";
import { z } from "zod";
import { SessionRegistry, type SessionRecord } from "../services/session-registry.js";
import { SshClient, type SshClientConfig } from "../services/ssh-client.js";
import { SftpClient, isDirectoryMode, type SftpCallOptions } from "../services/sftp-client.js";
import { sanitizeCommand } from "../utils/validation.js";
import { throwIfAborted, withRetry } from "../utils/retry.js";
import { markNotRetryable, SshOperationError } from "../utils/errors.js";
import {
  CHARACTER_LIMIT,
  DEFAULT_MAX_RECONNECT_ATTEMPTS,
  DEFAULT_RECONNECT_BASE_DELAY,
  DEFAULT_RECONNECT_MAX_DELAY,
  DEFAULT_SFTP_TIMEOUT,
} from "../constants.js";
import type { ExecResult, SessionId, SessionInfo } from "../types.js";
import type { GlobalConfig } from "../config.js";

import { log } from "../utils/log.js";

// ============ Zod Schemas 用于参数校验 ============

const sessionIdField = z.string().min(1, "session_id must be a non-empty string").optional()
  .describe("Session ID (optional if using pre-configured server)");

const SftpTimeoutField = {
  timeout: z.number().int().min(1000).max(300000).optional()
    .describe("Abort this SFTP operation if it makes no progress for this many milliseconds"),
};

// 连接参数 Schema
export const ConnectParamsSchema = z.object({
  host: z.string().min(1, "host is required").describe("Remote server hostname or IP address"),
  port: z.number().int().min(1).max(65535).default(22).describe("SSH port (default: 22)"),
  username: z.string().min(1, "username is required").describe("SSH username"),
  password: z.string().optional().describe("Password for authentication"),
  private_key: z.string().optional().describe("Private key content (PEM format)"),
  private_key_path: z.string().optional().describe("Path to private key file"),
  passphrase: z.string().optional().describe("Passphrase for encrypted private key"),
  timeout: z.number().int().min(1000).max(300000).optional().describe("Command execution timeout in ms (default: 30000)"),
  connect_timeout: z.number().int().min(1000).max(60000).optional().describe("Connection timeout in ms (default: 10000)"),
  keepalive_interval: z.number().int().min(0).optional().describe("Keepalive interval in ms (default: 10000, 0 to disable)"),
  keepalive_count: z.number().int().min(1).optional().describe("Max keepalive failures before disconnect (default: 3)"),
  strict_host_key_checking: z.enum(["yes", "accept-new", "no"]).optional().describe("Host key policy. accept-new records unseen keys and rejects changed keys. yes rejects unseen keys. no skips known_hosts."),
  known_hosts_path: z.string().min(1).optional().describe("known_hosts file. Defaults to ~/.ssh/known_hosts"),
  host_fingerprint: z.string().min(1).optional().describe("Required SHA256 host key fingerprint, for example SHA256:abc..."),
});

// 执行命令参数 Schema（支持无 session_id 时使用默认连接）
export const ExecParamsSchema = z.object({
  session_id: sessionIdField,
  command: z.string().min(1, "command is required").describe("Command to execute on the remote server"),
  timeout: z.number().int().min(1000).max(300000).optional().describe("Override command timeout in ms. For background jobs this is optional; omit it to keep the command running until it exits or is cancelled."),
  background: z.boolean().optional().describe("Return immediately and keep the command running as a job"),
});

export const PollExecParamsSchema = z.object({
  job_id: z.string().min(1, "job_id is required").describe("Job ID returned by ssh_exec"),
  stdout_offset: z.number().int().min(0).optional().describe("Return stdout starting at this character offset"),
});

export const CancelExecParamsSchema = z.object({
  job_id: z.string().min(1, "job_id is required").describe("Job ID returned by ssh_exec"),
});

// 断开连接参数 Schema
export const DisconnectParamsSchema = z.object({
  session_id: sessionIdField,
});

// SFTP 列表参数 Schema
export const SftpListParamsSchema = z.object({
  session_id: sessionIdField,
  path: z.string().default("/").describe("Remote directory path to list (default: /)"),
  ...SftpTimeoutField,
});

// SFTP 上传参数 Schema
export const SftpUploadParamsSchema = z.object({
  session_id: sessionIdField,
  local_path: z.string().min(1, "local_path is required").describe("Local file path to upload"),
  remote_path: z.string().min(1, "remote_path is required").describe("Remote destination path"),
  ...SftpTimeoutField,
});

// SFTP 下载参数 Schema
export const SftpDownloadParamsSchema = z.object({
  session_id: sessionIdField,
  remote_path: z.string().min(1, "remote_path is required").describe("Remote file path to download"),
  local_path: z.string().min(1, "local_path is required").describe("Local destination path"),
  ...SftpTimeoutField,
});

// SFTP 读取文件参数 Schema
export const SftpReadParamsSchema = z.object({
  session_id: sessionIdField,
  path: z.string().min(1, "path is required").describe("Remote file path to read"),
  offset: z.number().int().min(0).optional().describe("Byte offset to start reading, default 0"),
  limit: z.number().int().min(1).max(25000).optional().describe("Maximum bytes to read, default 25000"),
  encoding: z.enum(["utf8", "base64"]).optional().describe("utf8 or base64, default utf8"),
  ...SftpTimeoutField,
});

// SFTP 写入文件参数 Schema
export const SftpWriteParamsSchema = z.object({
  session_id: sessionIdField,
  path: z.string().min(1, "path is required").describe("Remote file path to write"),
  content: z.string().describe("Content to write to the file"),
  ...SftpTimeoutField,
});

// SFTP 删除参数 Schema
export const SftpDeleteParamsSchema = z.object({
  session_id: sessionIdField,
  path: z.string().min(1, "path is required").describe("Remote path to delete"),
  ...SftpTimeoutField,
});

// SFTP 创建目录参数 Schema
export const SftpMkdirParamsSchema = z.object({
  session_id: sessionIdField,
  path: z.string().min(1, "path is required").describe("Remote directory path to create"),
  ...SftpTimeoutField,
});

// SFTP 重命名参数 Schema
export const SftpRenameParamsSchema = z.object({
  session_id: sessionIdField,
  old_path: z.string().min(1, "old_path is required").describe("Current path of the file/directory"),
  new_path: z.string().min(1, "new_path is required").describe("New path for the file/directory"),
  ...SftpTimeoutField,
});

// ============ 类型定义 ============

export type ConnectParams = z.infer<typeof ConnectParamsSchema>;
export type ExecParams = z.infer<typeof ExecParamsSchema>;
export type DisconnectParams = z.infer<typeof DisconnectParamsSchema>;
export type SftpListParams = z.infer<typeof SftpListParamsSchema>;
export type SftpUploadParams = z.infer<typeof SftpUploadParamsSchema>;
export type SftpDownloadParams = z.infer<typeof SftpDownloadParamsSchema>;
export type SftpReadParams = z.infer<typeof SftpReadParamsSchema>;
export type SftpWriteParams = z.infer<typeof SftpWriteParamsSchema>;
export type SftpDeleteParams = z.infer<typeof SftpDeleteParamsSchema>;
export type SftpMkdirParams = z.infer<typeof SftpMkdirParamsSchema>;
export type SftpRenameParams = z.infer<typeof SftpRenameParamsSchema>;

// 连接结果
export interface ConnectResult {
  session_id: SessionId;
  message: string;
  host_fingerprint: string;
  host_key_type: string;
}

export interface BackgroundExecResult {
  background: true;
  job_id: string;
  status: "running";
}

export interface ExecJobView {
  job_id: string;
  status: "running" | "exited" | "cancelled" | "failed";
  stdout: string;
  stderr: string;
  exit_code: number | null;
  truncated: boolean;
  next_stdout_offset: number;
}

interface ExecJob {
  id: string;
  sessionId: SessionId;
  status: ExecJobView["status"];
  stdout: string;
  stderr: string;
  exitCode: number | null;
  truncated: boolean;
  cancel: () => void;
  createdAt: number;
  finishedAt: number | null;
}

interface SftpInit {
  promise: Promise<SftpClient>;
  sessionEpoch: number;
  sftpEpoch: number;
  sshClient: SshClient;
  client: SftpClient;
  waiters: number;
  settled: boolean;
}

// 列表结果
export interface ListSessionsResult {
  sessions: Array<{
    session_id: SessionId;
    host: string;
    port: number;
    username: string;
    created_at: string;
    last_used_at: string | null;
  }>;
  count: number;
}

// 断开连接结果
export interface DisconnectResult {
  success: boolean;
  message: string;
}

// 默认会话 ID（用于预配置的服务器）
const DEFAULT_SESSION_ID = "__default__";

// 后台任务保留上限和终态保留时间。终态任务保留一段时间供轮询，之后惰性清理。
const MAX_RETAINED_JOBS = 32;
const JOB_TERMINAL_TTL_MS = 15 * 60 * 1000;

// 记住最近断开的会话，让重复 disconnect 幂等，同时避免 UUID 集合无限增长。
const MAX_RETIRED_SESSIONS = 256;

/**
 * SSH 工具处理器
 * 封装所有 SSH 和 SFTP 相关的 MCP 工具逻辑
 */
export class SshToolHandlers {
  private registry: SessionRegistry;
  private clients: Map<SessionId, SshClient> = new Map();
  private sftpClients: Map<SessionId, SftpClient> = new Map();
  private jobs: Map<string, ExecJob> = new Map();
  private globalConfig: GlobalConfig;
  private defaultSessionId: SessionId | null = null;

  // 会话生命周期代次。断开时递增，让晚到的重连/初始化结果知道自己已经过期。
  private sessionEpochs: Map<SessionId, number> = new Map();
  private sftpEpochs: Map<SessionId, number> = new Map();
  private closingSessions: Set<SessionId> = new Set();
  private sftpInits: Map<SessionId, SftpInit> = new Map();
  private retiredSessions: Set<SessionId> = new Set();
  private nextEpoch = 0;

  constructor(config: GlobalConfig = {}) {
    this.registry = new SessionRegistry();
    this.globalConfig = config;
  }

  /**
   * 使用预配置的服务器信息自动连接
   * 在服务启动时调用
   */
  async autoConnect(): Promise<string | null> {
    if (!this.globalConfig.server) {
      return null;
    }

    const serverConfig = this.globalConfig.server;
    
    try {
      const result = await this.connect({
        host: serverConfig.host,
        port: serverConfig.port,
        username: serverConfig.username,
        password: serverConfig.password,
        private_key: serverConfig.privateKey,
        private_key_path: serverConfig.privateKeyPath,
        passphrase: serverConfig.passphrase,
        timeout: this.globalConfig.timeout,
        connect_timeout: this.globalConfig.connectTimeout,
      });

      this.defaultSessionId = result.session_id;
      return result.session_id;
    } catch (err) {
      throw new Error(`Auto-connect failed: ${(err as Error).message}`);
    }
  }

  /**
   * 获取有效的会话 ID
   * 如果未提供 session_id，则使用默认会话；显式传入空字符串必须报错而不是退回默认会话。
   */
  private getEffectiveSessionId(sessionId?: SessionId): SessionId {
    if (sessionId !== undefined) {
      if (typeof sessionId !== "string" || sessionId.length === 0) {
        throw new Error("session_id must be a non-empty string");
      }
      return sessionId;
    }
    if (this.defaultSessionId) {
      return this.defaultSessionId;
    }
    throw new Error("No session_id provided and no default session available. Please connect first or configure server in environment variables.");
  }

  /**
   * 判断错误是否为连接相关错误（应该触发重连重试）
   * 认证错误、参数错误、超时、取消等不重试
   */
  shouldRetryOperation(error: Error): boolean {
    const marked = error as Partial<SshOperationError>;
    // 显式标记优先于文本匹配，避免认证失败或已开始的命令被当成可重试连接错误。
    if (marked.retryable === false || marked.commandStarted || marked.timedOut || marked.cancelled) return false;
    if (marked.level === "client-authentication") return false;

    const blocked = [
      "All configured authentication methods failed",
      "Host denied",
      "verification failed",
      "host key",
      "Command execution timeout",
      "disconnected or closing",
    ];
    if (blocked.some((pattern) => error.message.includes(pattern))) return false;

    const connectionPatterns = [
      "Not connected",
      "ECONNRESET",
      "ECONNREFUSED",
      "EPIPE",
      "ETIMEDOUT",
      "Connection timeout",
      "Channel error",
      "SSH connection error",
      "SFTP not initialized",
      "socket hang up",
      "Connection lost",
    ];
    return connectionPatterns.some((pattern) =>
      error.message.includes(pattern)
    );
  }

  private nextEpochValue(): number {
    this.nextEpoch += 1;
    return this.nextEpoch;
  }

  /** 只保留最近断开的一小批会话 ID，用于幂等 disconnect。 */
  private rememberRetiredSession(sessionId: SessionId): void {
    this.retiredSessions.delete(sessionId);
    this.retiredSessions.add(sessionId);
    while (this.retiredSessions.size > MAX_RETIRED_SESSIONS) {
      const oldest = this.retiredSessions.values().next().value as SessionId | undefined;
      if (oldest === undefined) break;
      this.retiredSessions.delete(oldest);
    }
  }

  private getSessionEpoch(sessionId: SessionId): number {
    return this.sessionEpochs.get(sessionId) ?? 0;
  }

  private getSftpEpoch(sessionId: SessionId): number {
    return this.sftpEpochs.get(sessionId) ?? 0;
  }

  private sessionUnavailable(sessionId: SessionId): SshOperationError {
    return new SshOperationError(`Session ${sessionId} is disconnected or closing`, {
      retryable: false,
      commandStarted: false,
    });
  }

  /**
   * 同步校验会话仍然可操作。所有需要在 await 之后继续的重连/初始化都要再调用一次，
   * 防止 disconnect() 已经移除会话后又被晚到的异步流程复活。
   */
  private assertSessionOpen(
    sessionId: SessionId,
    expectedSessionEpoch?: number,
    expectedClient?: SshClient
  ): SshClient {
    if (this.closingSessions.has(sessionId)) throw this.sessionUnavailable(sessionId);
    const client = this.clients.get(sessionId);
    const session = this.registry.getSession(sessionId);
    if (!client || !session) throw this.sessionUnavailable(sessionId);
    if (this.isSshClientClosed(client)) {
      // 外部显式关闭的客户端等同于断开：同步清理会话和关联任务，绝不重连。
      this.beginSessionTeardown(sessionId);
      this.finishSessionTeardown(sessionId);
      throw this.sessionUnavailable(sessionId);
    }
    if (expectedSessionEpoch !== undefined && this.getSessionEpoch(sessionId) !== expectedSessionEpoch) {
      throw this.sessionUnavailable(sessionId);
    }
    if (expectedClient && client !== expectedClient) {
      throw this.sessionUnavailable(sessionId);
    }
    return client;
  }

  private isSshClientClosed(client: SshClient): boolean {
    try {
      const probe = client as unknown as { isClosed?: () => boolean };
      return typeof probe.isClosed === "function" ? probe.isClosed() : false;
    } catch {
      return true;
    }
  }

  private isSshClientAlive(client: SshClient): boolean {
    try {
      const probe = client as unknown as { isClosed?: () => boolean; isAlive?: () => boolean };
      // 显式关闭的客户端永远不可用；isAlive 表示当前连接可用。
      // isClosed 只在显式 close 后为 true，网络断开时仍可能是 false。
      if (this.isSshClientClosed(client)) return false;
      if (typeof probe.isAlive === "function") return probe.isAlive();
      return true;
    } catch {
      return false;
    }
  }

  private isSftpClientAlive(sftp: SftpClient): boolean {
    try {
      const probe = sftp as unknown as { isAlive?: () => boolean; isClosed?: () => boolean };
      if (typeof probe.isAlive === "function") return probe.isAlive();
      if (typeof probe.isClosed === "function") return !probe.isClosed();
      return true;
    } catch {
      return false;
    }
  }

  private closeSftpQuietly(sftp: SftpClient): void {
    try {
      sftp.close();
    } catch {
      // 关闭失败不影响错误返回；缓存已经移除。
    }
  }

  private async closeClientQuietly(client: SshClient): Promise<void> {
    try {
      await client.close();
    } catch {
      // 清理是 best-effort，不能覆盖真正的错误。
    }
  }

  /**
   * 会话拆除时关闭仍在进行的初始化，避免 SFTP 通道拖到配置超时才结束。
   */
  private closePendingSftpInit(sessionId: SessionId): void {
    const init = this.sftpInits.get(sessionId);
    if (init && !init.settled) {
      this.closeSftpQuietly(init.client);
    }
  }

  /**
   * 清理指定会话的 SFTP 客户端缓存
   * 在连接断开、重连或操作超时/取消后调用。代次递增让晚到的 init 结果不再写入缓存。
   */
  invalidateSftpClient(sessionId: SessionId): void {
    const sftpClient = this.sftpClients.get(sessionId);
    this.sftpClients.delete(sessionId);
    this.sftpInits.delete(sessionId);
    if (this.sftpEpochs.has(sessionId)) {
      this.sftpEpochs.set(sessionId, this.nextEpochValue());
    }
    if (sftpClient) this.closeSftpQuietly(sftpClient);
  }

  /**
   * 确保连接存活，必要时自动重连。恢复后必须重新校验会话代次，
   * disconnect() 已经发生时先关掉刚建立的连接再抛错，绝不复用被移除的会话。
   */
  private async ensureConnected(sessionId: SessionId, signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    const sessionEpoch = this.getSessionEpoch(sessionId);
    const client = this.assertSessionOpen(sessionId, sessionEpoch);

    if (this.isSshClientAlive(client)) {
      throwIfAborted(signal);
      return;
    }

    this.assertSessionOpen(sessionId, sessionEpoch, client);
    this.invalidateSftpClient(sessionId);
    log(`Session ${sessionId} is not alive, attempting reconnect...`);
    await client.reconnect();

    if (
      this.closingSessions.has(sessionId) ||
      !this.registry.getSession(sessionId) ||
      this.clients.get(sessionId) !== client ||
      this.getSessionEpoch(sessionId) !== sessionEpoch
    ) {
      await this.closeClientQuietly(client);
      throw this.sessionUnavailable(sessionId);
    }

    throwIfAborted(signal);
    log(`Session ${sessionId} reconnected successfully`);
  }

  /**
   * 带自动重连和重试的操作执行器
   * 连接断开时自动重连，操作失败时按指数退避重试
   */
  private async withAutoReconnect<T>(
    sessionId: SessionId,
    operation: () => Promise<T>,
    signal?: AbortSignal
  ): Promise<T> {
    const maxAttempts = this.globalConfig.maxReconnectAttempts ?? DEFAULT_MAX_RECONNECT_ATTEMPTS;
    const baseDelay = this.globalConfig.reconnectBaseDelay ?? DEFAULT_RECONNECT_BASE_DELAY;
    const maxDelay = this.globalConfig.reconnectMaxDelay ?? DEFAULT_RECONNECT_MAX_DELAY;
    const sessionEpoch = this.getSessionEpoch(sessionId);

    return withRetry(
      async () => {
        // 每次尝试开始前同步校验，disconnect 后不会再进入 ensureConnected/reconnect。
        this.assertSessionOpen(sessionId, sessionEpoch);
        await this.ensureConnected(sessionId, signal);
        this.assertSessionOpen(sessionId, sessionEpoch);
        throwIfAborted(signal);
        return await operation();
      },
      {
        maxAttempts,
        baseDelay,
        maxDelay,
        signal,
        shouldRetry: (err) => this.shouldRetryOperation(err),
      }
    );
  }

  private sftpInitTimeout(): number {
    return this.globalConfig.sftpTimeout ?? DEFAULT_SFTP_TIMEOUT;
  }

  private sftpWaitTimeout(call: SftpCallOptions): number {
    return call.timeout ?? this.sftpInitTimeout();
  }

  /**
   * 真正初始化 SFTP 包装器。底层初始化只受配置/默认初始化超时约束，
   * 不绑定某个调用者的 AbortSignal；调用者取消由外层 waiter 处理。
   */
  private async createSftpClient(
    sessionId: SessionId,
    sshClient: SshClient,
    sessionEpoch: number,
    sftpEpoch: number,
    sftpClient: SftpClient
  ): Promise<SftpClient> {
    try {
      await sftpClient.init({ timeout: this.sftpInitTimeout() });
      this.assertSessionOpen(sessionId, sessionEpoch, sshClient);
      if (this.getSftpEpoch(sessionId) !== sftpEpoch) {
        throw new SshOperationError("SFTP initialization was invalidated", { retryable: true });
      }
    } catch (err) {
      this.closeSftpQuietly(sftpClient);
      throw err;
    }

    const winner = this.sftpClients.get(sessionId);
    if (winner && winner !== sftpClient) {
      if (this.isSftpClientAlive(winner)) {
        this.closeSftpQuietly(sftpClient);
        return winner;
      }
      this.sftpClients.delete(sessionId);
      this.closeSftpQuietly(winner);
    }

    this.sftpClients.set(sessionId, sftpClient);
    return sftpClient;
  }

  /**
   * 获取或创建当前代次的 SFTP 初始化记录。所有调用者（包括创建者）都通过
   * waitForSftpInit 使用自己的 deadline/AbortSignal 等待。
   */
  private getOrCreateSftpInit(sessionId: SessionId): SftpInit {
    const existing = this.sftpInits.get(sessionId);
    if (existing) {
      const sshClient = this.clients.get(sessionId);
      if (
        sshClient &&
        existing.sessionEpoch === this.getSessionEpoch(sessionId) &&
        existing.sftpEpoch === this.getSftpEpoch(sessionId) &&
        existing.sshClient === sshClient
      ) {
        return existing;
      }
    }

    const sessionEpoch = this.getSessionEpoch(sessionId);
    const sftpEpoch = this.getSftpEpoch(sessionId);
    const sshClient = this.assertSessionOpen(sessionId, sessionEpoch);
    const sftpClient = new SftpClient(sshClient.getClient(), {
      timeout: this.globalConfig.sftpTimeout,
    });
    const promise = this.createSftpClient(
      sessionId,
      sshClient,
      sessionEpoch,
      sftpEpoch,
      sftpClient
    );
    const record: SftpInit = {
      promise,
      sessionEpoch,
      sftpEpoch,
      sshClient,
      client: sftpClient,
      waiters: 0,
      settled: false,
    };
    const cleanup = () => {
      record.settled = true;
      if (this.sftpInits.get(sessionId) === record) {
        this.sftpInits.delete(sessionId);
      }
    };
    // 先登记 settle 回调，waiter 释放时才能区分底层已结束和仍在初始化。
    promise.then(cleanup, cleanup);
    this.sftpInits.set(sessionId, record);
    return record;
  }

  /**
   * 没有等待者时放弃仍在进行的初始化：删除记录、让晚到结果失效并关闭通道。
   * 已经完成的 init 不关闭，成功后保留缓存供后续操作复用。
   */
  private abandonSftpInit(sessionId: SessionId, init: SftpInit): void {
    const current = this.sftpInits.get(sessionId) === init;
    if (current) this.sftpInits.delete(sessionId);
    if (init.settled) return;
    if (current && this.sftpEpochs.has(sessionId)) {
      this.sftpEpochs.set(sessionId, this.nextEpochValue());
    }
    this.closeSftpQuietly(init.client);
  }

  private releaseSftpWaiter(sessionId: SessionId, init: SftpInit): void {
    init.waiters = Math.max(0, init.waiters - 1);
    if (init.waiters === 0) {
      this.abandonSftpInit(sessionId, init);
    }
  }

  /**
   * 加入初始化时使用的等待错误。waiterOnly 表示只是本次等待超时/取消，
   * 底层 init 仍可能被其他等待者继续使用，调用层不能据此销毁共享 SFTP 会话。
   */
  private sftpWaiterError(reason: "timeout" | "cancel", timeout?: number): SshOperationError {
    const error = reason === "cancel"
      ? new SshOperationError("SFTP cancelled", { retryable: false, cancelled: true })
      : new SshOperationError(`SFTP timeout after ${timeout}ms`, {
        retryable: false,
        timedOut: true,
      });
    (error as SshOperationError & { waiterOnly?: boolean }).waiterOnly = true;
    return error;
  }

  /**
   * 每个调用者（包括初始化创建者）都用本次调用的 deadline / AbortSignal
   * 等待共享 init。超时或取消只释放自己这个 waiter；仍有其他 waiter 时
   * 底层 init 继续，最后一个 waiter 离开时才关闭未完成的初始化。
   */
  private waitForSftpInit(
    sessionId: SessionId,
    init: SftpInit,
    call: SftpCallOptions
  ): Promise<SftpClient> {
    const { promise } = init;
    const signal = call.signal;
    const timeout = this.sftpWaitTimeout(call);
    init.waiters += 1;

    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      this.releaseSftpWaiter(sessionId, init);
    };

    return new Promise<SftpClient>((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let abortAttached = false;
      const cleanup = () => {
        if (timer !== undefined) clearTimeout(timer);
        if (abortAttached) signal?.removeEventListener("abort", onAbort);
      };
      const finish = (err?: Error, client?: SftpClient) => {
        if (settled) return;
        settled = true;
        cleanup();
        release();
        if (err) reject(err);
        else resolve(client as SftpClient);
      };
      const onAbort = () => finish(this.sftpWaiterError("cancel"));
      if (signal?.aborted) {
        finish(this.sftpWaiterError("cancel"));
        return;
      }
      timer = setTimeout(() => finish(this.sftpWaiterError("timeout", timeout)), timeout);
      signal?.addEventListener("abort", onAbort, { once: true });
      abortAttached = signal !== undefined;

      promise.then(
        (client) => finish(undefined, client),
        (err) => finish(err)
      );
    });
  }

  /**
   * 获取可用的 SFTP 客户端。关闭的缓存包装器会被丢弃并重新初始化，
   * 绝不再返回已经 close 的实例。
   */
  private async getSftpClient(sessionId: SessionId, call: SftpCallOptions): Promise<SftpClient> {
    this.assertSessionOpen(sessionId);
    await this.ensureConnected(sessionId, call.signal);
    this.assertSessionOpen(sessionId);

    for (let attempt = 0; attempt < 2; attempt++) {
      const cached = this.sftpClients.get(sessionId);
      if (cached) {
        if (this.isSftpClientAlive(cached)) return cached;
        this.invalidateSftpClient(sessionId);
      }

      throwIfAborted(call.signal);
      const init = this.getOrCreateSftpInit(sessionId);
      const created = await this.waitForSftpInit(sessionId, init, call);
      if (this.isSftpClientAlive(created)) return created;
      this.invalidateSftpClient(sessionId);
    }

    throw new SshOperationError("SFTP session is closed during initialization", { retryable: true });
  }

  /**
   * 执行 SFTP 操作。超时、取消或包装器已经关闭后丢掉当前 SFTP 会话，下次重新打开。
   * 只加入共享初始化的等待者超时不应销毁别人仍在使用的初始化。
   */
  private async performSftp<T>(
    sessionId: SessionId,
    call: SftpCallOptions,
    run: (sftp: SftpClient) => Promise<T>
  ): Promise<T> {
    let usedSftp: SftpClient | undefined;
    try {
      return await this.withAutoReconnect(sessionId, async () => {
        const sftp = await this.getSftpClient(sessionId, call);
        throwIfAborted(call.signal);
        usedSftp = sftp;
        return await run(sftp);
      }, call.signal);
    } catch (err) {
      const marked = err as Partial<SshOperationError> & { waiterOnly?: boolean };
      const cached = this.sftpClients.get(sessionId);
      const wrapperDead = cached !== undefined && !this.isSftpClientAlive(cached);
      const failedAfterAcquire = usedSftp !== undefined;
      if (
        wrapperDead ||
        (!marked.waiterOnly && failedAfterAcquire && (marked.timedOut || marked.cancelled))
      ) {
        this.invalidateSftpClient(sessionId);
      }
      throw err;
    }
  }

  /**
   * SFTP 工具公共流程：取会话、刷新使用时间、执行操作并套用重连重试。
   */
  private async runSftpOperation<T>(
    sessionId: SessionId | undefined,
    timeout: number | undefined,
    signal: AbortSignal | undefined,
    run: (sftp: SftpClient, call: SftpCallOptions) => Promise<T>
  ): Promise<T> {
    const effectiveSessionId = this.getEffectiveSessionId(sessionId);
    this.assertSessionOpen(effectiveSessionId);
    this.registry.touchSession(effectiveSessionId);
    const call: SftpCallOptions = { timeout, signal };
    return this.performSftp(effectiveSessionId, call, (sftp) => run(sftp, call));
  }

  /**
   * ssh_connect: 创建新的 SSH 连接
   */
  async connect(params: ConnectParams): Promise<ConnectResult> {
    const validated = ConnectParamsSchema.parse(params);

    // 检查是否提供了认证方式
    if (!validated.password && !validated.private_key && !validated.private_key_path) {
      throw new Error("At least one authentication method is required (password, private_key, or private_key_path)");
    }

    // 构建 SSH 客户端配置
    const clientConfig: SshClientConfig = {
      host: validated.host,
      port: validated.port,
      username: validated.username,
      password: validated.password,
      privateKey: validated.private_key,
      privateKeyPath: validated.private_key_path,
      passphrase: validated.passphrase,
      timeout: validated.timeout ?? this.globalConfig.timeout,
      connectTimeout: validated.connect_timeout ?? this.globalConfig.connectTimeout,
      keepaliveInterval: validated.keepalive_interval ?? this.globalConfig.keepaliveInterval,
      keepaliveCountMax: validated.keepalive_count ?? this.globalConfig.keepaliveCountMax,
      strictHostKeyChecking: validated.strict_host_key_checking ?? this.globalConfig.strictHostKeyChecking,
      knownHostsPath: validated.known_hosts_path ?? this.globalConfig.knownHostsPath,
      hostFingerprint: validated.host_fingerprint ?? this.globalConfig.hostFingerprint,
    };

    // 创建 SSH 客户端并连接
    const client = new SshClient(clientConfig);

    try {
      await client.connect();
    } catch (err) {
      await this.closeClientQuietly(client);
      throw new Error(`Failed to connect: ${(err as Error).message}`);
    }

    // 注册会话
    const session = this.registry.createSession({
      host: validated.host,
      port: validated.port,
      username: validated.username,
    });

    // 保存客户端实例。会话代次用于识别断开后晚到的异步结果。
    this.closingSessions.delete(session.sessionId);
    this.sessionEpochs.set(session.sessionId, this.nextEpochValue());
    this.sftpEpochs.set(session.sessionId, this.nextEpochValue());
    this.clients.set(session.sessionId, client);

    // 注册断连回调，自动清理失效的 SFTP 缓存
    client.onDisconnect(() => {
      this.invalidateSftpClient(session.sessionId);
      log(`Session ${session.sessionId} disconnected unexpectedly`);
    });

    const hostKey = client.getHostKey();
    return {
      session_id: session.sessionId,
      message: `Connected to ${validated.username}@${validated.host}:${validated.port}`,
      host_fingerprint: hostKey?.fingerprint ?? "",
      host_key_type: hostKey?.keyType ?? "",
    };
  }

  /**
   * ssh_exec: 在指定会话中执行命令
   */
  async exec(params: ExecParams, signal?: AbortSignal): Promise<ExecResult | BackgroundExecResult> {
    const validated = ExecParamsSchema.parse(params);
    const sessionId = this.getEffectiveSessionId(validated.session_id);

    const session = this.registry.getSession(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    // 在任何 await 之前完成同步围栏，已断开/正在断开的会话不会再启动重连或后台任务。
    this.assertSessionOpen(sessionId);
    const command = sanitizeCommand(validated.command);
    this.registry.touchSession(sessionId);

    if (validated.background) {
      await this.ensureConnected(sessionId, signal);
      this.assertSessionOpen(sessionId);
      throwIfAborted(signal);
      return this.startBackground(sessionId, command, validated.timeout, signal);
    }

    return this.withAutoReconnect(sessionId, async () => {
      const client = this.assertSessionOpen(sessionId);
      return client.execCommand(command, validated.timeout, signal);
    }, signal);
  }

  /**
   * 后台命令立即返回。输出保存在进程内，服务重启后任务消失。
   */
  private startBackground(
    sessionId: SessionId,
    command: string,
    timeout: number | undefined,
    signal?: AbortSignal
  ): BackgroundExecResult {
    const client = this.assertSessionOpen(sessionId);
    this.reserveJobCapacity();

    const job: ExecJob = {
      id: randomUUID(),
      sessionId,
      status: "running",
      stdout: "",
      stderr: "",
      exitCode: null,
      truncated: false,
      cancel: () => {},
      createdAt: Date.now(),
      finishedAt: null,
    };

    // 先登记任务，确保 startCommand 同步失败时也能回滚容量预留。
    this.jobs.set(job.id, job);
    let handle;
    try {
      handle = client.startCommand(command, {
        timeout,
        signal,
        onStdout: (chunk) => this.appendJobOutput(job, "stdout", chunk),
        onStderr: (chunk) => this.appendJobOutput(job, "stderr", chunk),
      });
    } catch (err) {
      this.jobs.delete(job.id);
      this.releaseJob(job);
      throw err;
    }

    job.cancel = () => {
      // 由调用方先标记状态也可以；这里负责关闭执行通道。
      job.status = "cancelled";
      if (job.finishedAt === null) job.finishedAt = Date.now();
      handle.cancel();
    };
    // 终态回调释放 handle 闭包，避免任务对象继续持有已结束的执行通道。
    handle.result.then(
      (result) => {
        if (job.status === "running") {
          job.status = "exited";
          job.exitCode = result.exit_code;
          job.truncated = job.truncated || result.truncated;
        }
        this.finishJob(job);
      },
      (err) => {
        if (job.status === "running") {
          job.status = this.isCancellationError(err) ? "cancelled" : "failed";
        }
        this.finishJob(job);
      }
    );
    return { background: true, job_id: job.id, status: "running" };
  }

  /** 读取后台任务的当前输出和状态。 */
  async pollExec(params: z.infer<typeof PollExecParamsSchema>): Promise<ExecJobView> {
    const validated = PollExecParamsSchema.parse(params);
    this.pruneTerminalJobs();
    const job = this.jobs.get(validated.job_id);
    if (!job) throw new Error(`Job not found: ${validated.job_id}`);
    const offset = validated.stdout_offset ?? 0;
    return {
      job_id: job.id,
      status: job.status,
      stdout: job.stdout.slice(offset),
      stderr: job.stderr,
      exit_code: job.exitCode,
      truncated: job.truncated,
      next_stdout_offset: job.stdout.length,
    };
  }

  /** 关闭后台任务的执行通道。已脱离会话的远端进程不保证停止。 */
  async cancelExec(params: z.infer<typeof CancelExecParamsSchema>): Promise<{ job_id: string; status: ExecJob["status"] }> {
    const validated = CancelExecParamsSchema.parse(params);
    this.pruneTerminalJobs();
    const job = this.jobs.get(validated.job_id);
    if (!job) throw new Error(`Job not found: ${validated.job_id}`);
    if (job.status === "running") {
      const cancel = job.cancel;
      job.status = "cancelled";
      job.finishedAt = Date.now();
      this.releaseJob(job);
      try {
        cancel();
      } catch {
        // 执行通道可能已经结束，状态保持 cancelled。
      }
    }
    return { job_id: job.id, status: job.status };
  }

  private isCancellationError(err: unknown): boolean {
    const marked = err as Partial<SshOperationError> | undefined;
    if (marked?.cancelled === true) return true;
    const message = err instanceof Error ? err.message : String(err);
    return /cancelled|canceled/i.test(message);
  }

  private releaseJob(job: ExecJob): void {
    job.cancel = () => {};
  }

  private finishJob(job: ExecJob): void {
    if (job.finishedAt === null) job.finishedAt = Date.now();
    this.releaseJob(job);
  }

  /** 惰性清理超过 TTL 的终态任务，运行中的任务不参与清理。 */
  private pruneTerminalJobs(now: number = Date.now()): void {
    for (const [id, job] of this.jobs) {
      if (
        job.status !== "running" &&
        job.finishedAt !== null &&
        now - job.finishedAt >= JOB_TERMINAL_TTL_MS
      ) {
        this.releaseJob(job);
        this.jobs.delete(id);
      }
    }
  }

  /**
   * 为新的后台任务预留槽位。达到上限时优先淘汰最老的终态任务；
   * 全部 32 个都在运行时明确拒绝，而不是静默丢任务。
   */
  private reserveJobCapacity(): void {
    this.pruneTerminalJobs();
    if (this.jobs.size < MAX_RETAINED_JOBS) return;

    let oldest: ExecJob | undefined;
    for (const job of this.jobs.values()) {
      if (job.status === "running") continue;
      if (
        !oldest ||
        (job.finishedAt ?? job.createdAt) < (oldest.finishedAt ?? oldest.createdAt)
      ) {
        oldest = job;
      }
    }

    if (oldest) {
      this.releaseJob(oldest);
      this.jobs.delete(oldest.id);
      return;
    }

    throw new SshOperationError(
      `Too many background jobs (${MAX_RETAINED_JOBS} running); cancel one before starting another`,
      { retryable: false }
    );
  }

  /** 断开/清理会话时同步取消并移除该会话的所有后台任务。 */
  private cancelSessionJobs(sessionId: SessionId): void {
    for (const [id, job] of [...this.jobs]) {
      if (job.sessionId !== sessionId) continue;
      if (job.status === "running") {
        const cancel = job.cancel;
        job.status = "cancelled";
        job.finishedAt = Date.now();
        this.releaseJob(job);
        try {
          cancel();
        } catch {
          // 关闭执行通道失败也要继续移除任务。
        }
      } else {
        this.releaseJob(job);
      }
      this.jobs.delete(id);
    }
  }

  private appendJobOutput(job: ExecJob, field: "stdout" | "stderr", chunk: string): void {
    if (!chunk) return;
    const current = job[field];
    if (current.length >= CHARACTER_LIMIT) {
      job.truncated = true;
      return;
    }

    const room = CHARACTER_LIMIT - current.length;
    let text = chunk;
    if (text.length > room) {
      text = text.slice(0, room);
      job.truncated = true;
    }

    // 不把代理对截成半个字符：丢掉末尾的高代理或开头的孤立低代理。
    if (text.length > 0) {
      const last = text.charCodeAt(text.length - 1);
      if (last >= 0xd800 && last <= 0xdbff) {
        text = text.slice(0, -1);
        job.truncated = true;
      }
    }
    if (text.length > 0) {
      const first = text.charCodeAt(0);
      if (first >= 0xdc00 && first <= 0xdfff) {
        text = text.slice(1);
        job.truncated = true;
      }
    }

    job[field] += text;
  }

  /**
   * ssh_list_sessions: 列出所有活跃会话
   */
  listSessions(): ListSessionsResult {
    const sessions = this.registry.listSessions();

    return {
      sessions: sessions.map((s: SessionInfo) => ({
        session_id: s.sessionId,
        host: s.host,
        port: s.port,
        username: s.username,
        created_at: s.createdAt,
        last_used_at: s.lastUsedAt,
      })),
      count: sessions.length,
    };
  }

  /**
   * 同步开始会话拆除：先加围栏、取消任务、移出所有缓存，再允许调用方等待网络关闭。
   * 这样晚到的重连/初始化结果只能看到已移除的会话。
   */
  private beginSessionTeardown(sessionId: SessionId): { session?: SessionRecord; client?: SshClient } {
    const session = this.registry.getSession(sessionId);
    const client = this.clients.get(sessionId);

    this.closingSessions.add(sessionId);
    this.rememberRetiredSession(sessionId);
    if (this.sessionEpochs.has(sessionId)) {
      this.sessionEpochs.set(sessionId, this.nextEpochValue());
    }
    this.cancelSessionJobs(sessionId);
    this.closePendingSftpInit(sessionId);
    this.invalidateSftpClient(sessionId);
    this.clients.delete(sessionId);
    this.registry.removeSession(sessionId);
    if (this.defaultSessionId === sessionId) {
      this.defaultSessionId = null;
    }

    return { session, client };
  }

  private finishSessionTeardown(sessionId: SessionId): void {
    this.closingSessions.delete(sessionId);
    this.sessionEpochs.delete(sessionId);
    this.sftpEpochs.delete(sessionId);
  }

  /**
   * ssh_disconnect: 断开指定会话
   */
  async disconnect(params: DisconnectParams): Promise<DisconnectResult> {
    const validated = DisconnectParamsSchema.parse(params);
    const sessionId = this.getEffectiveSessionId(validated.session_id);

    const exists = !!this.registry.getSession(sessionId) ||
      this.clients.has(sessionId) ||
      this.sftpClients.has(sessionId);
    if (!exists) {
      if (!this.retiredSessions.has(sessionId)) {
        throw new Error(`Session not found: ${sessionId}`);
      }
      if (sessionId === this.defaultSessionId) this.defaultSessionId = null;
      return {
        success: true,
        message: `Session ${sessionId} is already disconnected`,
      };
    }

    const { session, client } = this.beginSessionTeardown(sessionId);
    try {
      if (client) await client.close();
    } catch (err) {
      // 清理已经完成，关闭失败只记录，不能把会话重新写回缓存。
      log(`Session ${sessionId} close failed during disconnect: ${(err as Error).message}`);
    } finally {
      this.finishSessionTeardown(sessionId);
    }

    return {
      success: true,
      message: session
        ? `Disconnected from ${session.username}@${session.host}:${session.port}`
        : `Disconnected session ${sessionId}`,
    };
  }

  // ============ SFTP 操作 ============

  /**
   * sftp_list: 列出远程目录内容
   */
  async sftpList(params: SftpListParams, signal?: AbortSignal) {
    const validated = SftpListParamsSchema.parse(params);
    return this.runSftpOperation(validated.session_id, validated.timeout, signal,
      (sftp, call) => sftp.listDirectory(validated.path, call));
  }

  /**
   * sftp_upload: 上传本地文件到远程服务器
   */
  async sftpUpload(params: SftpUploadParams, signal?: AbortSignal) {
    const validated = SftpUploadParamsSchema.parse(params);
    return this.runSftpOperation(validated.session_id, validated.timeout, signal,
      (sftp, call) => sftp.uploadFile(validated.local_path, validated.remote_path, call));
  }

  /**
   * sftp_download: 从远程服务器下载文件到本地
   */
  async sftpDownload(params: SftpDownloadParams, signal?: AbortSignal) {
    const validated = SftpDownloadParamsSchema.parse(params);
    return this.runSftpOperation(validated.session_id, validated.timeout, signal,
      (sftp, call) => sftp.downloadFile(validated.remote_path, validated.local_path, call));
  }

  /**
   * sftp_read: 读取远程文件内容
   */
  async sftpRead(params: SftpReadParams, signal?: AbortSignal) {
    const validated = SftpReadParamsSchema.parse(params);
    return this.runSftpOperation(validated.session_id, validated.timeout, signal,
      async (sftp, call) => {
        const result = await sftp.readFile(validated.path, {
          ...call,
          offset: validated.offset,
          limit: validated.limit,
          encoding: validated.encoding,
        });
        return {
          path: result.path,
          content: result.content,
          size: result.size,
          offset: result.offset,
          bytes_read: result.bytesRead,
          next_offset: result.nextOffset,
          truncated: result.truncated,
          encoding: result.encoding,
        };
      });
  }

  /**
   * sftp_write: 写入内容到远程文件
   */
  async sftpWrite(params: SftpWriteParams, signal?: AbortSignal) {
    const validated = SftpWriteParamsSchema.parse(params);
    return this.runSftpOperation(validated.session_id, validated.timeout, signal,
      (sftp, call) => sftp.writeFile(validated.path, validated.content, call));
  }

  /**
   * sftp_delete: 删除远程文件或目录
   */
  async sftpDelete(params: SftpDeleteParams, signal?: AbortSignal) {
    const validated = SftpDeleteParamsSchema.parse(params);
    return this.runSftpOperation(validated.session_id, validated.timeout, signal,
      async (sftp, call) => {
        const stats = await sftp.stat(validated.path, call);
        try {
          return isDirectoryMode(stats.mode)
            ? await sftp.deleteDirectory(validated.path, call)
            : await sftp.deleteFile(validated.path, call);
        } catch (err) {
          throw markNotRetryable(err);
        }
      });
  }

  /**
   * sftp_mkdir: 创建远程目录
   */
  async sftpMkdir(params: SftpMkdirParams, signal?: AbortSignal) {
    const validated = SftpMkdirParamsSchema.parse(params);
    return this.runSftpOperation(validated.session_id, validated.timeout, signal,
      async (sftp, call) => {
        try {
          return await sftp.createDirectory(validated.path, call);
        } catch (err) {
          // 目录可能已经在远端创建成功，重试只会得到 EEXIST。
          throw markNotRetryable(err);
        }
      });
  }

  /**
   * sftp_rename: 重命名/移动远程文件
   */
  async sftpRename(params: SftpRenameParams, signal?: AbortSignal) {
    const validated = SftpRenameParamsSchema.parse(params);
    return this.runSftpOperation(validated.session_id, validated.timeout, signal,
      async (sftp, call) => {
        try {
          return await sftp.rename(validated.old_path, validated.new_path, call);
        } catch (err) {
          throw markNotRetryable(err);
        }
      });
  }

  /**
   * 清理所有会话
   */
  async cleanup(): Promise<void> {
    const sessionIds = new Set<SessionId>();
    for (const session of this.registry.listSessions()) sessionIds.add(session.sessionId);
    for (const sessionId of this.clients.keys()) sessionIds.add(sessionId);
    for (const sessionId of this.sftpClients.keys()) sessionIds.add(sessionId);
    for (const job of this.jobs.values()) sessionIds.add(job.sessionId);
    for (const sessionId of this.closingSessions) sessionIds.add(sessionId);

    const closeTasks: Array<Promise<void>> = [];
    for (const sessionId of sessionIds) {
      const { client } = this.beginSessionTeardown(sessionId);
      if (client) closeTasks.push(this.closeClientQuietly(client));
    }

    // 每个会话的拆除入口都已完成同步清理；这里只等待网络关闭。
    await Promise.allSettled(closeTasks);

    for (const sessionId of sessionIds) {
      this.finishSessionTeardown(sessionId);
    }

    // 兜底清理所有残留，重复调用 cleanup 仍然安全。
    for (const [id, job] of [...this.jobs]) {
      if (job.status === "running") {
        try { job.cancel(); } catch { /* 任务可能已经结束 */ }
      }
      this.releaseJob(job);
      this.jobs.delete(id);
    }
    this.jobs.clear();
    this.sftpInits.clear();
    this.clients.clear();
    this.sftpClients.clear();
    this.registry.clear();
    this.closingSessions.clear();
    this.sessionEpochs.clear();
    this.sftpEpochs.clear();
    this.defaultSessionId = null;
  }
}
