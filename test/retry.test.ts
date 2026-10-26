import { describe, it, expect, vi } from "vitest";
import { computeRetryDelay, withRetry, sleep } from "../src/utils/retry.js";

describe("sleep", () => {
  it("等待指定毫秒数", async () => {
    const start = Date.now();
    await sleep(100);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(90);
    expect(elapsed).toBeLessThan(300);
  });
});

describe("withRetry", () => {
  it("第一次成功时不重试", async () => {
    const fn = vi.fn().mockResolvedValue("ok");

    const result = await withRetry(fn, {
      maxAttempts: 3,
      baseDelay: 10,
      maxDelay: 100,
    });

    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("失败后重试直到成功", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("fail 1"))
      .mockRejectedValueOnce(new Error("fail 2"))
      .mockResolvedValue("ok");

    const result = await withRetry(fn, {
      maxAttempts: 3,
      baseDelay: 10,
      maxDelay: 100,
    });

    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("所有重试都失败时抛出最后一个错误", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("fail 1"))
      .mockRejectedValueOnce(new Error("fail 2"))
      .mockRejectedValue(new Error("fail 3"));

    await expect(
      withRetry(fn, {
        maxAttempts: 3,
        baseDelay: 10,
        maxDelay: 100,
      })
    ).rejects.toThrow("fail 3");

    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("shouldRetry 返回 false 时立即抛出", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("auth failed"));

    await expect(
      withRetry(fn, {
        maxAttempts: 3,
        baseDelay: 10,
        maxDelay: 100,
        shouldRetry: (err) => !err.message.includes("auth"),
      })
    ).rejects.toThrow("auth failed");

    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("退避延迟递增但不超过 maxDelay", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("fail"))
      .mockRejectedValueOnce(new Error("fail"))
      .mockResolvedValue("ok");

    const start = Date.now();
    await withRetry(fn, {
      maxAttempts: 3,
      baseDelay: 50,
      maxDelay: 80,
    });
    const elapsed = Date.now() - start;

    // 第 1 次重试延迟 ~50ms（含抖动），第 2 次延迟 ~80ms（被 maxDelay 截断，含抖动）
    // 总耗时应在合理范围内
    expect(elapsed).toBeGreaterThanOrEqual(50);
    expect(elapsed).toBeLessThan(500);
  });
});

describe("withRetry 参数边界", () => {
  it.each([0, -1, 1.5, NaN, Infinity, -Infinity])(
    "maxAttempts=%s 明确拒绝且不执行操作",
    async (maxAttempts) => {
      const fn = vi.fn().mockResolvedValue("ok");
      await expect(
        withRetry(fn, { maxAttempts, baseDelay: 1, maxDelay: 1 })
      ).rejects.toThrow(/maxAttempts/);
      expect(fn).not.toHaveBeenCalled();
    }
  );

  it("maxAttempts 包含首次尝试，1 表示不重试", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("boom"));
    await expect(
      withRetry(fn, { maxAttempts: 1, baseDelay: 1, maxDelay: 1 })
    ).rejects.toThrow("boom");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("maxAttempts=2 表示首次加一次重试", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("boom"));
    await expect(
      withRetry(fn, { maxAttempts: 2, baseDelay: 1, maxDelay: 1 })
    ).rejects.toThrow("boom");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("拒绝负数或非有限延迟", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    await expect(
      withRetry(fn, { maxAttempts: 2, baseDelay: -1, maxDelay: 10 })
    ).rejects.toThrow(/baseDelay/);
    await expect(
      withRetry(fn, { maxAttempts: 2, baseDelay: 10, maxDelay: NaN })
    ).rejects.toThrow(/maxDelay/);
  });
});

describe("withRetry 取消", () => {
  it("开始前已经取消时不执行操作", async () => {
    const controller = new AbortController();
    controller.abort();
    const fn = vi.fn().mockResolvedValue("ok");

    const error = await withRetry(fn, {
      maxAttempts: 5,
      baseDelay: 5,
      maxDelay: 10,
      signal: controller.signal,
    }).catch((err: Error) => err);

    expect((error as { cancelled?: boolean }).cancelled).toBe(true);
    expect(fn).not.toHaveBeenCalled();
  });

  it("退避等待中取消后不再发起后续尝试", async () => {
    const controller = new AbortController();
    const fn = vi.fn().mockRejectedValue(new Error("fail"));
    const pending = withRetry(fn, {
      maxAttempts: 5,
      baseDelay: 60,
      maxDelay: 60,
      signal: controller.signal,
    });

    await sleep(10);
    controller.abort();
    const error = await pending.catch((err: Error) => err);

    expect((error as { cancelled?: boolean }).cancelled).toBe(true);
    expect(fn).toHaveBeenCalledTimes(1);

    // 等过原本的重试窗口，确认取消后不会偷偷再尝试。
    await sleep(150);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe("computeRetryDelay", () => {
  it("抖动加完后再以 maxDelay 封顶", () => {
    for (const random of [0, 0.5, 0.999, 1]) {
      expect(computeRetryDelay(100, 100, 0, random)).toBeLessThanOrEqual(100);
      expect(computeRetryDelay(1000, 100, 0, random)).toBeLessThanOrEqual(100);
      expect(computeRetryDelay(1000, 100, 3, random)).toBeLessThanOrEqual(100);
    }
    expect(computeRetryDelay(100, 1000, 0, 1)).toBe(125);
    expect(computeRetryDelay(0, 1000, 0, 1)).toBe(0);
  });
});
