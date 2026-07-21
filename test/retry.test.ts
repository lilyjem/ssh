import { describe, it, expect, vi } from "vitest";
import { withRetry, sleep } from "../src/utils/retry.js";

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
