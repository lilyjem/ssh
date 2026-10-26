import { randomUUID } from "crypto";
import { z } from "zod";
import { SessionRegistry } from "../services/session-registry.js";
import { SshClient, type SshClientConfig } from "../services/ssh-client.js";
import { SftpClient, isDirectoryMode } from "../services/sftp-client.js";
import { sanitizeCommand } from "../utils/validation.js";
import { withRetry } from "../utils/retry.js";
import { markNotRetryable, SshOperationError } from "../utils/errors.js";
import {
  CHARACTER_LIMIT,
  DEFAULT_MAX_RECONNECT_ATTEMPTS,
  DEFAULT_RECONNECT_BASE_DELAY,
  DEFAULT_RECONNECT_MAX_DELAY,
} from "../constants.js";
import type { ExecResult, SessionId, SessionInfo } from "../types.js";
import type { GlobalConfig } from "../config.js";

import { log } from "../utils/log.js";

// ============ Zod Schemas 用于参数校验 ============

const sessionIdField = z.string().optional()
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
  status: ExecJobView["status"];
  stdout: string;
  stderr: string;
  exitCode: number | null;
  truncated: boolean;
  cancel: () => void;
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
   * 如果未提供 session_id，则使用默认会话
   */
  private getEffectiveSessionId(sessionId?: SessionId): SessionId {
    if (sessionId) {
      return sessionId;
    }
    if (this.defaultSessionId) {
      return this.defaultSessionId;
    }
    throw new Error("No session_id provided and no default session available. Please connect first or configure server in environment variables.");
  }

  /**
   * 判断错误是否为连接相关错误（应该触发重连重试）
   * 认证错误、参数错误等不重试
   */
  shouldRetryOperation(error: Error): boolean {
    const marked = error as Partial<SshOperationError>;
    // 显式标记优先于文本匹配，避免认证失败或已开始的命令被当成可重试连接错误。
    if (marked.retryable === false || marked.commandStarted || marked.timedOut) return false;
    if (marked.level === "client-authentication") return false;

    const blocked = [
      "All configured authentication methods failed",
      "Host denied",
      "verification failed",
      "host key",
      "Command execution timeout",
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

  /**
   * 清理指定会话的 SFTP 客户端缓存
   * 在连接断开或重连后调用
   */
  invalidateSftpClient(sessionId: SessionId): void {
    const sftpClient = this.sftpClients.get(sessionId);
    if (sftpClient) {
      try {
        sftpClient.close();
      } catch {
        // 忽略关闭错误
      }
      this.sftpClients.delete(sessionId);
    }
  }

  /**
   * 确保连接存活，必要时自动重连
   */
  private async ensureConnected(sessionId: SessionId): Promise<void> {
    const client = this.clients.get(sessionId);
    if (!client) {
      throw new Error(`Client not found for session: ${sessionId}`);
    }

    if (!client.isAlive()) {
      log(`Session ${sessionId} is not alive, attempting reconnect...`);
      this.invalidateSftpClient(sessionId);
      await client.reconnect();
      log(`Session ${sessionId} reconnected successfully`);
    }
  }

  /**
   * 带自动重连和重试的操作执行器
   * 连接断开时自动重连，操作失败时按指数退避重试
   */
  private async withAutoReconnect<T>(
    sessionId: SessionId,
    operation: () => Promise<T>
  ): Promise<T> {
    const maxAttempts = this.globalConfig.maxReconnectAttempts ?? DEFAULT_MAX_RECONNECT_ATTEMPTS;
    const baseDelay = this.globalConfig.reconnectBaseDelay ?? DEFAULT_RECONNECT_BASE_DELAY;
    const maxDelay = this.globalConfig.reconnectMaxDelay ?? DEFAULT_RECONNECT_MAX_DELAY;

    return withRetry(
      async () => {
        await this.ensureConnected(sessionId);
        return await operation();
      },
      {
        maxAttempts,
        baseDelay,
        maxDelay,
        shouldRetry: (err) => this.shouldRetryOperation(err),
      }
    );
  }

  /**
   * 获取或创建 SFTP 客户端
   */
  private async getSftpClient(sessionId: SessionId): Promise<SftpClient> {
    // 先确保 SSH 连接存活
    await this.ensureConnected(sessionId);

    let sftpClient = this.sftpClients.get(sessionId);
    if (sftpClient) {
      return sftpClient;
    }

    const sshClient = this.clients.get(sessionId);
    if (!sshClient) {
      throw new Error(`Client not found for session: ${sessionId}`);
    }

    sftpClient = new SftpClient(sshClient.getClient(), {
      timeout: this.globalConfig.sftpTimeout,
    });
    await sftpClient.init();
    this.sftpClients.set(sessionId, sftpClient);

    return sftpClient;
  }

  /**
   * 执行 SFTP 操作。超时或取消后丢掉当前 SFTP 会话，下次重新打开。
   */
  private async performSftp<T>(sessionId: SessionId, run: (sftp: SftpClient) => Promise<T>): Promise<T> {
    try {
      return await this.withAutoReconnect(sessionId, async () => {
        const sftp = await this.getSftpClient(sessionId);
        return await run(sftp);
      });
    } catch (err) {
      const marked = err as Partial<SshOperationError>;
      if (marked.timedOut || /cancelled/i.test((err as Error).message)) {
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
    run: (sftp: SftpClient, call: { timeout?: number; signal?: AbortSignal }) => Promise<T>
  ): Promise<T> {
    const effectiveSessionId = this.getEffectiveSessionId(sessionId);
    this.registry.touchSession(effectiveSessionId);
    const call = { timeout, signal };
    return this.performSftp(effectiveSessionId, (sftp) => run(sftp, call));
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
      throw new Error(`Failed to connect: ${(err as Error).message}`);
    }

    // 注册会话
    const session = this.registry.createSession({
      host: validated.host,
      port: validated.port,
      username: validated.username,
    });

    // 保存客户端实例
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

    const command = sanitizeCommand(validated.command);
    this.registry.touchSession(sessionId);

    if (validated.background) {
      await this.ensureConnected(sessionId);
      return this.startBackground(sessionId, command, validated.timeout, signal);
    }

    return this.withAutoReconnect(sessionId, async () => {
      const client = this.clients.get(sessionId);
      if (!client) {
        throw new Error(`Client not found for session: ${sessionId}`);
      }
      return client.execCommand(command, validated.timeout, signal);
    });
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
    const client = this.clients.get(sessionId);
    if (!client) {
      throw new Error(`Client not found for session: ${sessionId}`);
    }
    const job: ExecJob = {
      id: randomUUID(),
      status: "running",
      stdout: "",
      stderr: "",
      exitCode: null,
      truncated: false,
      cancel: () => {},
    };
    const handle = client.startCommand(command, {
      timeout,
      signal,
      onStdout: (chunk) => this.appendJobOutput(job, "stdout", chunk),
      onStderr: (chunk) => this.appendJobOutput(job, "stderr", chunk),
    });
    job.cancel = () => {
      if (job.status !== "running") return;
      job.status = "cancelled";
      handle.cancel();
    };
    this.jobs.set(job.id, job);
    handle.result.then(
      (result) => {
        if (job.status !== "running") return;
        job.status = "exited";
        job.exitCode = result.exit_code;
        job.truncated = job.truncated || result.truncated;
      },
      () => {
        if (job.status === "running") job.status = "failed";
      }
    );
    return { background: true, job_id: job.id, status: "running" };
  }

  /** 读取后台任务的当前输出和状态。 */
  async pollExec(params: z.infer<typeof PollExecParamsSchema>): Promise<ExecJobView> {
    const validated = PollExecParamsSchema.parse(params);
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
    const job = this.jobs.get(validated.job_id);
    if (!job) throw new Error(`Job not found: ${validated.job_id}`);
    job.cancel();
    return { job_id: job.id, status: job.status };
  }

  private appendJobOutput(job: ExecJob, field: "stdout" | "stderr", chunk: string): void {
    const current = job[field];
    if (current.length >= CHARACTER_LIMIT) {
      job.truncated = true;
      return;
    }
    const room = CHARACTER_LIMIT - current.length;
    job[field] += chunk.slice(0, room);
    if (chunk.length > room) job.truncated = true;
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
   * ssh_disconnect: 断开指定会话
   */
  async disconnect(params: DisconnectParams): Promise<DisconnectResult> {
    const validated = DisconnectParamsSchema.parse(params);
    const sessionId = this.getEffectiveSessionId(validated.session_id);

    // 获取会话
    const session = this.registry.getSession(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    // 关闭 SFTP 客户端
    const sftpClient = this.sftpClients.get(sessionId);
    if (sftpClient) {
      sftpClient.close();
      this.sftpClients.delete(sessionId);
    }

    // 关闭 SSH 客户端
    const client = this.clients.get(sessionId);
    if (client) {
      await client.close();
      this.clients.delete(sessionId);
    }

    // 移除会话
    this.registry.removeSession(sessionId);

    // 如果断开的是默认会话，清除默认会话 ID
    if (sessionId === this.defaultSessionId) {
      this.defaultSessionId = null;
    }

    return {
      success: true,
      message: `Disconnected from ${session.username}@${session.host}:${session.port}`,
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
    for (const job of this.jobs.values()) {
      try { job.cancel(); } catch { /* 任务可能已经结束 */ }
    }
    this.jobs.clear();
    const sessions = this.registry.listSessions();

    for (const session of sessions) {
      // 关闭 SFTP 客户端
      const sftpClient = this.sftpClients.get(session.sessionId);
      if (sftpClient) {
        try {
          sftpClient.close();
        } catch {
          // 忽略关闭错误
        }
        this.sftpClients.delete(session.sessionId);
      }

      // 关闭 SSH 客户端
      const client = this.clients.get(session.sessionId);
      if (client) {
        try {
          await client.close();
        } catch {
          // 忽略关闭错误
        }
        this.clients.delete(session.sessionId);
      }

      this.registry.removeSession(session.sessionId);
    }

    this.defaultSessionId = null;
  }
}
