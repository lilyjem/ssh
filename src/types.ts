// 统一类型定义，后续工具与服务层复用
export type SessionId = string;

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  truncated: boolean;
}

export interface SessionInfo {
  sessionId: SessionId;
  host: string;
  port: number;
  username: string;
  createdAt: string;
  lastUsedAt: string | null;
}
