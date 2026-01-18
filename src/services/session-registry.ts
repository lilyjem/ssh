import { randomUUID } from "crypto";
import type { SessionId, SessionInfo } from "../types.js";
import type { Client } from "ssh2";

// 会话记录，包含连接信息和 SSH 客户端实例
export interface SessionRecord {
  sessionId: SessionId;
  host: string;
  port: number;
  username: string;
  client: Client | unknown; // 允许测试时传入 mock 对象
  createdAt: Date;
  lastUsedAt: Date | null;
}

// 创建会话所需的参数
export interface CreateSessionParams {
  host: string;
  port: number;
  username: string;
  client: Client | unknown;
}

/**
 * 会话注册表
 * 管理所有活跃的 SSH 会话，提供增删查功能
 */
export class SessionRegistry {
  // 使用 Map 存储会话，key 为 sessionId
  private sessions: Map<SessionId, SessionRecord> = new Map();

  /**
   * 创建新会话并注册
   * @param params 会话参数（host、port、username、client）
   * @returns 创建的会话记录
   */
  createSession(params: CreateSessionParams): SessionRecord {
    const sessionId = randomUUID();
    const now = new Date();

    const record: SessionRecord = {
      sessionId,
      host: params.host,
      port: params.port,
      username: params.username,
      client: params.client,
      createdAt: now,
      lastUsedAt: null,
    };

    this.sessions.set(sessionId, record);
    return record;
  }

  /**
   * 根据 sessionId 获取会话记录
   * @param sessionId 会话 ID
   * @returns 会话记录，不存在则返回 undefined
   */
  getSession(sessionId: SessionId): SessionRecord | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * 列出所有会话的基本信息（不包含 client 实例）
   * @returns 会话信息数组
   */
  listSessions(): SessionInfo[] {
    const result: SessionInfo[] = [];

    for (const record of this.sessions.values()) {
      result.push({
        sessionId: record.sessionId,
        host: record.host,
        port: record.port,
        username: record.username,
        createdAt: record.createdAt.toISOString(),
        lastUsedAt: record.lastUsedAt?.toISOString() ?? null,
      });
    }

    return result;
  }

  /**
   * 移除指定会话
   * @param sessionId 会话 ID
   * @returns 被移除的会话记录，不存在则返回 undefined
   */
  removeSession(sessionId: SessionId): SessionRecord | undefined {
    const record = this.sessions.get(sessionId);
    if (record) {
      this.sessions.delete(sessionId);
    }
    return record;
  }

  /**
   * 更新会话的最后使用时间
   * @param sessionId 会话 ID
   */
  touchSession(sessionId: SessionId): void {
    const record = this.sessions.get(sessionId);
    if (record) {
      record.lastUsedAt = new Date();
    }
  }

  /**
   * 清空所有会话（用于清理资源）
   */
  clear(): void {
    this.sessions.clear();
  }

  /**
   * 获取当前会话数量
   */
  get size(): number {
    return this.sessions.size;
  }
}
