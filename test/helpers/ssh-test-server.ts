import { constants } from "fs";
import net from "net";
import { Server, utils, type Connection } from "ssh2";

const OPEN_MODE = utils.sftp.OPEN_MODE;
const STATUS_CODE = utils.sftp.STATUS_CODE;
const FILE_MODE = constants.S_IFREG | 0o644;
const DIR_MODE = constants.S_IFDIR | 0o755;

export const TEST_USER = "tester";
export const TEST_PASSWORD = "secret";

export interface MemorySftp {
  files: Map<string, Buffer>;
  dirs: Set<string>;
  /** STAT 报告的大小与实际内容不一致，用于校验失败路径 */
  statSizeOverride: Map<string, number>;
  failReads: boolean;
  failWrites: boolean;
  holdStat: boolean;
  holdRead: boolean;
  removeCount: number;
  /** 以写方式打开过的路径，用来统计写操作被重放了几次 */
  writeOpens: string[];
  mkdirAttempts: number;
  /** 下一次 STAT 请求返回指定状态码，模拟写入完成后连接出错 */
  statStatusOnce?: number;
  /** 下一次 MKDIR 创建目录后返回指定状态码，模拟响应丢失 */
  mkdirStatusOnce?: number;
}

export interface SshTestStats {
  passwordAttempts: number;
  execs: string[];
  sleepClosed: boolean;
  rejectAuth: boolean;
}

export interface SshTestServer {
  port: number;
  stats: SshTestStats;
  sftp: MemorySftp;
  dropClients: () => void;
  close: () => Promise<void>;
}

export interface GatedProxy {
  port: number;
  accepted: number;
  close: () => Promise<void>;
}

function attrsFor(mode: number, size: number) {
  const now = Math.floor(Date.now() / 1000);
  return { mode, uid: 0, gid: 0, size, atime: now, mtime: now };
}

/**
 * 进程内 SSH 服务：密码认证、exec、内存 SFTP。
 * 不访问外网，用于超时、重连和传输完整性测试。
 */
function createHostKey(): string {
  let lastError: Error | undefined;
  // ssh2 的同步密钥生成在并发握手时偶发产出无法解析的 OpenSSH 私钥，这里生成后先解析确认。
  for (let attempt = 0; attempt < 5; attempt++) {
    const generated = utils.generateKeyPairSync("ed25519");
    const parsed = utils.parseKey(generated.private);
    if (!(parsed instanceof Error)) return generated.private;
    lastError = parsed;
  }
  throw lastError ?? new Error("无法生成测试主机密钥");
}

export async function startSshTestServer(): Promise<SshTestServer> {
  const hostKey = createHostKey();
  const stats: SshTestStats = {
    passwordAttempts: 0,
    execs: [],
    sleepClosed: false,
    rejectAuth: false,
  };
  const sftpState: MemorySftp = {
    files: new Map(),
    dirs: new Set(),
    statSizeOverride: new Map(),
    failReads: false,
    failWrites: false,
    holdStat: false,
    holdRead: false,
    removeCount: 0,
    writeOpens: [],
    mkdirAttempts: 0,
  };
  const clients = new Set<Connection>();
  const handles = new Map<number, string>();
  let handleId = 1;

  const server = new Server({ hostKeys: [hostKey] }, (client) => {
    clients.add(client);
    client.on("error", () => {});
    client.on("end", () => clients.delete(client));
    client.on("close", () => clients.delete(client));

    client.on("authentication", (ctx) => {
      if (ctx.method !== "password") {
        ctx.reject(["password"]);
        return;
      }
      stats.passwordAttempts += 1;
      if (!stats.rejectAuth && ctx.username === TEST_USER && ctx.password === TEST_PASSWORD) {
        ctx.accept();
        return;
      }
      ctx.reject();
    });

    client.on("ready", () => {
      client.on("session", (accept) => {
        const session = accept();
        session.on("exec", (acceptExec, _reject, info) => {
          const command = info.command;
          stats.execs.push(command);
          const stream = acceptExec();
          if (command === "sleep") {
            const markClosed = () => {
              stats.sleepClosed = true;
            };
            stream.on("close", markClosed);
            stream.on("end", markClosed);
            session.on("close", markClosed);
            session.on("end", markClosed);
            return;
          }
          stream.write(`ok:${command}\n`);
          stream.exit(0);
          stream.end();
        });

        session.on("sftp", (acceptSftp) => {
          const sftp = acceptSftp();
          sftp.on("OPEN", (reqid, filename, flags) => {
            if (sftpState.dirs.has(filename)) {
              sftp.status(reqid, STATUS_CODE.FAILURE);
              return;
            }
            const writing = (flags & OPEN_MODE.WRITE) !== 0;
            if (!writing && !sftpState.files.has(filename)) {
              sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE);
              return;
            }
            if (writing) {
              sftpState.writeOpens.push(filename);
            }
            if (writing && !sftpState.files.has(filename)) {
              sftpState.files.set(filename, Buffer.alloc(0));
            }
            if (writing && (flags & OPEN_MODE.TRUNC) !== 0) {
              sftpState.files.set(filename, Buffer.alloc(0));
            }
            const id = handleId++;
            const handle = Buffer.alloc(4);
            handle.writeUInt32BE(id);
            handles.set(id, filename);
            sftp.handle(reqid, handle);
          });

          sftp.on("READ", (reqid, handle, offset, length) => {
            if (sftpState.holdRead) return;
            const id = handle.length === 4 ? handle.readUInt32BE(0) : -1;
            const path = handles.get(id);
            if (!path || !sftpState.files.has(path)) {
              sftp.status(reqid, STATUS_CODE.FAILURE);
              return;
            }
            if (sftpState.failReads) {
              sftp.status(reqid, STATUS_CODE.FAILURE);
              return;
            }
            const file = sftpState.files.get(path)!;
            if (offset >= file.length) {
              sftp.status(reqid, STATUS_CODE.EOF);
              return;
            }
            const end = Math.min(file.length, offset + length);
            sftp.data(reqid, Buffer.from(file.subarray(offset, end)));
          });

          sftp.on("WRITE", (reqid, handle, offset, data) => {
            const id = handle.length === 4 ? handle.readUInt32BE(0) : -1;
            const path = handles.get(id);
            if (!path || !sftpState.files.has(path)) {
              sftp.status(reqid, STATUS_CODE.FAILURE);
              return;
            }
            if (sftpState.failWrites) {
              sftp.status(reqid, STATUS_CODE.FAILURE);
              return;
            }
            const current = sftpState.files.get(path)!;
            const chunk = Buffer.from(data);
            const next = Buffer.alloc(Math.max(current.length, offset + chunk.length));
            current.copy(next);
            chunk.copy(next, offset);
            sftpState.files.set(path, next);
            sftp.status(reqid, STATUS_CODE.OK);
          });

          sftp.on("CLOSE", (reqid, handle) => {
            if (handle.length === 4) handles.delete(handle.readUInt32BE(0));
            sftp.status(reqid, STATUS_CODE.OK);
          });

          sftp.on("STAT", (reqid, path) => {
            if (sftpState.holdStat) return;
            if (sftpState.statStatusOnce !== undefined) {
              const code = sftpState.statStatusOnce;
              sftpState.statStatusOnce = undefined;
              sftp.status(reqid, code);
              return;
            }
            replyStat(sftp, reqid, path, sftpState);
          });
          sftp.on("LSTAT", (reqid, path) => {
            if (sftpState.holdStat) return;
            replyStat(sftp, reqid, path, sftpState);
          });

          sftp.on("FSETSTAT", (reqid) => sftp.status(reqid, STATUS_CODE.OK));
          sftp.on("SETSTAT", (reqid) => sftp.status(reqid, STATUS_CODE.OK));

          sftp.on("MKDIR", (reqid, path) => {
            sftpState.mkdirAttempts += 1;
            if (sftpState.dirs.has(path)) {
              sftp.status(reqid, STATUS_CODE.FAILURE);
              return;
            }
            sftpState.dirs.add(path);
            if (sftpState.mkdirStatusOnce !== undefined) {
              const code = sftpState.mkdirStatusOnce;
              sftpState.mkdirStatusOnce = undefined;
              sftp.status(reqid, code);
              return;
            }
            sftp.status(reqid, STATUS_CODE.OK);
          });

          sftp.on("REMOVE", (reqid, path) => {
            sftpState.removeCount += 1;
            if (!sftpState.files.has(path)) {
              sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE);
              return;
            }
            sftpState.files.delete(path);
            sftp.status(reqid, STATUS_CODE.OK);
          });

          sftp.on("RENAME", (reqid, oldPath, newPath) => {
            if (!sftpState.files.has(oldPath)) {
              sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE);
              return;
            }
            sftpState.files.set(newPath, sftpState.files.get(oldPath)!);
            sftpState.files.delete(oldPath);
            sftp.status(reqid, STATUS_CODE.OK);
          });

          sftp.on("REALPATH", (reqid, path) => {
            sftp.name(reqid, [{
              filename: path,
              longname: path,
              attrs: attrsFor(FILE_MODE, 0),
            }]);
          });
        });
      });
    });
  });

  server.on("error", () => {});
  const port = await listen(server);

  return {
    port,
    stats,
    sftp: sftpState,
    dropClients: () => {
      for (const client of clients) {
        try { client.end(); } catch { /* 测试连接可能已经关闭 */ }
      }
    },
    close: () => closeServer(server, () => {
      for (const client of clients) {
        try { client.end(); } catch { /* 忽略 */ }
      }
    }),
  };
}

function replyStat(
  sftp: { status: (reqid: number, code: number) => void; attrs: (reqid: number, attrs: ReturnType<typeof attrsFor>) => void },
  reqid: number,
  path: string,
  state: MemorySftp
): void {
  if (state.dirs.has(path)) {
    sftp.attrs(reqid, attrsFor(DIR_MODE, 0));
    return;
  }
  const file = state.files.get(path);
  if (!file) {
    sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE);
    return;
  }
  const size = state.statSizeOverride.get(path) ?? file.length;
  sftp.attrs(reqid, attrsFor(FILE_MODE, size));
}

/** 第一条 TCP 连接挂起，后续连接转发到目标端口。 */
export async function startGatedProxy(targetPort: number): Promise<GatedProxy> {
  const state = { accepted: 0 };
  const sockets = new Set<net.Socket>();
  const proxy = net.createServer((socket) => {
    state.accepted += 1;
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    const index = state.accepted;
    socket.on("error", () => {});
    if (index === 1) {
      socket.resume();
      return;
    }
    const upstream = net.connect(targetPort, "127.0.0.1");
    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
    socket.on("close", () => upstream.destroy());
    upstream.on("close", () => socket.destroy());
    socket.pipe(upstream);
    upstream.pipe(socket);
  });
  const port = await listen(proxy);
  return {
    port,
    get accepted() {
      return state.accepted;
    },
    close: () => closeServer(proxy, () => {
      for (const socket of sockets) socket.destroy();
    }),
  };
}

function closeServer(server: net.Server, destroy: () => void): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    destroy();
    server.close(() => finish());
    setTimeout(finish, 200);
  });
}

function listen(server: net.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("测试服务没有监听端口"));
        return;
      }
      resolve(address.port);
    });
  });
}

export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 2000
): Promise<void> {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("等待条件超时");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
