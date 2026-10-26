/**
 * SSH 操作错误。
 * retryable / commandStarted / timedOut / cancelled 供重试和清理策略使用。
 */
export class SshOperationError extends Error {
  retryable: boolean;
  commandStarted: boolean;
  timedOut: boolean;
  cancelled: boolean;
  level?: string;

  constructor(
    message: string,
    init: {
      retryable?: boolean;
      commandStarted?: boolean;
      timedOut?: boolean;
      cancelled?: boolean;
      level?: string;
    } = {}
  ) {
    super(message);
    this.name = "SshOperationError";
    this.retryable = init.retryable ?? true;
    this.commandStarted = init.commandStarted ?? false;
    this.timedOut = init.timedOut ?? false;
    this.cancelled = init.cancelled ?? false;
    this.level = init.level;
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
