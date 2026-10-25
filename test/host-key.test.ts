import { createHash, createHmac, randomBytes } from "crypto";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import {
  decideHostKey,
  defaultKnownHostsPath,
  fingerprintHostKey,
  formatKnownHostLine,
  recordKnownHost,
} from "../src/utils/host-key.js";

function sshString(value: string): Buffer {
  const body = Buffer.from(value);
  const out = Buffer.alloc(4 + body.length);
  out.writeUInt32BE(body.length, 0);
  body.copy(out, 4);
  return out;
}

function fakeKey(type: string, secret: string): Buffer {
  return Buffer.concat([sshString(type), sshString(secret)]);
}

const keyA = fakeKey("ssh-ed25519", "key-a");
const keyB = fakeKey("ssh-ed25519", "key-b");
const rsaKey = fakeKey("ssh-rsa", "rsa-a");

describe("主机密钥判定", () => {
  it("指纹使用 OpenSSH 的 SHA256 base64 并去掉填充", () => {
    const fingerprint = fingerprintHostKey(keyA);
    const expected = createHash("sha256").update(keyA).digest("base64").replace(/=+$/, "");
    expect(fingerprint).toBe(`SHA256:${expected}`);
    expect(fingerprint.endsWith("=")).toBe(false);
  });

  it("未知主机在 accept-new 下接受并要求记录，yes 拒绝，no 接受但不记录", () => {
    const fresh = decideHostKey({
      key: keyA,
      host: "example.com",
      port: 22,
      policy: "accept-new",
      knownHostsContent: "",
    });
    expect(fresh.accept).toBe(true);
    expect(fresh.record).toBe(true);

    const strict = decideHostKey({
      key: keyA,
      host: "example.com",
      port: 22,
      policy: "yes",
      knownHostsContent: "",
    });
    expect(strict.accept).toBe(false);
    expect(strict.record).toBe(false);
    expect(strict.reason).toContain(strict.fingerprint);

    const off = decideHostKey({
      key: keyA,
      host: "example.com",
      port: 22,
      policy: "no",
      knownHostsContent: "",
    });
    expect(off.accept).toBe(true);
    expect(off.record).toBe(false);
  });

  it("已知密钥匹配时接受，同类型密钥变化时即使 accept-new 也拒绝", () => {
    const known = formatKnownHostLine("example.com", 22, keyA);
    const same = decideHostKey({
      key: keyA,
      host: "example.com",
      port: 22,
      policy: "yes",
      knownHostsContent: `# comment\n${known}\n`,
    });
    expect(same.accept).toBe(true);
    expect(same.record).toBe(false);

    const changed = decideHostKey({
      key: keyB,
      host: "example.com",
      port: 22,
      policy: "accept-new",
      knownHostsContent: known,
    });
    expect(changed.accept).toBe(false);
    expect(changed.record).toBe(false);
    expect(changed.reason).toMatch(/changed|mismatch|变化/);
  });

  it("非 22 端口、逗号多主机、通配符和哈希主机都能匹配", () => {
    const token = "[db.internal]:2222";
    const salt = randomBytes(8);
    const mac = createHmac("sha1", salt).update(token).digest("base64");
    const hashed = `|1|${salt.toString("base64")}|${mac} ${formatKnownHostLine("ignored", 22, keyA).split(" ").slice(1).join(" ")}`;
    const decision = decideHostKey({
      key: keyA,
      host: "db.internal",
      port: 2222,
      policy: "yes",
      knownHostsContent: hashed,
    });
    expect(decision.accept).toBe(true);

    const wildcard = decideHostKey({
      key: keyA,
      host: "a.example.com",
      port: 22,
      policy: "yes",
      knownHostsContent: `*.example.com ssh-ed25519 ${keyA.toString("base64")}`,
    });
    expect(wildcard.accept).toBe(true);

    const listed = decideHostKey({
      key: keyA,
      host: "b.example.com",
      port: 22,
      policy: "yes",
      knownHostsContent: `a.example.com,b.example.com ssh-ed25519 ${keyA.toString("base64")}`,
    });
    expect(listed.accept).toBe(true);
  });

  it("不同密钥类型不算密钥变化，指定指纹不匹配时拒绝", () => {
    const known = formatKnownHostLine("example.com", 22, rsaKey);
    const addedType = decideHostKey({
      key: keyA,
      host: "example.com",
      port: 22,
      policy: "accept-new",
      knownHostsContent: known,
    });
    expect(addedType.accept).toBe(true);
    expect(addedType.record).toBe(true);

    const pinned = decideHostKey({
      key: keyA,
      host: "example.com",
      port: 22,
      policy: "no",
      knownHostsContent: "",
      pinnedFingerprint: fingerprintHostKey(keyB),
    });
    expect(pinned.accept).toBe(false);
    expect(pinned.record).toBe(false);
  });

  it("撤销的密钥不能再被接受", () => {
    const line = `@revoked ${formatKnownHostLine("example.com", 22, keyA)}`;
    const decision = decideHostKey({
      key: keyA,
      host: "example.com",
      port: 22,
      policy: "accept-new",
      knownHostsContent: line,
    });
    expect(decision.accept).toBe(false);
  });

  it("默认 known_hosts 路径指向用户 .ssh 目录", () => {
    expect(defaultKnownHostsPath().endsWith(".ssh/known_hosts")).toBe(true);
  });
});

describe("known_hosts 记录", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    dirs.length = 0;
  });

  it("追加记录时创建文件，并保留已有内容", () => {
    const dir = mkdtempSync(join(tmpdir(), "ssh-mcp-known-"));
    dirs.push(dir);
    const file = join(dir, "nested", "known_hosts");
    recordKnownHost(file, formatKnownHostLine("example.com", 22, keyA));
    recordKnownHost(file, formatKnownHostLine("other.example.com", 2222, keyB));
    const text = readFileSync(file, "utf8");
    expect(text).toContain("example.com ssh-ed25519");
    expect(text).toContain("[other.example.com]:2222 ssh-ed25519");
    expect(text.trim().split("\n")).toHaveLength(2);
  });
});
