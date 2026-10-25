/**
 * SSH 操作错误。
 * retryable / commandStarted / timedOut 供重试策略使用，避免再靠错误文本猜测能否安全重试。
 */
export class SshOperationError extends Error {
  retryable: boolean;
  commandStarted: boolean;
  timedOut: boolean;
  level?: string;
  code?: string | number;

  constructor(
    message: string,
    init: {
      retryable?: boolean;
      commandStarted?: boolean;
      timedOut?: boolean;
      level?: string;
      code?: string | number;
    } = {}
  ) {
    super(message);
    this.name = "SshOperationError";
    this.retryable = init.retryable ?? true;
    this.commandStarted = init.commandStarted ?? false;
    this.timedOut = init.timedOut ?? false;
    this.level = init.level;
    this.code = init.code;
  }
}

/** 命令或写操作已经发出时，禁止再次执行。 */
export function markNotRetryable(error: unknown): Error {
  const err = error instanceof Error ? error : new Error(String(error));
  const marked = err as SshOperationError;
  marked.retryable = false;
  marked.commandStarted = true;
  return err;
}
