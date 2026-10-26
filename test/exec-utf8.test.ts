import { EventEmitter } from "events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SshClient } from "../src/services/ssh-client.js";
import { CHARACTER_LIMIT } from "../src/constants.js";

type ExecCallback = (error: Error | null, channel?: unknown) => void;

function fakeChannel() {
  const channel = new EventEmitter() as EventEmitter & {
    stderr: EventEmitter;
    eof: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
    signal: ReturnType<typeof vi.fn>;
  };
  channel.stderr = new EventEmitter();
  channel.eof = vi.fn();
  channel.close = vi.fn();
  channel.destroy = vi.fn();
  channel.signal = vi.fn();
  return channel;
}

function connectedClient(onExec?: (command: string, callback: ExecCallback) => void) {
  const client = new SshClient({
    host: "127.0.0.1",
    port: 22,
    username: "tester",
    password: "secret",
    timeout: 2000,
  });
  (client as unknown as { connected: boolean }).connected = true;
  const channel = fakeChannel();
  let calls = 0;
  const exec = vi.fn((command: string, callback: ExecCallback) => {
    calls += 1;
    if (onExec) onExec(command, callback);
    else callback(null, channel);
  });
  (client.getClient() as unknown as { exec: typeof exec }).exec = exec;
  return {
    client,
    channel,
    exec,
    execCalls: () => calls,
  };
}

function hasLoneSurrogate(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("ssh 输出解码与通道结束", () => {
  it("按字节拆分的 UTF-8 多字节字符仍能完整还原", async () => {
    const { client, channel } = connectedClient();
    const text = "A😀é𝄞中B";
    const bytes = Buffer.from(text, "utf8");
    const chunks: string[] = [];
    const pending = client.startCommand("printf", {
      timeout: 2000,
      onStdout: (chunk) => chunks.push(chunk),
    }).result;

    for (let i = 0; i < bytes.length; i++) {
      channel.emit("data", bytes.subarray(i, i + 1));
    }
    channel.emit("exit", 0);
    channel.emit("close");

    const result = await pending;
    expect(result.stdout).toBe(text);
    expect(result.stdout).not.toContain("\uFFFD");
    expect(chunks.join("")).toBe(result.stdout);
  });

  it("stdout 与 stderr 使用独立的解码器", async () => {
    const { client, channel } = connectedClient();
    const stdoutText = "😀";
    const stderrText = "é";
    const out = Buffer.from(stdoutText, "utf8");
    const err = Buffer.from(stderrText, "utf8");
    const pending = client.execCommand("cmd", 2000);

    channel.emit("data", out.subarray(0, 2));
    channel.stderr.emit("data", err.subarray(0, 1));
    channel.emit("data", out.subarray(2));
    channel.stderr.emit("data", err.subarray(1));
    channel.emit("exit", 0);
    channel.emit("close");

    const result = await pending;
    expect(result.stdout).toBe(stdoutText);
    expect(result.stderr).toBe(stderrText);
  });

  it("截断上限不会留下半个代理对", async () => {
    const { client, channel } = connectedClient();
    const fill = "a".repeat(CHARACTER_LIMIT - 1);
    const chunks: string[] = [];
    const pending = client.startCommand("fill", {
      timeout: 2000,
      onStdout: (chunk) => chunks.push(chunk),
    }).result;

    channel.emit("data", Buffer.from(fill, "utf8"));
    channel.emit("data", Buffer.from("😀", "utf8"));
    channel.emit("exit", 0);
    channel.emit("close");

    const result = await pending;
    expect(result.truncated).toBe(true);
    expect(result.stdout).toBe(fill);
    expect(result.stdout.length).toBe(CHARACTER_LIMIT - 1);
    expect(hasLoneSurrogate(result.stdout)).toBe(false);
    expect(chunks.join("")).toBe(result.stdout);
  });

  it("完整代理对刚好填满上限时保留该字符", async () => {
    const { client, channel } = connectedClient();
    const fill = "a".repeat(CHARACTER_LIMIT - 2);
    const pending = client.execCommand("fill", 2000);

    channel.emit("data", Buffer.from(fill, "utf8"));
    channel.emit("data", Buffer.from("😀", "utf8"));
    channel.emit("exit", 0);
    channel.emit("close");

    const result = await pending;
    expect(result.truncated).toBe(false);
    expect(result.stdout.length).toBe(CHARACTER_LIMIT);
    expect(result.stdout.endsWith("😀")).toBe(true);
    expect(hasLoneSurrogate(result.stdout)).toBe(false);
  });

  it("没有 exit 状态的 close 按传输中断拒绝，命令标记为已开始且不可重试", async () => {
    const { client, channel } = connectedClient();
    const pending = client.execCommand("rm important", 2000);
    channel.emit("data", Buffer.from("partial"));
    channel.emit("close");

    const error = await pending.catch((err: Error) => err);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toMatch(/exit status/i);
    expect(error).toMatchObject({
      retryable: false,
      commandStarted: true,
      cancelled: false,
    });
  });

  it("exit 事件状态为 null（信号退出）仍视为正常结束", async () => {
    const { client, channel } = connectedClient();
    const pending = client.execCommand("kill-self", 2000);

    channel.emit("exit", null, "TERM");
    channel.emit("close");

    const result = await pending;
    expect(result.exit_code).toBeNull();
    expect(result.stdout).toBe("");
  });

  it("命令结束后移除 abort 监听并清除超时计时器", async () => {
    vi.useFakeTimers();
    const { client, channel } = connectedClient();
    const controller = new AbortController();
    const removeSpy = vi.spyOn(controller.signal, "removeEventListener");
    const pending = client.execCommand("echo ok", 5000, controller.signal);

    channel.emit("exit", 0);
    channel.emit("close");
    await pending;

    expect(removeSpy).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);

    controller.abort();
    expect(channel.close).not.toHaveBeenCalled();
  });

  it("exec 同步抛错时也会清理 abort 监听和计时器", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const removeSpy = vi.spyOn(controller.signal, "removeEventListener");
    const { client } = connectedClient(() => {
      throw new Error("socket is gone");
    });

    const error = await client.execCommand("echo ok", 5000, controller.signal)
      .catch((err: Error) => err);

    expect(error.message).toContain("socket is gone");
    expect(error).toMatchObject({ retryable: true, commandStarted: false });
    expect(removeSpy).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
  });
});
