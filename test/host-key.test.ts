import { createHash, createHmac, randomBytes } from "crypto";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { homedir, tmpdir } from "os";
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

/** 只取 known_hosts 行的 "类型 base64" 部分，主机标记由调用方决定。 */
function keyFields(key: Buffer): string {
  return formatKnownHostLine("ignored", 22, key).split(" ").slice(1).join(" ");
}

/** OpenSSH |1| 哈希主机：HMAC-SHA1(salt, 规范化主机标记)。 */
function hashedPattern(token: string, salt: Buffer = randomBytes(8)): string {
  const mac = createHmac("sha1", salt).update(token).digest("base64");
  return `|1|${salt.toString("base64")}|${mac}`;
}

function hashedLine(token: string, key: Buffer, salt?: Buffer): string {
  return `${hashedPattern(token, salt)} ${keyFields(key)}`;
}

function decisionFor(options: {
  key: Buffer;
  host: string;
  port?: number;
  policy?: "yes" | "accept-new" | "no";
  knownHostsContent: string;
  pinnedFingerprint?: string;
}) {
  return decideHostKey({
    port: 22,
    policy: "yes",
    ...options,
  });
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
    const hashed = hashedLine(token, keyA);
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

  it("主机名大小写不敏感：明文、通配符、非 22 端口和哈希记录都能命中", () => {
    const cases = [
      { host: "example.com", port: 22, content: `Example.COM ${keyFields(keyA)}` },
      { host: "A.Example.COM", port: 22, content: `*.example.com ${keyFields(keyA)}` },
      { host: "db.internal", port: 2222, content: `[DB.Internal]:2222 ${keyFields(keyA)}` },
      { host: "EXAMPLE.COM", port: 22, content: hashedLine("example.com", keyA) },
      { host: "DB.Internal", port: 2222, content: hashedLine("[db.internal]:2222", keyA) },
    ];
    for (const item of cases) {
      const decision = decisionFor({
        key: keyA,
        host: item.host,
        port: item.port,
        knownHostsContent: item.content,
      });
      expect(decision.accept, `${item.host} 应命中已知主机`).toBe(true);
      expect(decision.record).toBe(false);
    }

    const mixedWildcard = decisionFor({
      key: keyA,
      host: "db.internal",
      port: 2222,
      knownHostsContent: `[*.internal]:2222 ${keyFields(keyA)}`,
    });
    expect(mixedWildcard.accept).toBe(true);
  });

  it("哈希模式的 base64 字节保持原样，只有主机标记被规范化", () => {
    // 找到含大写字母的 salt/hash，任何把整个模式转小写的实现都会匹配失败。
    let salt = randomBytes(8);
    for (let i = 0; i < 1000; i++) {
      if (/[A-Z]/.test(hashedPattern("example.com", salt))) break;
      salt = randomBytes(8);
    }
    const pattern = hashedPattern("example.com", salt);
    expect(pattern).toMatch(/[A-Z]/);

    const decision = decisionFor({
      key: keyA,
      host: "EXAMPLE.COM",
      knownHostsContent: `${pattern} ${keyFields(keyA)}`,
    });
    expect(decision.accept).toBe(true);
  });

  it("外部工具按原始大小写哈希时，同拼写主机仍能命中", () => {
    const originalToken = "Example.COM";
    const line = hashedLine(originalToken, keyA);

    const same = decisionFor({
      key: keyA,
      host: "Example.COM",
      knownHostsContent: line,
    });
    expect(same.accept).toBe(true);
    expect(same.record).toBe(false);

    const changed = decisionFor({
      key: keyB,
      host: "Example.COM",
      policy: "accept-new",
      knownHostsContent: line,
    });
    expect(changed.accept).toBe(false);
    expect(changed.record).toBe(false);
    expect(changed.reason).toMatch(/changed/);

    const revoked = decisionFor({
      key: keyA,
      host: "Example.COM",
      policy: "accept-new",
      knownHostsContent: `@revoked ${line}`,
    });
    expect(revoked.accept).toBe(false);
    expect(revoked.record).toBe(false);
    expect(revoked.reason).toMatch(/revoked/);

    const negatedOriginal = decisionFor({
      key: keyA,
      host: "Example.COM",
      policy: "accept-new",
      knownHostsContent: `!${hashedPattern(originalToken)},Example.COM ${keyFields(keyA)}`,
    });
    expect(negatedOriginal.accept).toBe(true);
    expect(negatedOriginal.record).toBe(true);

    const non22Token = "[DB.Internal]:2222";
    const non22Line = hashedLine(non22Token, keyA);
    const non22Same = decisionFor({
      key: keyA,
      host: "DB.Internal",
      port: 2222,
      knownHostsContent: non22Line,
    });
    expect(non22Same.accept).toBe(true);
    expect(non22Same.record).toBe(false);

    const non22Changed = decisionFor({
      key: keyB,
      host: "DB.Internal",
      port: 2222,
      policy: "accept-new",
      knownHostsContent: non22Line,
    });
    expect(non22Changed.accept).toBe(false);
    expect(non22Changed.record).toBe(false);
    expect(non22Changed.reason).toMatch(/changed/);

    const non22Revoked = decisionFor({
      key: keyA,
      host: "DB.Internal",
      port: 2222,
      policy: "accept-new",
      knownHostsContent: `@revoked ${non22Line}`,
    });
    expect(non22Revoked.accept).toBe(false);
    expect(non22Revoked.record).toBe(false);
    expect(non22Revoked.reason).toMatch(/revoked/);
  });

  it("大小写混合的主机名不能绕过变化和撤销判定", () => {
    const changed = decisionFor({
      key: keyB,
      host: "example.com",
      policy: "accept-new",
      knownHostsContent: `Example.COM ${keyFields(keyA)}`,
    });
    expect(changed.accept).toBe(false);
    expect(changed.record).toBe(false);
    expect(changed.reason).toMatch(/changed/);

    const revokedPlain = decisionFor({
      key: keyA,
      host: "example.com",
      policy: "accept-new",
      knownHostsContent: `@revoked Example.COM ${keyFields(keyA)}`,
    });
    expect(revokedPlain.accept).toBe(false);
    expect(revokedPlain.reason).toMatch(/revoked/);

    const revokedHashed = decisionFor({
      key: keyA,
      host: "EXAMPLE.COM",
      policy: "accept-new",
      knownHostsContent: `@revoked ${hashedLine("example.com", keyA)}`,
    });
    expect(revokedHashed.accept).toBe(false);
    expect(revokedHashed.reason).toMatch(/revoked/);

    const revokedNon22 = decisionFor({
      key: keyA,
      host: "DB.Internal",
      port: 2222,
      policy: "accept-new",
      knownHostsContent: `@revoked ${hashedLine("[db.internal]:2222", keyA)}`,
    });
    expect(revokedNon22.accept).toBe(false);
    expect(revokedNon22.reason).toMatch(/revoked/);
  });

  it("否定模式要求正向命中且没有负向命中", () => {
    const wildcardWithNegative = `!bad.example.com,*.example.com ${keyFields(keyA)}`;

    const blocked = decisionFor({
      key: keyA,
      host: "bad.example.com",
      policy: "accept-new",
      knownHostsContent: wildcardWithNegative,
    });
    expect(blocked.accept).toBe(true);
    expect(blocked.record).toBe(true);

    const allowed = decisionFor({
      key: keyA,
      host: "good.example.com",
      knownHostsContent: wildcardWithNegative,
    });
    expect(allowed.accept).toBe(true);
    expect(allowed.record).toBe(false);

    const negatedExact = decisionFor({
      key: keyA,
      host: "example.com",
      policy: "accept-new",
      knownHostsContent: `example.com,!EXAMPLE.com ${keyFields(keyA)}`,
    });
    expect(negatedExact.accept).toBe(true);
    expect(negatedExact.record).toBe(true);

    const onlyNegative = decisionFor({
      key: keyA,
      host: "example.com",
      policy: "accept-new",
      knownHostsContent: `!example.com ${keyFields(keyA)}`,
    });
    expect(onlyNegative.accept).toBe(true);
    expect(onlyNegative.record).toBe(true);

    const starNegative = `*,!bad.example.com ${keyFields(keyA)}`;
    expect(decisionFor({ key: keyA, host: "bad.example.com", policy: "accept-new", knownHostsContent: starNegative }).record)
      .toBe(true);
    expect(decisionFor({ key: keyA, host: "good.example.com", knownHostsContent: starNegative }).accept)
      .toBe(true);

    const negatedHash = decisionFor({
      key: keyA,
      host: "example.com",
      policy: "accept-new",
      knownHostsContent: `!${hashedPattern("example.com")},example.com ${keyFields(keyA)}`,
    });
    expect(negatedHash.accept).toBe(true);
    expect(negatedHash.record).toBe(true);
  });

  it("不同密钥类型也算密钥变化，指定指纹不匹配时拒绝", () => {
    const knownRsa = formatKnownHostLine("example.com", 22, rsaKey);
    const addedType = decideHostKey({
      key: keyA,
      host: "example.com",
      port: 22,
      policy: "accept-new",
      knownHostsContent: knownRsa,
    });
    expect(addedType.accept).toBe(false);
    expect(addedType.record).toBe(false);
    expect(addedType.reason).toMatch(/changed/);

    const knownEd25519 = formatKnownHostLine("example.com", 22, keyA);
    const swappedType = decideHostKey({
      key: rsaKey,
      host: "example.com",
      port: 22,
      policy: "accept-new",
      knownHostsContent: knownEd25519,
    });
    expect(swappedType.accept).toBe(false);
    expect(swappedType.record).toBe(false);
    expect(swappedType.reason).toMatch(/changed/);

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

  it("精确匹配优先，撤销优先于普通记录", () => {
    const content = [
      `example.com ${keyFields(keyA)}`,
      `example.com ${keyFields(keyB)}`,
      `@revoked example.com ${keyFields(keyB)}`,
    ].join("\n");

    const exact = decisionFor({ key: keyA, host: "example.com", knownHostsContent: content });
    expect(exact.accept).toBe(true);
    expect(exact.record).toBe(false);

    const revoked = decisionFor({
      key: keyB,
      host: "example.com",
      policy: "accept-new",
      knownHostsContent: content,
    });
    expect(revoked.accept).toBe(false);
    expect(revoked.reason).toMatch(/revoked/);
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

  it("固定指纹先于 known_hosts 判定，并忽略前缀大小写和 base64 填充", () => {
    const fingerprint = fingerprintHostKey(keyA);
    const padded = `sha256:${fingerprint.slice("SHA256:".length)}=`;

    const accepted = decisionFor({
      key: keyA,
      host: "example.com",
      policy: "accept-new",
      knownHostsContent: "",
      pinnedFingerprint: padded,
    });
    expect(accepted.accept).toBe(true);
    expect(accepted.record).toBe(true);

    const pinFirst = decisionFor({
      key: keyA,
      host: "example.com",
      policy: "yes",
      knownHostsContent: `@revoked example.com ${keyFields(keyA)}`,
      pinnedFingerprint: fingerprintHostKey(keyB),
    });
    expect(pinFirst.accept).toBe(false);
    expect(pinFirst.reason).toMatch(/fingerprint/);
  });

  it("policy=no 跳过 known_hosts 但固定指纹仍然生效", () => {
    const changedContent = `@revoked ${formatKnownHostLine("example.com", 22, keyA)}`;
    const off = decisionFor({
      key: keyB,
      host: "example.com",
      policy: "no",
      knownHostsContent: changedContent,
    });
    expect(off.accept).toBe(true);
    expect(off.record).toBe(false);

    const pinnedOff = decisionFor({
      key: keyB,
      host: "example.com",
      policy: "no",
      knownHostsContent: changedContent,
      pinnedFingerprint: fingerprintHostKey(keyA),
    });
    expect(pinnedOff.accept).toBe(false);
    expect(pinnedOff.reason).toMatch(/fingerprint/);
  });

  it("默认 known_hosts 路径指向用户 .ssh 目录", () => {
    expect(defaultKnownHostsPath()).toBe(join(homedir(), ".ssh", "known_hosts"));
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
