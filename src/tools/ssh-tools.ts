import { z } from "zod";
import { SessionRegistry } from "../services/session-registry.js";
import { SshClient, type SshClientConfig } from "../services/ssh-client.js";
import { SftpClient } from "../services/sftp-client.js";
import { sanitizeCommand } from "../utils/validation.js";
import type { SessionInfo } from "../types.js";
import type { ServerConfig, GlobalConfig } from "../config.js";

// ============ Zod Schemas 用于参数校验 ============

// 连接参数 Schema
export const ConnectParamsSchema = z.object({
  host: z.string().min(1, "host is required"),
  port: z.number().int().min(1).max(65535).default(22),
  username: z.string().min(1, "username is required"),
  password: z.string().optional(),
  private_key: z.string().optional(),
  private_key_path: z.string().optional(),
  passphrase: z.string().optional(),
  timeout: z.number().int().min(1000).max(300000).optional(),
  connect_timeout: z.number().int().min(1000).max(60000).optional(),
});

// 执行命令参数 Schema（支持无 session_id 时使用默认连接）
export const ExecParamsSchema = z.object({
  session_id: z.string().optional(),
  command: z.string().min(1, "command is required"),
  timeout: z.number().int().min(1000).max(300000).optional(),
});

// 断开连接参数 Schema
export const DisconnectParamsSchema = z.object({
  session_id: z.string().optional(),
});

// SFTP 列表参数 Schema
export const SftpListParamsSchema = z.object({
  session_id: z.string().optional(),
  path: z.string().default("/"),
});

// SFTP 上传参数 Schema
export const SftpUploadParamsSchema = z.object({
  session_id: z.string().optional(),
  local_path: z.string().min(1, "local_path is required"),
  remote_path: z.string().min(1, "remote_path is required"),
});

// SFTP 下载参数 Schema
export const SftpDownloadParamsSchema = z.object({
  session_id: z.string().optional(),
  remote_path: z.string().min(1, "remote_path is required"),
  local_path: z.string().min(1, "local_path is required"),
});

// SFTP 读取文件参数 Schema
export const SftpReadParamsSchema = z.object({
  session_id: z.string().optional(),
  path: z.string().min(1, "path is required"),
});

// SFTP 写入文件参数 Schema
export const SftpWriteParamsSchema = z.object({
  session_id: z.string().optional(),
  path: z.string().min(1, "path is required"),
  content: z.string(),
});

// SFTP 删除参数 Schema
export const SftpDeleteParamsSchema = z.object({
  session_id: z.string().optional(),
  path: z.string().min(1, "path is required"),
  recursive: z.boolean().default(false),
});

// SFTP 创建目录参数 Schema
export const SftpMkdirParamsSchema = z.object({
  session_id: z.string().optional(),
  path: z.string().min(1, "path is required"),
});

// SFTP 重命名参数 Schema
export const SftpRenameParamsSchema = z.object({
  session_id: z.string().optional(),
  old_path: z.string().min(1, "old_path is required"),
  new_path: z.string().min(1, "new_path is required"),
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
  session_id: string;
  message: string;
}

// 执行结果
export interface ExecResult {
  stdout: string;
  stderr: string;
  exit_code: number | null;
  truncated: boolean;
}

// 列表结果
export interface ListSessionsResult {
  sessions: Array<{
    session_id: string;
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
  private clients: Map<string, SshClient> = new Map();
  private sftpClients: Map<string, SftpClient> = new Map();
  private globalConfig: GlobalConfig;
  private defaultSessionId: string | null = null;

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
  private getEffectiveSessionId(sessionId?: string): string {
    if (sessionId) {
      return sessionId;
    }
    if (this.defaultSessionId) {
      return this.defaultSessionId;
    }
    throw new Error("No session_id provided and no default session available. Please connect first or configure server in environment variables.");
  }

  /**
   * 获取或创建 SFTP 客户端
   */
  private async getSftpClient(sessionId: string): Promise<SftpClient> {
    // 检查是否已有 SFTP 客户端
    let sftpClient = this.sftpClients.get(sessionId);
    if (sftpClient) {
      return sftpClient;
    }

    // 获取 SSH 客户端
    const sshClient = this.clients.get(sessionId);
    if (!sshClient) {
      throw new Error(`Client not found for session: ${sessionId}`);
    }

    // 创建新的 SFTP 客户端
    sftpClient = new SftpClient(sshClient.getClient());
    await sftpClient.init();
    this.sftpClients.set(sessionId, sftpClient);

    return sftpClient;
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
      timeout: validated.timeout,
      connectTimeout: validated.connect_timeout,
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
      client: client.getClient(),
    });

    // 保存客户端实例
    this.clients.set(session.sessionId, client);

    return {
      session_id: session.sessionId,
      message: `Connected to ${validated.username}@${validated.host}:${validated.port}`,
    };
  }

  /**
   * ssh_exec: 在指定会话中执行命令
   */
  async exec(params: ExecParams): Promise<ExecResult> {
    const validated = ExecParamsSchema.parse(params);
    const sessionId = this.getEffectiveSessionId(validated.session_id);

    // 获取会话
    const session = this.registry.getSession(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    // 获取客户端
    const client = this.clients.get(sessionId);
    if (!client) {
      throw new Error(`Client not found for session: ${sessionId}`);
    }

    // 校验命令
    const command = sanitizeCommand(validated.command);

    // 更新会话最后使用时间
    this.registry.touchSession(sessionId);

    // 执行命令
    const result = await client.execCommand(command);

    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exit_code: result.exitCode,
      truncated: result.truncated,
    };
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
  async sftpList(params: SftpListParams) {
    const validated = SftpListParamsSchema.parse(params);
    const sessionId = this.getEffectiveSessionId(validated.session_id);
    const sftpClient = await this.getSftpClient(sessionId);

    this.registry.touchSession(sessionId);
    return await sftpClient.listDirectory(validated.path);
  }

  /**
   * sftp_upload: 上传本地文件到远程服务器
   */
  async sftpUpload(params: SftpUploadParams) {
    const validated = SftpUploadParamsSchema.parse(params);
    const sessionId = this.getEffectiveSessionId(validated.session_id);
    const sftpClient = await this.getSftpClient(sessionId);

    this.registry.touchSession(sessionId);
    return await sftpClient.uploadFile(validated.local_path, validated.remote_path);
  }

  /**
   * sftp_download: 从远程服务器下载文件到本地
   */
  async sftpDownload(params: SftpDownloadParams) {
    const validated = SftpDownloadParamsSchema.parse(params);
    const sessionId = this.getEffectiveSessionId(validated.session_id);
    const sftpClient = await this.getSftpClient(sessionId);

    this.registry.touchSession(sessionId);
    return await sftpClient.downloadFile(validated.remote_path, validated.local_path);
  }

  /**
   * sftp_read: 读取远程文件内容
   */
  async sftpRead(params: SftpReadParams) {
    const validated = SftpReadParamsSchema.parse(params);
    const sessionId = this.getEffectiveSessionId(validated.session_id);
    const sftpClient = await this.getSftpClient(sessionId);

    this.registry.touchSession(sessionId);
    return await sftpClient.readFile(validated.path);
  }

  /**
   * sftp_write: 写入内容到远程文件
   */
  async sftpWrite(params: SftpWriteParams) {
    const validated = SftpWriteParamsSchema.parse(params);
    const sessionId = this.getEffectiveSessionId(validated.session_id);
    const sftpClient = await this.getSftpClient(sessionId);

    this.registry.touchSession(sessionId);
    return await sftpClient.writeFile(validated.path, validated.content);
  }

  /**
   * sftp_delete: 删除远程文件或目录
   */
  async sftpDelete(params: SftpDeleteParams) {
    const validated = SftpDeleteParamsSchema.parse(params);
    const sessionId = this.getEffectiveSessionId(validated.session_id);
    const sftpClient = await this.getSftpClient(sessionId);

    this.registry.touchSession(sessionId);

    // 检查是文件还是目录
    const stats = await sftpClient.stat(validated.path);
    const isDirectory = (stats.mode & 0o40000) !== 0;

    if (isDirectory) {
      return await sftpClient.deleteDirectory(validated.path);
    } else {
      return await sftpClient.deleteFile(validated.path);
    }
  }

  /**
   * sftp_mkdir: 创建远程目录
   */
  async sftpMkdir(params: SftpMkdirParams) {
    const validated = SftpMkdirParamsSchema.parse(params);
    const sessionId = this.getEffectiveSessionId(validated.session_id);
    const sftpClient = await this.getSftpClient(sessionId);

    this.registry.touchSession(sessionId);
    return await sftpClient.createDirectory(validated.path);
  }

  /**
   * sftp_rename: 重命名/移动远程文件
   */
  async sftpRename(params: SftpRenameParams) {
    const validated = SftpRenameParamsSchema.parse(params);
    const sessionId = this.getEffectiveSessionId(validated.session_id);
    const sftpClient = await this.getSftpClient(sessionId);

    this.registry.touchSession(sessionId);
    return await sftpClient.rename(validated.old_path, validated.new_path);
  }

  /**
   * 获取默认会话 ID
   */
  getDefaultSessionId(): string | null {
    return this.defaultSessionId;
  }

  /**
   * 检查是否有活跃连接
   */
  hasActiveConnection(): boolean {
    return this.registry.size > 0;
  }

  /**
   * 清理所有会话
   */
  async cleanup(): Promise<void> {
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
