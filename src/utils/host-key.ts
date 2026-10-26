import { createHash, createHmac, timingSafeEqual } from "crypto";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import { expandHomePath } from "./path.js";

export type HostKeyPolicy = "yes" | "accept-new" | "no";

export const DEFAULT_HOST_KEY_POLICY: HostKeyPolicy = "accept-new";

export interface HostKeyDecision {
  accept: boolean;
  /** 为 true 时把该密钥追加到 known_hosts，只用于首次看到的主机。 */
  record: boolean;
  fingerprint: string;
  keyType: string;
  reason: string;
}

interface KnownHostEntry {
  revoked: boolean;
  certAuthority: boolean;
  patterns: string[];
  keyType: string;
  keyBase64: string;
}

/** OpenSSH 风格的 SHA256 指纹，不带 base64 填充。 */
export function fingerprintHostKey(key: Buffer): string {
  const encoded = createHash("sha256").update(key).digest("base64").replace(/=+$/, "");
  return `SHA256:${encoded}`;
}

/** 默认 known_hosts 路径：~/.ssh/known_hosts。 */
export function defaultKnownHostsPath(): string {
  return join(homedir(), ".ssh", "known_hosts");
}

/** 端口 22 使用主机名，其余端口使用 OpenSSH 的 [host]:port。 */
export function hostToken(host: string, port: number): string {
  if (port === 22) return host;
  return `[${host}]:${port}`;
}

/** 生成一行 known_hosts 记录。 */
export function formatKnownHostLine(host: string, port: number, key: Buffer): string {
  return `${hostToken(host, port)} ${readKeyType(key)} ${key.toString("base64")}`;
}

/** 读取 known_hosts 内容；文件不存在时返回空字符串。 */
export function readKnownHosts(filePath: string): string {
  const expanded = expandHomePath(filePath);
  if (!existsSync(expanded)) return "";
  return readFileSync(expanded, "utf8");
}

/** 追加一行密钥。目录不存在时创建，文件权限收紧到仅当前用户可读写。 */
export function recordKnownHost(filePath: string, line: string): void {
  const expanded = expandHomePath(filePath);
  mkdirSync(dirname(expanded), { recursive: true, mode: 0o700 });
  let prefix = "";
  if (existsSync(expanded)) {
    const current = readFileSync(expanded, "utf8");
    if (current.length > 0 && !current.endsWith("\n")) prefix = "\n";
  }
  appendFileSync(expanded, `${prefix}${line}\n`, { mode: 0o600 });
  chmodSync(expanded, 0o600);
}

/** 根据策略、known_hosts 和固定指纹决定是否接受本次主机密钥。 */
export function decideHostKey(options: {
  key: Buffer;
  host: string;
  port: number;
  policy: HostKeyPolicy;
  knownHostsContent: string;
  pinnedFingerprint?: string;
}): HostKeyDecision {
  const fingerprint = fingerprintHostKey(options.key);
  const keyType = readKeyType(options.key);
  const token = hostToken(options.host, options.port);

  if (options.pinnedFingerprint && !fingerprintsMatch(fingerprint, options.pinnedFingerprint)) {
    return {
      accept: false,
      record: false,
      fingerprint,
      keyType,
      reason: `host key fingerprint mismatch: expected ${normalizeFingerprint(options.pinnedFingerprint)}, got ${fingerprint}`,
    };
  }

  // policy=no 跳过文件比对，但上面的固定指纹仍然生效。
  if (options.policy === "no") {
    return {
      accept: true,
      record: false,
      fingerprint,
      keyType,
      reason: "host key checking disabled",
    };
  }

  let exact = false;
  let revokedExact = false;
  let changed = false;
  for (const entry of parseKnownHosts(options.knownHostsContent)) {
    // CA 行不是主机密钥本身；本实现不做证书验证，保持忽略。
    if (entry.certAuthority) continue;
    if (!patternListMatches(entry.patterns, token)) continue;
    if (keysEqual(options.key, entry.keyBase64)) {
      if (entry.revoked) revokedExact = true;
      else exact = true;
    } else if (!entry.revoked) {
      // 同一主机已有任何不匹配的密钥（包括其他算法）都视为变化，不能再当新主机记录。
      changed = true;
    }
  }

  if (revokedExact) {
    return {
      accept: false,
      record: false,
      fingerprint,
      keyType,
      reason: `host key is revoked for ${token}`,
    };
  }
  if (exact) {
    return {
      accept: true,
      record: false,
      fingerprint,
      keyType,
      reason: "host key matches known_hosts",
    };
  }
  if (changed) {
    return {
      accept: false,
      record: false,
      fingerprint,
      keyType,
      reason: `host key changed for ${token}`,
    };
  }
  if (options.policy === "yes") {
    return {
      accept: false,
      record: false,
      fingerprint,
      keyType,
      reason: `host key is not in known_hosts: ${fingerprint}`,
    };
  }
  return {
    accept: true,
    record: true,
    fingerprint,
    keyType,
    reason: `new host key accepted for ${token}`,
  };
}

function readKeyType(key: Buffer): string {
  if (key.length < 4) return "unknown";
  const length = key.readUInt32BE(0);
  if (length <= 0 || 4 + length > key.length) return "unknown";
  return key.subarray(4, 4 + length).toString("utf8");
}

function parseKnownHosts(content: string): KnownHostEntry[] {
  const entries: KnownHostEntry[] = [];
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const tokens = line.split(/\s+/);
    let index = 0;
    let revoked = false;
    let certAuthority = false;
    if (tokens[0] === "@revoked") {
      revoked = true;
      index = 1;
    } else if (tokens[0] === "@cert-authority") {
      certAuthority = true;
      index = 1;
    }
    if (tokens.length < index + 3) continue;
    entries.push({
      revoked,
      certAuthority,
      patterns: tokens[index].split(","),
      keyType: tokens[index + 1],
      keyBase64: tokens[index + 2],
    });
  }
  return entries;
}

/** 主机名中的 ASCII 字母按 DNS 规则折叠为小写；base64 哈希模式必须保持原字节。 */
function canonicalHostToken(value: string): string {
  return value.replace(/[A-Z]/g, (char) => char.toLowerCase());
}

/**
 * OpenSSH 模式列表：至少命中一个正向模式，且不能命中任何 ! 负向模式。
 * 只有负向模式的行永远不匹配，不能单靠 ! 建立信任。
 * 哈希模式可能由外部工具按原始大小写主机标记生成，因此同时尝试原始标记和规范化标记。
 */
function patternListMatches(patterns: string[], token: string): boolean {
  const canonicalToken = canonicalHostToken(token);
  let positive = false;
  for (const pattern of patterns) {
    const negated = pattern.startsWith("!");
    const body = negated ? pattern.slice(1) : pattern;
    if (!body) continue;
    const matched = body.startsWith("|1|")
      ? hashedHostMatches(token, body) || hashedHostMatches(canonicalToken, body)
      : patternMatches(body, canonicalToken);
    if (!matched) continue;
    if (negated) return false;
    positive = true;
  }
  return positive;
}

function patternMatches(pattern: string, canonicalToken: string): boolean {
  const canonicalPattern = canonicalHostToken(pattern);
  if (!canonicalPattern.includes("*") && !canonicalPattern.includes("?")) {
    return canonicalPattern === canonicalToken;
  }

  // OpenSSH 通配符：* 和 ?。其余字符按字面量匹配。
  let source = "^";
  for (const char of canonicalPattern) {
    if (char === "*") source += ".*";
    else if (char === "?") source += ".";
    else source += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  source += "$";
  return new RegExp(source).test(canonicalToken);
}

/** OpenSSH |1| 哈希主机：HMAC-SHA1 的密钥是 salt，数据是主机标记。 */
function hashedHostMatches(token: string, pattern: string): boolean {
  const parts = pattern.split("|");
  if (parts.length !== 4 || parts[1] !== "1") return false;
  try {
    const salt = Buffer.from(parts[2], "base64");
    const expected = Buffer.from(parts[3], "base64");
    const actual = createHmac("sha1", salt).update(token).digest();
    if (actual.length !== expected.length) return false;
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

function keysEqual(presented: Buffer, storedBase64: string): boolean {
  const stored = Buffer.from(storedBase64, "base64");
  if (stored.length !== presented.length) return false;
  return timingSafeEqual(stored, presented);
}

function normalizeFingerprint(value: string): string {
  const trimmed = value.trim();
  const body = trimmed.replace(/^SHA256:/i, "").replace(/=+$/, "");
  return `SHA256:${body}`;
}

function fingerprintsMatch(actual: string, pinned: string): boolean {
  const left = Buffer.from(normalizeFingerprint(actual));
  const right = Buffer.from(normalizeFingerprint(pinned));
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
