import { randomUUID } from "crypto";
import type { Client, SFTPWrapper } from "ssh2";
import { constants as fsConstants, createReadStream, createWriteStream, renameSync, statSync, unlinkSync } from "fs";
import { basename } from "path";
import { CHARACTER_LIMIT, DEFAULT_SFTP_TIMEOUT } from "../constants.js";
import { SshOperationError } from "../utils/errors.js";
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

function isDirectoryMode(mode: number): boolean {
  return (mode & fsConstants.S_IFMT) === fsConstants.S_IFDIR;
}

function removeLocalPart(partPath: string): void {
  try {
    unlinkSync(partPath);
  } catch {
    // 临时文件可能还没有创建成功
  }
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

// 删除结果
export interface DeleteResult {
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
      return new SshOperationError("SFTP cancelled", { retryable: false });
    }
    const ms = timeout ?? this.defaultTimeout;
    return new SshOperationError(`SFTP timeout after ${ms}ms`, {
      timedOut: true,
      retryable: false,
    });
  }

  /**
   * 初始化 SFTP 会话
   */
  async init(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.client.sftp((err, sftp) => {
        if (err) {
          reject(new Error(`Failed to initialize SFTP: ${err.message}`));
          return;
        }
        this.sftp = sftp;
        resolve();
      });
    });
  }

  /**
   * 确保 SFTP 已初始化
   */
  private ensureSftp(): SFTPWrapper {
    if (!this.sftp) {
      throw new Error("SFTP not initialized. Call init() first.");
    }
    return this.sftp;
  }

  /**
   * 列出远程目录内容
   * @param remotePath 远程目录路径
   */
  async listDirectory(remotePath: string, options?: SftpCallOptions): Promise<ListResult> {
    const sftp = this.ensureSftp();

    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (err?: Error, value?: ListResult) => {
        if (settled) return;
        settled = true;
        deadline.stop();
        if (err) reject(err);
        else resolve(value as ListResult);
      };
      const deadline = this.bindDeadline(options?.timeout, options?.signal, (reason) => {
        this.close();
        finish(this.deadlineError(reason, options?.timeout));
      });
      sftp.readdir(remotePath, (err, list) => {
        if (err) {
          finish(new Error(`Failed to list directory: ${err.message}`));
          return;
        }

        const files: FileInfo[] = list.map((item) => {
          const isDirectory = (item.attrs.mode & 0o40000) !== 0;
          const isFile = (item.attrs.mode & 0o100000) !== 0;

          return {
            filename: item.filename,
            longname: item.longname,
            attrs: item.attrs,
            isDirectory,
            isFile,
            permissions: modeToPermissions(item.attrs.mode),
            owner: item.attrs.uid,
            group: item.attrs.gid,
            size: item.attrs.size,
            modifyTime: new Date(item.attrs.mtime * 1000).toISOString(),
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
      await this.commitRemoteFile(partPath, remotePath);
      return {
        success: true,
        localPath,
        remotePath,
        size: fileSize,
        message: `Uploaded ${basename(localPath)} to ${remotePath} (${fileSize} bytes)`,
      };
    } catch (err) {
      await this.tryUnlink(partPath);
      throw err;
    }
  }

  /**
   * 从远程服务器下载文件到本地
   * @param remotePath 远程文件路径
   * @param localPath 本地文件路径
   */
  async downloadFile(remotePath: string, localPath: string, options?: SftpCallOptions): Promise<DownloadResult> {
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

    const sftp = this.ensureSftp();
    const end = Math.min(stats.size, offset + limit) - 1;
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let settled = false;
      let readStream: ReturnType<SFTPWrapper["createReadStream"]> | undefined;
      const finish = (err?: Error, value?: ReadFileResult) => {
        if (settled) return;
        settled = true;
        deadline.stop();
        if (err) reject(err);
        else resolve(value as ReadFileResult);
      };
      const deadline = this.bindDeadline(options?.timeout, options?.signal, (reason) => {
        readStream?.destroy();
        this.close();
        finish(this.deadlineError(reason, options?.timeout));
      });
      readStream = sftp.createReadStream(remotePath, { start: offset, end });
      readStream.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
        deadline.bump();
      });
      readStream.on("end", () => {
        const raw = Buffer.concat(chunks);
        const hitLimit = offset + raw.length < stats.size;
        const kept = encoding === "utf8" && hitLimit
          ? raw.subarray(0, completeUtf8Length(raw))
          : raw;
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
    const buffer = Buffer.from(content, "utf-8");
    const partPath = `${remotePath}.part-${randomUUID()}`;
    try {
      await this.writeRemoteBuffer(partPath, buffer, options);
      const remoteStat = await this.stat(partPath, options);
      if (remoteStat.size !== buffer.length) {
        throw new Error(`Upload size mismatch: expected ${buffer.length} bytes, remote part is ${remoteStat.size} bytes`);
      }
      await this.commitRemoteFile(partPath, remotePath);
      return {
        success: true,
        path: remotePath,
        size: buffer.length,
        message: `Written ${buffer.length} bytes to ${remotePath}`,
      };
    } catch (err) {
      await this.tryUnlink(partPath);
      throw err;
    }
  }

  /**
   * 删除远程文件
   * @param remotePath 远程文件路径
   */
  async deleteFile(remotePath: string, options?: SftpCallOptions): Promise<DeleteResult> {
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
  async deleteDirectory(remotePath: string, options?: SftpCallOptions): Promise<DeleteResult> {
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
  async createDirectory(remotePath: string, options?: SftpCallOptions): Promise<DeleteResult> {
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
    return this.request(options, (sftp, done) => {
      sftp.stat(remotePath, (err, stats) => {
        if (err) done(new Error(`Failed to stat: ${err.message}`));
        else done(undefined, stats);
      });
    });
  }

  /**
   * 检查远程路径是否存在
   * @param remotePath 远程路径
   */
  async exists(remotePath: string): Promise<boolean> {
    try {
      await this.stat(remotePath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 重命名/移动远程文件
   * @param oldPath 原路径
   * @param newPath 新路径
   */
  async rename(oldPath: string, newPath: string, options?: SftpCallOptions): Promise<DeleteResult> {
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
    const sftp = this.ensureSftp();
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
        this.close();
        finish(this.deadlineError(reason, options?.timeout));
      });
      run(sftp, finish);
    });
  }

  /**
   * 把临时远程文件换成最终路径。
   * 优先使用 OpenSSH 的 posix-rename，失败时再删除目标后改名。
   */
  private commitRemoteFile(partPath: string, finalPath: string): Promise<void> {
    const sftp = this.ensureSftp();
    return new Promise((resolve, reject) => {
      const renameFallback = () => {
        sftp.unlink(finalPath, () => {
          sftp.rename(partPath, finalPath, (renameErr) => {
            if (renameErr) reject(new Error(`Failed to commit remote file: ${renameErr.message}`));
            else resolve();
          });
        });
      };
      try {
        sftp.ext_openssh_rename(partPath, finalPath, (err) => {
          if (!err) {
            resolve();
            return;
          }
          renameFallback();
        });
      } catch {
        renameFallback();
      }
    });
  }

  private pipeLocalToRemote(localPath: string, remotePart: string, options?: SftpCallOptions): Promise<void> {
    const sftp = this.ensureSftp();
    return new Promise((resolve, reject) => {
      let settled = false;
      const readStream = createReadStream(localPath);
      const writeStream = sftp.createWriteStream(remotePart);
      const finish = (err?: Error) => {
        if (settled) return;
        settled = true;
        deadline.stop();
        if (err) reject(err);
        else resolve();
      };
      const deadline = this.bindDeadline(options?.timeout, options?.signal, (reason) => {
        readStream.destroy();
        writeStream.destroy();
        this.close();
        finish(this.deadlineError(reason, options?.timeout));
      });
      const fail = (err: Error) => {
        readStream.destroy();
        writeStream.destroy();
        finish(err);
      };
      readStream.on("data", () => deadline.bump());
      readStream.on("error", (err: Error) => fail(new Error(`Failed to read local file: ${err.message}`)));
      writeStream.on("error", (err: Error) => fail(new Error(`Upload failed: ${err.message}`)));
      writeStream.on("close", () => finish());
      readStream.pipe(writeStream);
    });
  }

  private pipeRemoteToLocal(remotePath: string, localPart: string, options?: SftpCallOptions): Promise<void> {
    const sftp = this.ensureSftp();
    return new Promise((resolve, reject) => {
      let settled = false;
      const readStream = sftp.createReadStream(remotePath);
      const writeStream = createWriteStream(localPart);
      const finish = (err?: Error) => {
        if (settled) return;
        settled = true;
        deadline.stop();
        if (err) reject(err);
        else resolve();
      };
      const deadline = this.bindDeadline(options?.timeout, options?.signal, (reason) => {
        readStream.destroy();
        writeStream.destroy();
        this.close();
        finish(this.deadlineError(reason, options?.timeout));
      });
      const fail = (err: Error) => {
        readStream.destroy();
        writeStream.destroy();
        finish(err);
      };
      readStream.on("data", () => deadline.bump());
      readStream.on("error", (err: Error) => fail(new Error(`Download failed: ${err.message}`)));
      writeStream.on("error", (err: Error) => fail(new Error(`Failed to write local file: ${err.message}`)));
      writeStream.on("close", () => finish());
      readStream.pipe(writeStream);
    });
  }

  private writeRemoteBuffer(remotePart: string, buffer: Buffer, options?: SftpCallOptions): Promise<void> {
    const sftp = this.ensureSftp();
    return new Promise((resolve, reject) => {
      let settled = false;
      let writeStream: ReturnType<SFTPWrapper["createWriteStream"]> | undefined;
      const finish = (err?: Error) => {
        if (settled) return;
        settled = true;
        deadline.stop();
        if (err) reject(err);
        else resolve();
      };
      const deadline = this.bindDeadline(options?.timeout, options?.signal, (reason) => {
        writeStream?.destroy();
        this.close();
        finish(this.deadlineError(reason, options?.timeout));
      });
      writeStream = sftp.createWriteStream(remotePart);
      writeStream.on("error", (err: Error) => {
        writeStream?.destroy();
        finish(new Error(`Failed to write file: ${err.message}`));
      });
      writeStream.on("close", () => finish());
      writeStream.end(buffer);
    });
  }

  private async tryUnlink(remotePath: string): Promise<void> {
    try {
      await this.deleteFile(remotePath);
    } catch {
      // 临时文件可能还没有创建成功
    }
  }

  /**
   * 关闭 SFTP 会话
   */
  close(): void {
    if (this.sftp) {
      this.sftp.end();
      this.sftp = null;
    }
  }
}
