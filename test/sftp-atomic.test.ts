import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import { SshToolHandlers } from "../src/tools/ssh-tools.js";
import { startSshTestServer, TEST_PASSWORD, TEST_USER } from "./helpers/ssh-test-server.js";

describe("原子文件传输", () => {
  const closers: Array<() => Promise<void>> = [];
  const dirs: string[] = [];

  afterEach(async () => {
    for (const close of closers) await close();
    closers.length = 0;
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    dirs.length = 0;
  });

  async function setup() {
    const server = await startSshTestServer();
    closers.push(() => server.close());
    const dir = mkdtempSync(join(tmpdir(), "ssh-mcp-sftp-"));
    dirs.push(dir);
    const handlers = new SshToolHandlers({
      maxReconnectAttempts: 1,
      reconnectBaseDelay: 10,
      reconnectMaxDelay: 20,
      strictHostKeyChecking: "no",
      knownHostsPath: join(dir, "known_hosts"),
    });
    const connected = await handlers.connect({
      host: "127.0.0.1",
      port: server.port,
      username: TEST_USER,
      password: TEST_PASSWORD,
      timeout: 3000,
      connect_timeout: 3000,
      keepalive_interval: 0,
    });
    return { server, handlers, dir, sessionId: connected.session_id };
  }

  it("下载目录或远端读取失败时不改动已有本地文件", async () => {
    const { server, handlers, dir, sessionId } = await setup();
    const local = join(dir, "important.conf");
    writeFileSync(local, "ORIGINAL");
    server.sftp.dirs.add("/var/log");

    await expect(handlers.sftpDownload({
      session_id: sessionId,
      remote_path: "/var/log",
      local_path: local,
    })).rejects.toThrow(/directory/);
    expect(readFileSync(local, "utf8")).toBe("ORIGINAL");

    server.sftp.files.set("/remote.txt", Buffer.from("new-content"));
    server.sftp.failReads = true;
    await expect(handlers.sftpDownload({
      session_id: sessionId,
      remote_path: "/remote.txt",
      local_path: local,
    })).rejects.toThrow();
    expect(readFileSync(local, "utf8")).toBe("ORIGINAL");
  });

  it("下载字节数与远端大小不一致时不替换本地文件", async () => {
    const { server, handlers, dir, sessionId } = await setup();
    const local = join(dir, "important.conf");
    writeFileSync(local, "ORIGINAL");
    server.sftp.files.set("/remote.txt", Buffer.from("abcd"));
    server.sftp.statSizeOverride.set("/remote.txt", 100);

    await expect(handlers.sftpDownload({
      session_id: sessionId,
      remote_path: "/remote.txt",
      local_path: local,
    })).rejects.toThrow(/size mismatch/);
    expect(readFileSync(local, "utf8")).toBe("ORIGINAL");
  });

  it("下载成功后替换本地文件，不留下临时文件", async () => {
    const { server, handlers, dir, sessionId } = await setup();
    const local = join(dir, "important.conf");
    writeFileSync(local, "ORIGINAL");
    server.sftp.files.set("/remote.txt", Buffer.from("hello"));

    const result = await handlers.sftpDownload({
      session_id: sessionId,
      remote_path: "/remote.txt",
      local_path: local,
    });
    expect(result.size).toBe(5);
    expect(readFileSync(local, "utf8")).toBe("hello");
    expect(readdirSync(dir).some((name) => name.includes(".part-"))).toBe(false);
  });

  it("上传中断或本地是目录时不覆盖远端原文件", async () => {
    const { server, handlers, dir, sessionId } = await setup();
    server.sftp.files.set("/data.txt", Buffer.from("ORIGINAL"));
    server.sftp.failWrites = true;
    const local = join(dir, "upload.txt");
    writeFileSync(local, "NEW");

    await expect(handlers.sftpUpload({
      session_id: sessionId,
      local_path: local,
      remote_path: "/data.txt",
    })).rejects.toThrow();
    expect(server.sftp.files.get("/data.txt")?.toString()).toBe("ORIGINAL");
    expect([...server.sftp.files.keys()].some((path) => path.includes(".part-"))).toBe(false);

    server.sftp.failWrites = false;
    const folder = join(dir, "folder");
    mkdirSync(folder);
    await expect(handlers.sftpUpload({
      session_id: sessionId,
      local_path: folder,
      remote_path: "/data.txt",
    })).rejects.toThrow(/directory/);
    expect(server.sftp.files.get("/data.txt")?.toString()).toBe("ORIGINAL");
  });

  it("上传和远程写入成功后内容与字节数一致", async () => {
    const { server, handlers, dir, sessionId } = await setup();
    const local = join(dir, "upload.txt");
    writeFileSync(local, "你好");
    server.sftp.files.set("/data.txt", Buffer.from("ORIGINAL"));

    const uploaded = await handlers.sftpUpload({
      session_id: sessionId,
      local_path: local,
      remote_path: "/data.txt",
    });
    expect(uploaded.size).toBe(Buffer.byteLength("你好"));
    expect(server.sftp.files.get("/data.txt")?.toString("utf8")).toBe("你好");
    expect([...server.sftp.files.keys()].some((path) => path.includes(".part-"))).toBe(false);

    await handlers.sftpWrite({
      session_id: sessionId,
      path: "/data.txt",
      content: "replaced",
    });
    expect(server.sftp.files.get("/data.txt")?.toString("utf8")).toBe("replaced");
    expect([...server.sftp.files.keys()].some((path) => path.includes(".part-"))).toBe(false);
  });

  it("远程写入中断时保留原文件", async () => {
    const { server, handlers, sessionId } = await setup();
    server.sftp.files.set("/data.txt", Buffer.from("ORIGINAL"));
    server.sftp.failWrites = true;
    await expect(handlers.sftpWrite({
      session_id: sessionId,
      path: "/data.txt",
      content: "NEW",
    })).rejects.toThrow();
    expect(server.sftp.files.get("/data.txt")?.toString()).toBe("ORIGINAL");
  });
});
