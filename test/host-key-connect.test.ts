import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import { SshToolHandlers } from "../src/tools/ssh-tools.js";
import { startSshTestServer, TEST_PASSWORD, TEST_USER } from "./helpers/ssh-test-server.js";

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
      connect_timeout: 3000,
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
      connect_timeout: 3000,
      keepalive_interval: 0,
    })).rejects.toThrow(/host key|Host denied|fingerprint/);
  });
});
