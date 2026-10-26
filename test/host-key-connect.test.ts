import { createHmac, randomBytes } from "crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import net from "net";
import { tmpdir } from "os";
import { join } from "path";
import { Server, utils as sshUtils, type Connection } from "ssh2";
import { afterEach, describe, expect, it } from "vitest";
import { SshToolHandlers } from "../src/tools/ssh-tools.js";
import { startSshTestServer, TEST_PASSWORD, TEST_USER } from "./helpers/ssh-test-server.js";

function listen(server: net.Server, port = 0): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("测试服务没有监听端口"));
        return;
      }
      resolve(address.port);
    });
  });
}

/** 只用 RSA 主机密钥的进程内 SSH 服务，用于验证换算法后的真实握手。 */
async function startRsaSshServer(): Promise<{ port: number; close: () => Promise<void> }> {
  const hostKey = sshUtils.generateKeyPairSync("rsa", { bits: 2048 }).private;
  const clients = new Set<Connection>();
  const server = new Server({ hostKeys: [hostKey] }, (client) => {
    clients.add(client);
    client.on("error", () => {});
    client.on("close", () => clients.delete(client));
    client.on("end", () => clients.delete(client));
    client.on("authentication", (ctx) => {
      if (ctx.method === "password" && ctx.username === TEST_USER && ctx.password === TEST_PASSWORD) {
        ctx.accept();
        return;
      }
      ctx.reject(["password"]);
    });
  });
  server.on("error", () => {});
  const port = await listen(server);
  return {
    port,
    close: () => new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      for (const client of clients) {
        try { client.end(); } catch { /* 忽略 */ }
      }
      server.close(() => finish());
      setTimeout(finish, 200);
    }),
  };
}

interface SwitchableProxy {
  port: number;
  setTarget: (next: number) => void;
  close: () => Promise<void>;
}

/** 同一监听端口可以在两次连接之间切换到不同后端，主机标记保持不变。 */
async function startSwitchableProxy(initialTarget: number): Promise<SwitchableProxy> {
  let target = initialTarget;
  const sockets = new Set<net.Socket>();
  const proxy = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    const upstream = net.connect(target, "127.0.0.1");
    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
    socket.on("close", () => upstream.destroy());
    upstream.on("close", () => socket.destroy());
    socket.pipe(upstream);
    upstream.pipe(socket);
  });
  proxy.on("error", () => {});
  const port = await listen(proxy);
  return {
    port,
    setTarget: (next: number) => {
      target = next;
    },
    close: () => new Promise((resolve) => {
      for (const socket of sockets) socket.destroy();
      proxy.close(() => resolve());
    }),
  };
}


describe("连接时校验主机密钥", () => {
  const closers: Array<() => Promise<void>> = [];
  const dirs: string[] = [];

  afterEach(async () => {
    for (const close of closers) await close();
    closers.length = 0;
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    dirs.length = 0;
  });

  async function server() {
    const started = await startSshTestServer();
    closers.push(() => started.close());
    const dir = mkdtempSync(join(tmpdir(), "ssh-mcp-host-"));
    dirs.push(dir);
    return { started, dir, knownHosts: join(dir, "known_hosts") };
  }

  it("错误指纹被拒绝，accept-new 会记录密钥并在后续连接复用", async () => {
    const { started, knownHosts } = await server();
    const handlers = new SshToolHandlers();
    const base = {
      host: "127.0.0.1",
      port: started.port,
      username: TEST_USER,
      password: TEST_PASSWORD,
      connect_timeout: 10000,
      keepalive_interval: 0,
      known_hosts_path: knownHosts,
    };

    await expect(handlers.connect({
      ...base,
      strict_host_key_checking: "accept-new",
      host_fingerprint: "SHA256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    })).rejects.toThrow(/fingerprint|SHA256|host key|Host denied/);
    expect(() => readFileSync(knownHosts, "utf8")).toThrow();

    const accepted = await handlers.connect({
      ...base,
      strict_host_key_checking: "accept-new",
    });
    expect(accepted.host_fingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]+$/);
    expect(accepted.host_key_type).toBe("ssh-ed25519");
    const recorded = readFileSync(knownHosts, "utf8");
    expect(recorded).toContain(`[127.0.0.1]:${started.port} ssh-ed25519`);

    await handlers.disconnect({ session_id: accepted.session_id });
    const again = await handlers.connect({
      ...base,
      strict_host_key_checking: "yes",
    });
    expect(again.host_fingerprint).toBe(accepted.host_fingerprint);
    await handlers.disconnect({ session_id: again.session_id });

    const tampered = recorded.replace(/ssh-ed25519\s+\S+/, "ssh-ed25519 AAAA");
    writeFileSync(knownHosts, tampered);
    await expect(handlers.connect({
      ...base,
      strict_host_key_checking: "accept-new",
    })).rejects.toThrow(/changed|mismatch|Host denied|host key/);
  });

  it("全局策略会作用于没有单独传参的 ssh_connect", async () => {
    const { started, knownHosts } = await server();
    writeFileSync(knownHosts, "");
    const handlers = new SshToolHandlers({
      strictHostKeyChecking: "yes",
      knownHostsPath: knownHosts,
    });
    await expect(handlers.connect({
      host: "127.0.0.1",
      port: started.port,
      username: TEST_USER,
      password: TEST_PASSWORD,
      connect_timeout: 10000,
      keepalive_interval: 0,
    })).rejects.toThrow(/host key|Host denied|fingerprint/);
  });

  it("大小写混合主机名命中明文和哈希记录，撤销记录同样大小写不敏感", async () => {
    const { started, knownHosts } = await server();
    const handlers = new SshToolHandlers();
    const base = {
      host: "localhost",
      port: started.port,
      username: TEST_USER,
      password: TEST_PASSWORD,
      connect_timeout: 10000,
      keepalive_interval: 0,
      known_hosts_path: knownHosts,
    };

    const initial = await handlers.connect({ ...base, strict_host_key_checking: "accept-new" });
    await handlers.disconnect({ session_id: initial.session_id });
    const [token, keyType, keyBase64] = readFileSync(knownHosts, "utf8").trim().split(/\s+/);
    expect(token).toBe(`[localhost]:${started.port}`);
    const fields = `${keyType} ${keyBase64}`;

    writeFileSync(knownHosts, `[LocalHost]:${started.port} ${fields}\n`);
    const plain = await handlers.connect({ ...base, strict_host_key_checking: "yes" });
    expect(plain.host_fingerprint).toBe(initial.host_fingerprint);
    await handlers.disconnect({ session_id: plain.session_id });

    const salt = randomBytes(8);
    const mac = createHmac("sha1", salt).update(token).digest("base64");
    writeFileSync(knownHosts, `|1|${salt.toString("base64")}|${mac} ${fields}\n`);
    const hashed = await handlers.connect({
      ...base,
      host: "LOCALHOST",
      strict_host_key_checking: "yes",
    });
    expect(hashed.host_fingerprint).toBe(initial.host_fingerprint);
    await handlers.disconnect({ session_id: hashed.session_id });

    // 外部 ssh-keygen -H 可能按原始大小写生成哈希；同拼写连接仍需命中。
    const originalToken = `[LocalHost]:${started.port}`;
    const originalSalt = randomBytes(8);
    const originalMac = createHmac("sha1", originalSalt).update(originalToken).digest("base64");
    writeFileSync(knownHosts, `|1|${originalSalt.toString("base64")}|${originalMac} ${fields}\n`);
    const hashedOriginal = await handlers.connect({
      ...base,
      host: "LocalHost",
      strict_host_key_checking: "yes",
    });
    expect(hashedOriginal.host_fingerprint).toBe(initial.host_fingerprint);
    await handlers.disconnect({ session_id: hashedOriginal.session_id });

    writeFileSync(knownHosts, `@revoked |1|${originalSalt.toString("base64")}|${originalMac} ${fields}\n`);
    await expect(handlers.connect({
      ...base,
      host: "LocalHost",
      strict_host_key_checking: "accept-new",
    })).rejects.toThrow(/revoked|host key|Host denied/);

    writeFileSync(knownHosts, `@revoked [LoCaLhOsT]:${started.port} ${fields}\n`);
    await expect(handlers.connect({
      ...base,
      strict_host_key_checking: "accept-new",
    })).rejects.toThrow(/revoked|host key|Host denied/);
  });

  it("否定模式命中时不会因同一行的正向模式而信任主机", async () => {
    const { started, knownHosts } = await server();
    const handlers = new SshToolHandlers();
    const base = {
      host: "localhost",
      port: started.port,
      username: TEST_USER,
      password: TEST_PASSWORD,
      connect_timeout: 10000,
      keepalive_interval: 0,
      known_hosts_path: knownHosts,
    };

    const initial = await handlers.connect({ ...base, strict_host_key_checking: "accept-new" });
    await handlers.disconnect({ session_id: initial.session_id });
    const [token, keyType, keyBase64] = readFileSync(knownHosts, "utf8").trim().split(/\s+/);
    expect(token).toBe(`[localhost]:${started.port}`);

    writeFileSync(knownHosts, `!${token},${token} ${keyType} ${keyBase64}\n`);
    await expect(handlers.connect({
      ...base,
      strict_host_key_checking: "yes",
    })).rejects.toThrow(/not in known_hosts|host key|Host denied/);
  });

  it("同一主机端口从 ed25519 切换到 RSA 时判定为密钥变化", async () => {
    const ed25519 = await startSshTestServer();
    const rsa = await startRsaSshServer();
    const proxy = await startSwitchableProxy(ed25519.port);
    closers.push(() => proxy.close(), () => ed25519.close(), () => rsa.close());
    const dir = mkdtempSync(join(tmpdir(), "ssh-mcp-host-"));
    dirs.push(dir);
    const knownHosts = join(dir, "known_hosts");
    const handlers = new SshToolHandlers();
    const base = {
      host: "127.0.0.1",
      port: proxy.port,
      username: TEST_USER,
      password: TEST_PASSWORD,
      connect_timeout: 10000,
      keepalive_interval: 0,
      known_hosts_path: knownHosts,
    };

    const first = await handlers.connect({ ...base, strict_host_key_checking: "accept-new" });
    expect(first.host_key_type).toBe("ssh-ed25519");
    await handlers.disconnect({ session_id: first.session_id });
    expect(readFileSync(knownHosts, "utf8")).toContain(`[127.0.0.1]:${proxy.port} ssh-ed25519`);

    proxy.setTarget(rsa.port);
    await expect(handlers.connect({
      ...base,
      strict_host_key_checking: "accept-new",
    })).rejects.toThrow(/changed|host key|Host denied/);
    const recorded = readFileSync(knownHosts, "utf8");
    expect(recorded).not.toContain("ssh-rsa");

    proxy.setTarget(ed25519.port);
    const again = await handlers.connect({ ...base, strict_host_key_checking: "yes" });
    expect(again.host_fingerprint).toBe(first.host_fingerprint);
    expect(again.host_key_type).toBe("ssh-ed25519");
    await handlers.disconnect({ session_id: again.session_id });
  });
});
