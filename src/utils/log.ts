/** 日志输出到 stderr，避免干扰 MCP 协议通信。 */
export function log(message: string): void {
  console.error(`[SSH-MCP] ${new Date().toISOString()} ${message}`);
}
