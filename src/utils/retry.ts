// 重试配置
export interface RetryOptions {
  // 最大尝试次数（包括首次）
  maxAttempts: number;
  // 首次重试的基础延迟（毫秒）
  baseDelay: number;
  // 最大延迟上限（毫秒），防止退避时间过长
  maxDelay: number;
  // 自定义判断是否应该重试的函数，返回 false 时立即抛出不再重试
  shouldRetry?: (error: Error) => boolean;
}

/**
 * 异步等待指定毫秒数
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 带指数退避的重试包装器
 * 每次重试的延迟 = min(baseDelay * 2^attempt, maxDelay) + 随机抖动
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions
): Promise<T> {
  const { maxAttempts, baseDelay, maxDelay, shouldRetry } = options;
  let lastError: Error | undefined;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err as Error;

      // 检查是否应该重试
      if (shouldRetry && !shouldRetry(lastError)) {
        throw lastError;
      }

      // 最后一次尝试失败，不再等待
      if (attempt === maxAttempts - 1) {
        break;
      }

      // 计算退避延迟：指数增长 + 随机抖动（±25%）
      const exponentialDelay = baseDelay * Math.pow(2, attempt);
      const cappedDelay = Math.min(exponentialDelay, maxDelay);
      const jitter = cappedDelay * (0.75 + Math.random() * 0.5);
      await sleep(Math.floor(jitter));
    }
  }

  throw lastError!;
}
