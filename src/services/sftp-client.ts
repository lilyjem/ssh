import { randomUUID } from "crypto";
import type { Client, SFTPWrapper } from "ssh2";
import { constants as fsConstants, createReadStream, createWriteStream, renameSync, statSync, unlinkSync } from "fs";
import { basename } from "path";
import { CHARACTER_LIMIT, DEFAULT_SFTP_TIMEOUT } from "../constants.js";
import { markNotRetryable, SshOperationError } from "../utils/errors.js";
import { expandHomePath } from "../utils/path.js";
import { completeUtf8Length } from "../utils/utf8.js";

export interface SftpCallOptions {
  timeout?: number;
  signal?: AbortSignal;
}

export interface ReadFileOptions extends SftpCallOptions {
  offset?: number;
  limit?: number;
  encoding?: "utf8" | "base64";
}

export function isDirectoryMode(mode: number): boolean {
  return (mode & fsConstants.S_IFMT) === fsConstants.S_IFDIR;
}

// 清理临时远端文件只是善后：必须比业务操作更快结束，不能因为清理把调用方拖住。
const REMOTE_CLEANUP_TIMEOUT = 1000;
// ssh2 WriteStream 没有逐块回调事件；每次 write 回调代表服务器已经确认该块。
// 按块顺序写入既能观察真实确认进度，也不会比 ssh2 自己的分片写入多做往返。
const WRITE_PROGRESS_CHUNK = 64 * 1024;

function removeLocalPart(partPath: string): void {
  try {
    unlinkSync(partPath);
  } catch {
    // 临时文件可能还没有创建成功
  }
}

function formatModifyTime(mtime: unknown): string {
  if (typeof mtime !== "number" || !Number.isFinite(mtime)) return "";
  const milliseconds = mtime * 1000;
  // 与 Date 的有效范围保持一致，避免缺失或异常 mtime 触发 toISOString 的 RangeError。
  if (!Number.isFinite(milliseconds) || Math.abs(milliseconds) > 8.64e15) return "";
  return new Date(milliseconds).toISOString();
}

function unsupportedRenameError(err: unknown): boolean {
  const candidate = err as { code?: unknown; message?: unknown } | undefined;
  // ssh2 把 SFTP status code 放在 err.code；8 是 OP_UNSUPPORTED。
  if (candidate?.code === 8 || candidate?.code === "OP_UNSUPPORTED") return true;
  const message = typeof candidate?.message === "string" ? candidate.message : "";
  // ext_openssh_rename 在服务端未声明 posix-rename 扩展时会同步抛出这句话。
  return /does not support this extended request/i.test(message)
    || /operation unsupported/i.test(message);
}

// 文件信息接口
export interface FileInfo {
  filename: string;
  longname: string;
  attrs: {
    mode: number;
    uid: number;
    gid: number;
    size: number;
    atime: number;
    mtime: number;
  };
  isDirectory: boolean;
  isFile: boolean;
  permissions: string;
  owner: number;
  group: number;
  size: number;
  modifyTime: string;
}

// 上传结果
export interface UploadResult {
  success: boolean;
  localPath: string;
  remotePath: string;
  size: number;
  message: string;
}

// 下载结果
export interface DownloadResult {
  success: boolean;
  remotePath: string;
  localPath: string;
  size: number;
  message: string;
}

// 目录列表结果
export interface ListResult {
  path: string;
  files: FileInfo[];
  count: number;
}

// 路径操作结果（删除、创建目录、重命名）
export interface PathResult {
  success: boolean;
  path: string;
  message: string;
}

// 读取文件结果
export interface ReadFileResult {
  path: string;
  content: string;
  size: number;
  offset: number;
  bytesRead: number;
  nextOffset: number;
  truncated: boolean;
  encoding: "utf8" | "base64";
}

// 写入文件结果
export interface WriteFileResult {
  success: boolean;
  path: string;
  size: number;
  message: string;
}

/**
 * 将 Unix 权限模式转换为字符串（如 rwxr-xr-x）
 */
function modeToPermissions(mode: number): string {
  const perms = ["---", "--x", "-w-", "-wx", "r--", "r-x", "rw-", "rwx"];
  const owner = (mode >> 6) & 7;
  const group = (mode >> 3) & 7;
  const other = mode & 7;
  return perms[owner] + perms[group] + perms[other];
}

/**
 * SFTP 客户端封装
 * 提供文件上传、下载、列表、删除等功能
 */
export class SftpClient {
  private client: Client;
  private sftp: SFTPWrapper | null = null;
  private defaultTimeout: number;
  private closed = false;
  private initToken = 0;
  private initAttempt: { token: number; promise: Promise<void>; finish: (err?: Error) => void } | null = null;

  constructor(client: Client, options?: { timeout?: number }) {
    this.client = client;
    this.defaultTimeout = options?.timeout ?? DEFAULT_SFTP_TIMEOUT;
  }

  /**
   * 操作超时，或传输过程中超过 timeout 毫秒没有新数据。
   * 外部 signal 取消时同样结束这次操作。
   */
  private bindDeadline(
    timeout: number | undefined,
    signal: AbortSignal | undefined,
    onFire: (reason: "timeout" | "cancel") => void
  ): { bump: () => void; stop: () => void } {
    const ms = timeout ?? this.defaultTimeout;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    const fire = (reason: "timeout" | "cancel") => {
      if (stopped) return;
      stopped = true;
      if (timer) clearTimeout(timer);
      onFire(reason);
    };
    const bump = () => {
      if (stopped) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => fire("timeout"), ms);
    };
    const onAbort = () => fire("cancel");
    if (signal?.aborted) {
      // 推迟到 deadline 赋值完成，避免同步回调读到尚未初始化的常量。
      queueMicrotask(() => fire("cancel"));
    } else {
      signal?.addEventListener("abort", onAbort, { once: true });
      bump();
    }
    return {
      bump,
      stop: () => {
        stopped = true;
        if (timer) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      },
    };
  }

  private deadlineError(reason: "timeout" | "cancel", timeout?: number): SshOperationError {
    if (reason === "cancel") {
      return new SshOperationError("SFTP cancelled", { retryable: false, cancelled: true });
    }
    const ms = timeout ?? this.defaultTimeout;
    return new SshOperationError(`SFTP timeout after ${ms}ms`, {
      timedOut: true,
      retryable: false,
    });
  }

  private closeError(): SshOperationError {
    return new SshOperationError("SFTP client is closed", { retryable: false });
  }

  /**
   * 初始化 SFTP 会话。并发调用共享同一次初始化；close 或超时之后迟到的
   * ssh2 回调只关闭新会话，不能把已结束的客户端重新激活。
   */
  async init(options?: SftpCallOptions): Promise<void> {
    if (this.closed) throw this.closeError();
    if (this.sftp) {
      if (this.isAlive()) return;
      this.sftp = null;
    }
    if (this.initAttempt) return this.initAttempt.promise;
    if (options?.signal?.aborted) {
      throw this.deadlineError("cancel", options?.timeout);
    }

    const token = ++this.initToken;
    let resolvePromise!: () => void;
    let rejectPromise!: (err: Error) => void;
    const promise = new Promise<void>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    let settled = false;
    let deadline: ReturnType<SftpClient["bindDeadline"]> | undefined;
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      deadline?.stop();
      if (this.initAttempt?.token === token) this.initAttempt = null;
      if (err) rejectPromise(err);
      else resolvePromise();
    };
    this.initAttempt = { token, promise, finish };
    deadline = this.bindDeadline(options?.timeout, options?.signal, (reason) => {
      finish(this.deadlineError(reason, options?.timeout));
    });

    try {
      this.client.sftp((err, sftp) => {
        if (settled || this.closed || token !== this.initToken) {
          if (!err && sftp) this.discardWrapper(sftp);
          return;
        }
        if (err) {
          finish(new Error(`Failed to initialize SFTP: ${err.message}`));
          return;
        }
        this.sftp = sftp;
        this.watchWrapper(sftp);
        finish();
      });
    } catch (err) {
      finish(err instanceof Error ? err : new Error(String(err)));
    }

    return promise;
  }

  /** SFTP 会话已初始化、未关闭，且没有观察到 end/close/error。 */
  isAlive(): boolean {
    return !this.closed && this.sftp !== null;
  }

  private watchWrapper(sftp: SFTPWrapper): void {
    const emitter = sftp as unknown as {
      on?: (event: string, listener: (...args: unknown[]) => void) => unknown;
    };
    if (typeof emitter.on !== "function") return;
    const gone = () => {
      if (this.sftp === sftp) this.sftp = null;
    };
    // error 必须始终有监听器；end/close 也用来让缓存立即失效。
    emitter.on("error", gone);
    emitter.on("end", gone);
    emitter.on("close", gone);
  }

  private discardWrapper(sftp: SFTPWrapper): void {
    const emitter = sftp as unknown as {
      on?: (event: string, listener: (...args: unknown[]) => void) => unknown;
    };
    try {
      emitter.on?.("error", () => {});
    } catch {
      // 伪造/已销毁的 wrapper 可能不再接受监听器。
    }
    try {
      sftp.end();
    } catch {
      // 迟到的会话即使关闭失败也不能影响调用方。
    }
  }

  /**
   * 确保 SFTP 已初始化
   */
  private ensureSftp(): SFTPWrapper {
    if (this.closed || !this.sftp) {
      throw new Error("SFTP not initialized. Call init() first.");
    }
    return this.sftp;
  }

  private assertPath(path: string, kind: "local" | "remote"): void {
    if (typeof path !== "string" || path.includes("\0")) {
      throw new SshOperationError(`Invalid ${kind} path: NUL bytes are not allowed`, {
        retryable: false,
      });
    }
  }

  /**
   * 统一处理超时、取消和只结算一次。onDeadline 负责清理本次操作创建的流。
   */
  private startCall<T>(
    options: SftpCallOptions | undefined,
    onDeadline: () => void,
    run: (finish: (err?: Error, value?: T) => void, bump: () => void) => void
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (err?: Error, value?: T) => {
        if (settled) return;
        settled = true;
        deadline.stop();
        if (err) reject(err);
        else resolve(value as T);
      };
      const deadline = this.bindDeadline(options?.timeout, options?.signal, (reason) => {
        try {
          onDeadline();
        } catch {
          // 清理失败不能阻止本次操作结算，否则计时器和监听会泄漏。
        } finally {
          finish(this.deadlineError(reason, options?.timeout));
        }
      });
      if (options?.signal?.aborted) {
        // 已经预先取消：不发起任何远端请求，deadline 的排队的 cancel 回调随后会被 stop 掉。
        finish(this.deadlineError("cancel", options?.timeout));
        return;
      }
      try {
        run(finish, deadline.bump);
      } catch (err) {
        // ensureSftp 等同步失败时 Promise 构造函数会直接拒绝，但 deadline 已经启动，
        // 必须走一次清理，否则定时器和 abort 监听会残留到进程结束。
        if (settled) return;
        try {
          onDeadline();
        } catch {
          // 清理失败不能覆盖原始错误。
        }
        finish(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /**
   * 列出远程目录内容
   * @param remotePath 远程目录路径
   */
  async listDirectory(remotePath: string, options?: SftpCallOptions): Promise<ListResult> {
    this.assertPath(remotePath, "remote");
    return this.startCall(options, () => this.close(), (finish) => {
      this.ensureSftp().readdir(remotePath, (err, list) => {
        if (err) {
          finish(new Error(`Failed to list directory: ${err.message}`));
          return;
        }

        const files: FileInfo[] = list.map((item) => {
          const attrs = (item.attrs ?? {}) as Partial<FileInfo["attrs"]>;
          const mode = typeof attrs.mode === "number" ? attrs.mode : 0;
          const isDirectory = isDirectoryMode(mode);
          const isFile = (mode & 0o100000) !== 0;
          const uid = typeof attrs.uid === "number" ? attrs.uid : 0;
          const gid = typeof attrs.gid === "number" ? attrs.gid : 0;
          const size = typeof attrs.size === "number" ? attrs.size : 0;

          return {
            filename: item.filename,
            longname: item.longname,
            attrs: {
              mode,
              uid,
              gid,
              size,
              atime: typeof attrs.atime === "number" ? attrs.atime : 0,
              mtime: typeof attrs.mtime === "number" ? attrs.mtime : 0,
            },
            isDirectory,
            isFile,
            permissions: modeToPermissions(mode),
            owner: uid,
            group: gid,
            size,
            modifyTime: formatModifyTime(attrs.mtime),
          };
        });

        // 按目录优先、文件名排序
        files.sort((a, b) => {
          if (a.isDirectory && !b.isDirectory) return -1;
          if (!a.isDirectory && b.isDirectory) return 1;
          return a.filename.localeCompare(b.filename);
        });

        finish(undefined, {
          path: remotePath,
          files,
          count: files.length,
        });
      });
    });
  }

  /**
   * 上传本地文件到远程服务器
   * @param localPath 本地文件路径
   * @param remotePath 远程文件路径
   */
  async uploadFile(localPath: string, remotePath: string, options?: SftpCallOptions): Promise<UploadResult> {
    this.assertPath(localPath, "local");
    this.assertPath(remotePath, "remote");
    // 本地路径可能来自 Cursor 工具参数，兼容 `~/Downloads/file.txt` 这类 macOS 常用写法。
    const expandedLocalPath = expandHomePath(localPath);

    let fileSize: number;
    try {
      const stats = statSync(expandedLocalPath);
      if (stats.isDirectory()) {
        throw new Error(`Local path is a directory: ${localPath}`);
      }
      fileSize = stats.size;
    } catch (err) {
      if ((err as Error).message.includes("directory")) throw err;
      throw new Error(`Local file not found: ${localPath}`);
    }

    // 先写到同目录临时文件，校验字节数后再改名，避免失败时截断目标文件。
    const partPath = `${remotePath}.part-${randomUUID()}`;
    try {
      await this.pipeLocalToRemote(expandedLocalPath, partPath, options);
      const remoteStat = await this.stat(partPath, options);
      if (remoteStat.size !== fileSize) {
        throw new Error(`Upload size mismatch: expected ${fileSize} bytes, remote part is ${remoteStat.size} bytes`);
      }
      await this.commitRemoteFile(partPath, remotePath, options);
      return {
        success: true,
        localPath,
        remotePath,
        size: fileSize,
        message: `Uploaded ${basename(localPath)} to ${remotePath} (${fileSize} bytes)`,
      };
    } catch (err) {
      await this.tryUnlink(partPath, options);
      // 写入已经开始，重放会在远端再写一份或留下临时文件。
      throw markNotRetryable(err);
    }
  }

  /**
   * 从远程服务器下载文件到本地
   * @param remotePath 远程文件路径
   * @param localPath 本地文件路径
   */
  async downloadFile(remotePath: string, localPath: string, options?: SftpCallOptions): Promise<DownloadResult> {
    this.assertPath(remotePath, "remote");
    this.assertPath(localPath, "local");
    // 下载目标是本机路径，同样需要兼容 `~/...`。
    const expandedLocalPath = expandHomePath(localPath);
    const stats = await this.stat(remotePath, options);
    if (isDirectoryMode(stats.mode)) {
      throw new Error(`Remote path is a directory: ${remotePath}`);
    }

    const partPath = `${expandedLocalPath}.part-${randomUUID()}`;
    try {
      await this.pipeRemoteToLocal(remotePath, partPath, options);
      const written = statSync(partPath).size;
      if (written !== stats.size) {
        throw new Error(`Download size mismatch: expected ${stats.size} bytes, received ${written} bytes`);
      }
      renameSync(partPath, expandedLocalPath);
      return {
        success: true,
        remotePath,
        localPath,
        size: written,
        message: `Downloaded ${basename(remotePath)} to ${localPath} (${written} bytes)`,
      };
    } catch (err) {
      removeLocalPart(partPath);
      throw err;
    }
  }

  /**
   * 读取远程文件内容（文本文件）
   * @param remotePath 远程文件路径
   * @param maxSize 最大读取大小（默认使用 CHARACTER_LIMIT）
   */
  async readFile(remotePath: string, options?: ReadFileOptions): Promise<ReadFileResult> {
    this.assertPath(remotePath, "remote");
    const encoding = options?.encoding ?? "utf8";
    const offset = options?.offset ?? 0;
    const limit = options?.limit ?? CHARACTER_LIMIT;
    const stats = await this.stat(remotePath, options);
    if (offset < 0 || offset > stats.size) {
      throw new Error(`offset ${offset} is outside file size ${stats.size}`);
    }

    // 空文件或偏移已经到末尾时不要创建读取流，ssh2 不能接受 end 为 -1。
    if (stats.size === 0 || offset === stats.size) {
      return {
        path: remotePath,
        content: "",
        size: stats.size,
        offset,
        bytesRead: 0,
        nextOffset: offset,
        truncated: false,
        encoding,
      };
    }

    const end = Math.min(stats.size, offset + limit) - 1;
    let readStream: ReturnType<SFTPWrapper["createReadStream"]> | undefined;
    return this.startCall<ReadFileResult>(options, () => {
      readStream?.destroy();
      this.close();
    }, (finish, bump) => {
      const chunks: Buffer[] = [];
      readStream = this.ensureSftp().createReadStream(remotePath, { start: offset, end });
      readStream.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
        bump();
      });
      readStream.on("end", () => {
        const raw = Buffer.concat(chunks);
        const hitLimit = offset + raw.length < stats.size;
        let kept = raw;
        if (encoding === "utf8" && hitLimit) {
          const complete = completeUtf8Length(raw);
          if (complete === 0) {
            // limit 连下一个完整字符都放不下。继续返回空页会让 nextOffset 原地不动，
            // 悄悄丢掉字符；这里明确失败，且绝不把 offset 推到被丢弃的字节之后。
            finish(new SshOperationError(
              `Cannot read UTF-8 content: limit ${limit} is smaller than the next complete character`,
              { retryable: false }
            ));
            return;
          }
          kept = raw.subarray(0, complete);
        }
        const nextOffset = offset + kept.length;
        finish(undefined, {
          path: remotePath,
          content: encoding === "base64" ? kept.toString("base64") : kept.toString("utf8"),
          size: stats.size,
          offset,
          bytesRead: kept.length,
          nextOffset,
          truncated: nextOffset < stats.size,
          encoding,
        });
      });
      readStream.on("error", (err: Error) => {
        finish(new Error(`Failed to read file: ${err.message}`));
      });
    });
  }

  /**
   * 写入内容到远程文件
   * @param remotePath 远程文件路径
   * @param content 文件内容
   */
  async writeFile(remotePath: string, content: string, options?: SftpCallOptions): Promise<WriteFileResult> {
    this.assertPath(remotePath, "remote");
    const buffer = Buffer.from(content, "utf-8");
    const partPath = `${remotePath}.part-${randomUUID()}`;
    try {
      await this.writeRemoteBuffer(partPath, buffer, options);
      const remoteStat = await this.stat(partPath, options);
      if (remoteStat.size !== buffer.length) {
        throw new Error(`Upload size mismatch: expected ${buffer.length} bytes, remote part is ${remoteStat.size} bytes`);
      }
      await this.commitRemoteFile(partPath, remotePath, options);
      return {
        success: true,
        path: remotePath,
        size: buffer.length,
        message: `Written ${buffer.length} bytes to ${remotePath}`,
      };
    } catch (err) {
      await this.tryUnlink(partPath, options);
      // 写入已经开始，重放会重复执行写操作。
      throw markNotRetryable(err);
    }
  }

  /**
   * 删除远程文件
   * @param remotePath 远程文件路径
   */
  async deleteFile(remotePath: string, options?: SftpCallOptions): Promise<PathResult> {
    this.assertPath(remotePath, "remote");
    return this.request(options, (sftp, done) => {
      sftp.unlink(remotePath, (err) => {
        if (err) done(new Error(`Failed to delete file: ${err.message}`));
        else done(undefined, { success: true, path: remotePath, message: `Deleted ${remotePath}` });
      });
    });
  }

  /**
   * 删除远程目录（必须为空）
   * @param remotePath 远程目录路径
   */
  async deleteDirectory(remotePath: string, options?: SftpCallOptions): Promise<PathResult> {
    this.assertPath(remotePath, "remote");
    return this.request(options, (sftp, done) => {
      sftp.rmdir(remotePath, (err) => {
        if (err) done(new Error(`Failed to delete directory: ${err.message}`));
        else done(undefined, {
          success: true,
          path: remotePath,
          message: `Deleted directory ${remotePath}`,
        });
      });
    });
  }

  /**
   * 创建远程目录
   * @param remotePath 远程目录路径
   */
  async createDirectory(remotePath: string, options?: SftpCallOptions): Promise<PathResult> {
    this.assertPath(remotePath, "remote");
    return this.request(options, (sftp, done) => {
      sftp.mkdir(remotePath, (err) => {
        if (err) done(new Error(`Failed to create directory: ${err.message}`));
        else done(undefined, {
          success: true,
          path: remotePath,
          message: `Created directory ${remotePath}`,
        });
      });
    });
  }

  /**
   * 获取远程文件/目录状态
   * @param remotePath 远程路径
   */
  async stat(remotePath: string, options?: SftpCallOptions): Promise<FileInfo["attrs"]> {
    this.assertPath(remotePath, "remote");
    return this.request(options, (sftp, done) => {
      sftp.stat(remotePath, (err, stats) => {
        if (err) done(new Error(`Failed to stat: ${err.message}`));
        else done(undefined, stats);
      });
    });
  }

  /**
   * 重命名/移动远程文件
   * @param oldPath 原路径
   * @param newPath 新路径
   */
  async rename(oldPath: string, newPath: string, options?: SftpCallOptions): Promise<PathResult> {
    this.assertPath(oldPath, "remote");
    this.assertPath(newPath, "remote");
    return this.request(options, (sftp, done) => {
      sftp.rename(oldPath, newPath, (err) => {
        if (err) done(new Error(`Failed to rename: ${err.message}`));
        else done(undefined, {
          success: true,
          path: newPath,
          message: `Renamed ${oldPath} to ${newPath}`,
        });
      });
    });
  }

  private request<T>(
    options: SftpCallOptions | undefined,
    run: (sftp: SFTPWrapper, done: (err?: Error, value?: T) => void) => void
  ): Promise<T> {
    return this.startCall(options, () => this.close(), (finish) => {
      run(this.ensureSftp(), finish);
    });
  }

  /**
   * 把临时远程文件换成最终路径。
   * 优先使用 OpenSSH 的 posix-rename（原子替换）；只有服务端明确不支持该扩展时
   * 才退回普通 rename。普通 rename 由服务端决定是否覆盖，失败时保持最终目标原样。
   */
  private commitRemoteFile(
    partPath: string,
    finalPath: string,
    options?: SftpCallOptions
  ): Promise<void> {
    return this.request(options, (sftp, done) => {
      const fail = (err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        done(new Error(`Failed to commit remote file: ${message}`));
      };
      const renameWithoutDelete = () => {
        // 关键：绝不先删除最终目标。服务端不支持覆盖时宁可失败，也不制造目标丢失窗口。
        try {
          sftp.rename(partPath, finalPath, (err) => {
            if (err) fail(err);
            else done();
          });
        } catch (err) {
          fail(err);
        }
      };
      const extRename = (sftp as unknown as {
        ext_openssh_rename?: (
          oldPath: string,
          newPath: string,
          callback: (err?: Error & { code?: number }) => void
        ) => void;
      }).ext_openssh_rename;
      if (typeof extRename !== "function") {
        renameWithoutDelete();
        return;
      }
      try {
        extRename.call(sftp, partPath, finalPath, (err) => {
          if (!err) {
            done();
            return;
          }
          if (unsupportedRenameError(err)) renameWithoutDelete();
          else fail(err);
        });
      } catch (err) {
        // ssh2 在服务端没有 posix-rename 扩展时同步抛出 unsupported；其他异常直接失败。
        if (unsupportedRenameError(err)) renameWithoutDelete();
        else fail(err);
      }
    });
  }

  private pipeLocalToRemote(localPath: string, remotePart: string, options?: SftpCallOptions): Promise<void> {
    let readStream: ReturnType<typeof createReadStream> | undefined;
    let writeStream: ReturnType<SFTPWrapper["createWriteStream"]> | undefined;
    let stopProgress: (() => void) | undefined;
    let aborted = false;
    return this.startCall<void>(options, () => {
      aborted = true;
      stopProgress?.();
      readStream?.destroy();
      writeStream?.destroy();
      this.close();
    }, (finish, bump) => {
      // 先确认 SFTP 会话可用，再打开本地文件，避免同步失败后留下未关闭的 FD。
      const sftp = this.ensureSftp();
      const fail = (err: Error) => {
        if (aborted) return;
        aborted = true;
        stopProgress?.();
        readStream?.destroy();
        writeStream?.destroy();
        finish(err);
      };

      readStream = createReadStream(localPath);
      // 流一创建就绑定 error，后面的 createWriteStream/pipe 同步抛错时也不会留下未处理事件。
      readStream.on("error", (err: Error) => fail(new Error(`Failed to read local file: ${err.message}`)));

      writeStream = sftp.createWriteStream(remotePart);
      writeStream.on("error", (err: Error) => fail(new Error(`Upload failed: ${err.message}`)));
      writeStream.on("close", () => {
        if (aborted) return;
        aborted = true;
        stopProgress?.();
        finish();
      });
      // 上传不再把本地 readStream 的 data 当作远端进度：只有 ssh2 的 write 回调
      // （服务器确认该块）才能延长无进展 deadline。pipe 的背压仍然保持。
      stopProgress = this.observeWriteAcks(writeStream, bump);
      readStream.pipe(writeStream);
    });
  }

  /**
   * 给单个 ssh2 WriteStream 的 write 回调注入进度观察。
   * ssh2 没有逐块 progress 事件，但 WriteStream.write 的公开回调在对应 WRITE
   * 请求被服务器确认后才触发；这里只包装当前流实例，不改原型或全局行为。
   */
  private observeWriteAcks(
    writeStream: ReturnType<SFTPWrapper["createWriteStream"]>,
    onAck: () => void
  ): () => void {
    type WriteAck = (err?: Error | null) => void;
    const writable = writeStream as unknown as {
      write?: (
        chunk: Buffer | string,
        encodingOrCallback?: BufferEncoding | WriteAck,
        callback?: WriteAck
      ) => boolean;
    };
    const original = writable.write;
    if (typeof original !== "function") return () => {};

    let active = true;
    const observed = function (
      chunk: Buffer | string,
      encodingOrCallback?: BufferEncoding | WriteAck,
      callback?: WriteAck
    ): boolean {
      const encoding = typeof encodingOrCallback === "string" ? encodingOrCallback : undefined;
      const userCallback = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
      const onWritten: WriteAck = (err) => {
        if (active && !err) onAck();
        userCallback?.(err);
      };
      return encoding === undefined
        ? original.call(writeStream, chunk, onWritten)
        : original.call(writeStream, chunk, encoding, onWritten);
    };
    writable.write = observed;
    return () => {
      active = false;
      if (writable.write === observed) writable.write = original;
    };
  }

  private pipeRemoteToLocal(remotePath: string, localPart: string, options?: SftpCallOptions): Promise<void> {
    let readStream: ReturnType<SFTPWrapper["createReadStream"]> | undefined;
    let writeStream: ReturnType<typeof createWriteStream> | undefined;
    let failed = false;
    let partRemoved = false;
    const removePartAfterFailure = () => {
      if (partRemoved) return;
      partRemoved = true;
      removeLocalPart(localPart);
    };
    return this.startCall<void>(options, () => {
      failed = true;
      readStream?.destroy();
      writeStream?.destroy();
      this.close();
    }, (finish, bump) => {
      // 会话可能在 stat 之后失效，必须校验通过后才能创建本地临时文件。
      const sftp = this.ensureSftp();
      const fail = (err: Error) => {
        if (failed) return;
        failed = true;
        readStream?.destroy();
        writeStream?.destroy();
        finish(err);
      };

      readStream = sftp.createReadStream(remotePath);
      // 远端 ReadStream 最容易在本地写入失败/超时后收到迟到的 error，必须先监听再继续 setup。
      readStream.on("error", (err: Error) => fail(new Error(`Download failed: ${err.message}`)));
      readStream.on("data", () => bump());

      writeStream = createWriteStream(localPart);
      writeStream.on("error", (err: Error) => fail(new Error(`Failed to write local file: ${err.message}`)));
      // fs.WriteStream 的 open/close 是异步的：失败后立即 unlink 可能遇到 ENOENT，
      // 随后 open 才创建 .part。失败/超时时在本地流真正 close 后再删一次，避免晚到的 part。
      // 清理只挂在本地流上，不等待远端流或对话，所以不会拖住 timeout/cancel。
      writeStream.once("close", () => {
        if (failed) removePartAfterFailure();
      });
      writeStream.on("close", () => {
        if (failed) return;
        finish();
      });
      readStream.pipe(writeStream);
    });
  }

  private writeRemoteBuffer(remotePart: string, buffer: Buffer, options?: SftpCallOptions): Promise<void> {
    let writeStream: ReturnType<SFTPWrapper["createWriteStream"]> | undefined;
    let stopped = false;
    return this.startCall<void>(options, () => {
      stopped = true;
      writeStream?.destroy();
      this.close();
    }, (finish, bump) => {
      const fail = (err: Error) => {
        if (stopped) return;
        stopped = true;
        writeStream?.destroy();
        finish(new Error(`Failed to write file: ${err.message}`));
      };

      writeStream = this.ensureSftp().createWriteStream(remotePart);
      writeStream.on("error", fail);
      writeStream.on("close", () => {
        if (stopped) return;
        stopped = true;
        finish();
      });

      const writable = writeStream as unknown as {
        write?: (chunk: Buffer, callback?: (err?: Error | null) => void) => boolean;
      };
      if (buffer.length === 0) {
        writeStream.end();
        return;
      }
      if (typeof writable.write !== "function") {
        // 兼容只实现 end 的包装流（例如测试替身）。
        writeStream.end(buffer);
        return;
      }

      // ssh2 没有逐块 progress 事件；write 回调在服务器确认该块后才触发，是真实进度。
      // 顺序写入 64 KiB 块，避免把本地缓冲区排空误当成远端写入进度。
      let offset = 0;
      const pump = () => {
        if (stopped) return;
        try {
          if (offset >= buffer.length) {
            writeStream?.end();
            return;
          }
          const chunk = buffer.subarray(offset, Math.min(buffer.length, offset + WRITE_PROGRESS_CHUNK));
          offset += chunk.length;
          writable.write!(chunk, (err) => {
            if (stopped) return;
            if (err) {
              fail(err);
              return;
            }
            // 至少让出调用栈，避免同步回调的测试替身在大文件上无限递归。
            bump();
            queueMicrotask(pump);
          });
        } catch (err) {
          fail(err instanceof Error ? err : new Error(String(err)));
        }
      };
      pump();
    });
  }

  private async tryUnlink(remotePath: string, options?: SftpCallOptions): Promise<void> {
    // 会话已经关闭/发现 end/error 时不再尝试：不能为了删临时文件重连或重放。
    if (!this.isAlive() || options?.signal?.aborted) return;
    const cleanupTimeout = Math.min(
      options?.timeout ?? this.defaultTimeout,
      REMOTE_CLEANUP_TIMEOUT
    );
    try {
      await this.deleteFile(remotePath, { timeout: cleanupTimeout, signal: options?.signal });
    } catch {
      // 临时文件可能还没有创建成功，清理失败不能覆盖原始错误。
    }
  }

  /**
   * 关闭 SFTP 会话。幂等；关闭后迟到的 init 回调只会结束新会话，不能复活客户端。
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.initToken++;

    const attempt = this.initAttempt;
    this.initAttempt = null;
    attempt?.finish(this.closeError());

    const sftp = this.sftp;
    this.sftp = null;
    if (sftp) {
      try {
        sftp.end();
      } catch {
        // 已断开的会话可能无法再次关闭。
      }
    }
  }
}
