import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import { utils } from "ssh2";
import { SshToolHandlers } from "../src/tools/ssh-tools.js";
import { startSshTestServer, TEST_PASSWORD, TEST_USER } from "./helpers/ssh-test-server.js";

const CONNECTION_LOST = utils.sftp.STATUS_CODE.CONNECTION_LOST;

describe("SFTP 写操作不会在断线后重放", () => {
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
    const dir = mkdtempSync(join(tmpdir(), "ssh-mcp-sftp-retry-"));
    dirs.push(dir);
    const handlers = new SshToolHandlers({
      maxReconnectAttempts: 3,
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

  it("上传中途断线不会重新上传", async () => {
    const { server, handlers, dir, sessionId } = await setup();
    const local = join(dir, "upload.txt");
    writeFileSync(local, "hello world");
    server.sftp.statStatusOnce = CONNECTION_LOST;

    await expect(handlers.sftpUpload({
      session_id: sessionId,
      local_path: local,
      remote_path: "/data.txt",
    })).rejects.toThrow();
    expect(server.sftp.writeOpens).toHaveLength(1);
  });

  it("远程写入中途断线不会重新写入", async () => {
    const { server, handlers, sessionId } = await setup();
    server.sftp.statStatusOnce = CONNECTION_LOST;

    await expect(handlers.sftpWrite({
      session_id: sessionId,
      path: "/data.txt",
      content: "NEW",
    })).rejects.toThrow();
    expect(server.sftp.writeOpens).toHaveLength(1);
  });

  it("创建目录在远端已完成后断线不会重试", async () => {
    const { server, handlers, sessionId } = await setup();
    server.sftp.mkdirStatusOnce = CONNECTION_LOST;

    await expect(handlers.sftpMkdir({
      session_id: sessionId,
      path: "/newdir",
    })).rejects.toThrow();
    expect(server.sftp.mkdirAttempts).toBe(1);
  });
});
