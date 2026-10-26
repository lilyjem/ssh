import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { Client, SFTPWrapper } from "ssh2";
import { Writable } from "stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SftpClient } from "../src/services/sftp-client.js";
import type { SshOperationError } from "../src/utils/errors.js";

type WriteCallback = (error?: Error | null) => void;

/** 只有测试显式 ack 才完成 _write 的 Writable，模拟等待远端 WRITE 确认。 */
class AckWriteStream extends Writable {
  readonly chunks: Buffer[] = [];
  readonly pending: WriteCallback[] = [];
  holdClose = false;
  private finalCallback: WriteCallback | null = null;

  constructor() {
    super({ autoDestroy: true, emitClose: true });
  }

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: WriteCallback): void {
    this.chunks.push(Buffer.from(chunk));
    this.pending.push(callback);
  }

  override _final(callback: WriteCallback): void {
    this.finalCallback = callback;
    this.maybeFinish();
  }

  ackNext(): void {
    const callback = this.pending.shift();
    if (!callback) throw new Error("没有待确认的 write");
    callback(null);
    this.maybeFinish();
  }

  releaseFinal(): void {
    this.holdClose = false;
    this.maybeFinish();
  }

  private maybeFinish(): void {
    if (!this.finalCallback || this.pending.length > 0 || this.holdClose) return;
    const callback = this.finalCallback;
    this.finalCallback = null;
    callback(null);
  }
}

function makeSetup() {
  const files = new Map([["/data.txt", Buffer.from("ORIGINAL")]]);
  const streams = new Map<string, AckWriteStream>();
  const wrapper = {
    end: vi.fn(),
    createWriteStream: (path: string) => {
      const stream = new AckWriteStream();
      streams.set(path, stream);
      return stream;
    },
    stat: (path: string, callback: (err: Error | null, attrs: { size: number }) => void) => {
      const stream = streams.get(path);
      const data = stream ? Buffer.concat(stream.chunks) : files.get(path);
      if (!data) callback(new Error("No such file"), { size: 0 });
      else callback(null, { size: data.length });
    },
    ext_openssh_rename: (from: string, to: string, callback: (err?: Error | null) => void) => {
      const stream = streams.get(from);
      const data = stream ? Buffer.concat(stream.chunks) : files.get(from);
      if (!data) {
        callback(new Error("No such file"));
        return;
      }
      files.set(to, data);
      streams.delete(from);
      callback(null);
    },
    rename: vi.fn(),
    unlink: vi.fn((path: string, callback: (err?: Error | null) => void) => {
      files.delete(path);
      streams.delete(path);
      callback(null);
    }),
  };
  const client = new SftpClient({
    sftp: (callback: (err: Error | null, sftp: SFTPWrapper) => void) => {
      callback(null, wrapper as unknown as SFTPWrapper);
    },
  } as unknown as Client);
  return { client, files, streams, wrapper };
}

async function waitFor(predicate: () => boolean, attempts = 200): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("等待上传流状态超时");
}

function waitForStream(streams: Map<string, AckWriteStream>): Promise<AckWriteStream> {
  return waitFor(() => streams.size > 0).then(() => [...streams.values()][0]);
}

describe("SFTP 上传无进展超时使用 WRITE 确认", () => {
  const dirs: string[] = [];

  function makeLocal(content: string | Buffer): string {
    const dir = mkdtempSync(join(tmpdir(), "ssh-mcp-upload-progress-"));
    dirs.push(dir);
    const file = join(dir, "upload.txt");
    writeFileSync(file, content);
    return file;
  }

  afterEach(() => {
    vi.useRealTimers();
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    dirs.length = 0;
  });

  it("远端 ack 会延长 deadline，超过原始 timeout 后仍存活并最终成功", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const local = makeLocal("uploaded-content");
    const setup = makeSetup();
    await setup.client.init();

    let settled = false;
    const outcome = setup.client.uploadFile(local, "/data.txt", { timeout: 100 }).then(
      () => {
        settled = true;
        return null;
      },
      (error: Error) => {
        settled = true;
        return error;
      }
    );

    const stream = await waitForStream(setup.streams);
    await waitFor(() => stream.pending.length === 1);
    stream.holdClose = true;
    await vi.advanceTimersByTimeAsync(90);
    expect(settled).toBe(false);

    // 第 90ms 收到 WRITE 确认，deadline 应从确认时刻重新计时。
    stream.ackNext();
    expect(stream.pending).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(50);
    expect(settled).toBe(false);

    // 放开 end/close，上传应正常完成，证明确认没有破坏 pipe。
    stream.releaseFinal();
    await waitFor(() => settled);
    const result = await outcome;
    expect(result).toBeNull();
    expect(setup.files.get("/data.txt")?.toString()).toBe("uploaded-content");
  });

  it("没有 WRITE 确认时按 timeout 失败并保留原目标", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const local = makeLocal("NEW-CONTENT");
    const setup = makeSetup();
    await setup.client.init();

    const outcome = setup.client.uploadFile(local, "/data.txt", { timeout: 100 }).then(
      () => null,
      (error: Error) => error as SshOperationError
    );

    const stream = await waitForStream(setup.streams);
    await waitFor(() => stream.pending.length === 1);
    await vi.advanceTimersByTimeAsync(100);
    const error = await outcome;

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/SFTP timeout after 100ms/);
    expect((error as SshOperationError).timedOut).toBe(true);
    expect((error as SshOperationError).retryable).toBe(false);
    expect(setup.files.get("/data.txt")?.toString()).toBe("ORIGINAL");
    expect(vi.getTimerCount()).toBe(0);
    // 让 destroy 晚到的 error/close 事件走完，确认不会变成 unhandled。
    await new Promise((resolve) => setImmediate(resolve));
  });
});
