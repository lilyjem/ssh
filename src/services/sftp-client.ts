import type { Client, SFTPWrapper } from "ssh2";
import { createReadStream, createWriteStream, statSync } from "fs";
import { basename, dirname } from "path";
import { CHARACTER_LIMIT } from "../constants.js";

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
  truncated: boolean;
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

  constructor(client: Client) {
    this.client = client;
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
  async listDirectory(remotePath: string): Promise<ListResult> {
    const sftp = this.ensureSftp();

    return new Promise((resolve, reject) => {
      sftp.readdir(remotePath, (err, list) => {
        if (err) {
          reject(new Error(`Failed to list directory: ${err.message}`));
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

        resolve({
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
  async uploadFile(localPath: string, remotePath: string): Promise<UploadResult> {
    const sftp = this.ensureSftp();

    // 获取本地文件大小
    let fileSize: number;
    try {
      const stats = statSync(localPath);
      fileSize = stats.size;
    } catch (err) {
      throw new Error(`Local file not found: ${localPath}`);
    }

    return new Promise((resolve, reject) => {
      const readStream = createReadStream(localPath);
      const writeStream = sftp.createWriteStream(remotePath);

      writeStream.on("close", () => {
        resolve({
          success: true,
          localPath,
          remotePath,
          size: fileSize,
          message: `Uploaded ${basename(localPath)} to ${remotePath} (${fileSize} bytes)`,
        });
      });

      writeStream.on("error", (err: Error) => {
        reject(new Error(`Upload failed: ${err.message}`));
      });

      readStream.on("error", (err: Error) => {
        reject(new Error(`Failed to read local file: ${err.message}`));
      });

      readStream.pipe(writeStream);
    });
  }

  /**
   * 从远程服务器下载文件到本地
   * @param remotePath 远程文件路径
   * @param localPath 本地文件路径
   */
  async downloadFile(remotePath: string, localPath: string): Promise<DownloadResult> {
    const sftp = this.ensureSftp();

    // 先获取远程文件信息
    const stats = await this.stat(remotePath);

    return new Promise((resolve, reject) => {
      const readStream = sftp.createReadStream(remotePath);
      const writeStream = createWriteStream(localPath);

      writeStream.on("close", () => {
        resolve({
          success: true,
          remotePath,
          localPath,
          size: stats.size,
          message: `Downloaded ${basename(remotePath)} to ${localPath} (${stats.size} bytes)`,
        });
      });

      writeStream.on("error", (err: Error) => {
        reject(new Error(`Failed to write local file: ${err.message}`));
      });

      readStream.on("error", (err: Error) => {
        reject(new Error(`Download failed: ${err.message}`));
      });

      readStream.pipe(writeStream);
    });
  }

  /**
   * 读取远程文件内容（文本文件）
   * @param remotePath 远程文件路径
   * @param maxSize 最大读取大小（默认使用 CHARACTER_LIMIT）
   */
  async readFile(remotePath: string, maxSize: number = CHARACTER_LIMIT): Promise<ReadFileResult> {
    const sftp = this.ensureSftp();

    // 先获取文件大小
    const stats = await this.stat(remotePath);
    const truncated = stats.size > maxSize;

    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let totalSize = 0;

      const readStream = sftp.createReadStream(remotePath, {
        start: 0,
        end: Math.min(stats.size, maxSize) - 1,
      });

      readStream.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
        totalSize += chunk.length;
      });

      readStream.on("end", () => {
        const content = Buffer.concat(chunks).toString("utf-8");
        resolve({
          path: remotePath,
          content,
          size: stats.size,
          truncated,
        });
      });

      readStream.on("error", (err: Error) => {
        reject(new Error(`Failed to read file: ${err.message}`));
      });
    });
  }

  /**
   * 写入内容到远程文件
   * @param remotePath 远程文件路径
   * @param content 文件内容
   */
  async writeFile(remotePath: string, content: string): Promise<WriteFileResult> {
    const sftp = this.ensureSftp();
    const buffer = Buffer.from(content, "utf-8");

    return new Promise((resolve, reject) => {
      const writeStream = sftp.createWriteStream(remotePath);

      writeStream.on("close", () => {
        resolve({
          success: true,
          path: remotePath,
          size: buffer.length,
          message: `Written ${buffer.length} bytes to ${remotePath}`,
        });
      });

      writeStream.on("error", (err: Error) => {
        reject(new Error(`Failed to write file: ${err.message}`));
      });

      writeStream.end(buffer);
    });
  }

  /**
   * 删除远程文件
   * @param remotePath 远程文件路径
   */
  async deleteFile(remotePath: string): Promise<DeleteResult> {
    const sftp = this.ensureSftp();

    return new Promise((resolve, reject) => {
      sftp.unlink(remotePath, (err) => {
        if (err) {
          reject(new Error(`Failed to delete file: ${err.message}`));
          return;
        }
        resolve({
          success: true,
          path: remotePath,
          message: `Deleted ${remotePath}`,
        });
      });
    });
  }

  /**
   * 删除远程目录（必须为空）
   * @param remotePath 远程目录路径
   */
  async deleteDirectory(remotePath: string): Promise<DeleteResult> {
    const sftp = this.ensureSftp();

    return new Promise((resolve, reject) => {
      sftp.rmdir(remotePath, (err) => {
        if (err) {
          reject(new Error(`Failed to delete directory: ${err.message}`));
          return;
        }
        resolve({
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
  async createDirectory(remotePath: string): Promise<DeleteResult> {
    const sftp = this.ensureSftp();

    return new Promise((resolve, reject) => {
      sftp.mkdir(remotePath, (err) => {
        if (err) {
          reject(new Error(`Failed to create directory: ${err.message}`));
          return;
        }
        resolve({
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
  async stat(remotePath: string): Promise<FileInfo["attrs"]> {
    const sftp = this.ensureSftp();

    return new Promise((resolve, reject) => {
      sftp.stat(remotePath, (err, stats) => {
        if (err) {
          reject(new Error(`Failed to stat: ${err.message}`));
          return;
        }
        resolve(stats);
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
  async rename(oldPath: string, newPath: string): Promise<DeleteResult> {
    const sftp = this.ensureSftp();

    return new Promise((resolve, reject) => {
      sftp.rename(oldPath, newPath, (err) => {
        if (err) {
          reject(new Error(`Failed to rename: ${err.message}`));
          return;
        }
        resolve({
          success: true,
          path: newPath,
          message: `Renamed ${oldPath} to ${newPath}`,
        });
      });
    });
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
