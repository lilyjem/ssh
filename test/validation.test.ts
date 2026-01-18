import { describe, it, expect } from "vitest";
import { sanitizeCommand } from "../src/utils/validation";
import { COMMAND_MAX_CHARS } from "../src/constants";

describe("sanitizeCommand", () => {
  it("rejects empty command", () => {
    expect(() => sanitizeCommand("")).toThrow();
    expect(() => sanitizeCommand("   ")).toThrow();
  });

  it("trims whitespace", () => {
    expect(sanitizeCommand("  echo ok  ")).toBe("echo ok");
  });

  it("rejects overly long command", () => {
    const longCommand = "x".repeat(COMMAND_MAX_CHARS + 1);
    expect(() => sanitizeCommand(longCommand)).toThrow();
  });
});
