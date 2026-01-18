import { COMMAND_MAX_CHARS } from "../constants.js";

// 清洗并校验命令输入
export function sanitizeCommand(command: string): string {
  if (typeof command !== "string") {
    throw new Error("command must be a string");
  }

  const trimmed = command.trim();
  if (!trimmed) {
    throw new Error("command cannot be empty");
  }

  if (trimmed.length > COMMAND_MAX_CHARS) {
    throw new Error(`command exceeds ${COMMAND_MAX_CHARS} characters`);
  }

  return trimmed;
}
