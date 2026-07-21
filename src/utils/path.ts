import { homedir } from "node:os";
import { join } from "node:path";

/**
 * 展开用户目录路径。
 *
 * Cursor MCP 配置里常写 `~/.ssh/id_rsa`，但 Node.js 的 fs API 不会自动
 * 识别 `~`。这里仅展开开头的 `~` 或 `~/`，避免误改路径中间的普通字符。
 */
export function expandHomePath(path: string): string {
  if (path === "~") {
    return homedir();
  }

  if (path.startsWith("~/")) {
    return join(homedir(), path.slice(2));
  }

  return path;
}
