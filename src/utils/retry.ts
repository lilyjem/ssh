import { SshOperationError } from "./errors.js";

// 重试配置
export interface RetryOptions {
  // 最大尝试次数（包括首次），必须是 >= 1 的整数
  maxAttempts: number;
  // 首次重试的基础延迟（毫秒）
  baseDelay: number;
  // 最大延迟上限（毫秒），防止退避时间过长
  maxDelay: number;
  // 自定义判断是否应该重试的函数，返回 false 时立即抛出不再重试
  shouldRetry?: (error: Error) => boolean;
  // 取消信号。取消后不再开始新的尝试，退避等待也会立即结束。
  signal?: AbortSignal;
}

/** 取消错误。调用方可以检查 cancelled 而不是匹配错误文本。 */
export function createCancelledError(message = "Operation cancelled"): SshOperationError {
  return new SshOperationError(message, { retryable: false, cancelled: true });
}

/** 如果信号已经取消，抛出带 cancelled 标记的错误。 */
export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw createCancelledError();
}

/**
 * 计算第 attempt 次（从 0 开始）重试前的等待时间。
 * 先对指数退避做上限截断，再加 ±25% 抖动，最后再次以 maxDelay 封顶。
 */
export function computeRetryDelay(
  baseDelay: number,
  maxDelay: number,
  attempt: number,
  random: number = Math.random()
): number {
  const exponentialDelay = baseDelay * Math.pow(2, attempt);
  const cappedDelay = Math.min(exponentialDelay, maxDelay);
  const jittered = cappedDelay * (0.75 + random * 0.5);
  return Math.max(0, Math.floor(Math.min(jittered, maxDelay)));
}

/**
 * 异步等待指定毫秒数。传入 signal 时，取消会立即结束等待并抛出 cancelled 错误。
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(createCancelledError());

  return new Promise((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (err) reject(err);
      else resolve();
    };
    const onAbort = () => finish(createCancelledError());
    timer = setTimeout(() => finish(), ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * 带指数退避的重试包装器。
 * maxAttempts 包含首次尝试；maxAttempts=1 表示绝不重试。
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions
): Promise<T> {
  const { maxAttempts, baseDelay, maxDelay, shouldRetry, signal } = options;

  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error("maxAttempts must be a finite integer >= 1");
  }
  if (!Number.isFinite(baseDelay) || baseDelay < 0) {
    throw new Error("baseDelay must be a finite number >= 0");
  }
  if (!Number.isFinite(maxDelay) || maxDelay < 0) {
    throw new Error("maxDelay must be a finite number >= 0");
  }

  let lastError: Error | undefined;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    throwIfAborted(signal);

    try {
      return await fn();
    } catch (err) {
      lastError = err as Error;

      // 取消优先于重试判定，避免在退避或错误处理期间又发起新尝试。
      // 保留操作自身已标记的取消错误（例如 commandStarted / waiterOnly），
      // 不要把 typed 取消改写成信息更少的通用错误。
      if (signal?.aborted) {
        if ((lastError as Partial<SshOperationError>).cancelled === true) {
          throw lastError;
        }
        throw createCancelledError();
      }

      // 检查是否应该重试
      if (shouldRetry && !shouldRetry(lastError)) {
        throw lastError;
      }

      // 最后一次尝试失败，不再等待
      if (attempt === maxAttempts - 1) {
        break;
      }

      await sleep(computeRetryDelay(baseDelay, maxDelay, attempt), signal);
    }
  }

  throw lastError!;
}
