import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { homedir } from "node:os";
import { expandHomePath } from "../src/utils/path.js";

describe("expandHomePath", () => {
  it("expands a leading tilde to the current user's home directory", () => {
    expect(expandHomePath("~/.ssh/id_rsa")).toBe(join(homedir(), ".ssh/id_rsa"));
  });

  it("keeps non-home paths unchanged", () => {
    expect(expandHomePath("/tmp/file.txt")).toBe("/tmp/file.txt");
    expect(expandHomePath("relative/file.txt")).toBe("relative/file.txt");
  });

  it("does not expand a tilde used inside a path segment", () => {
    expect(expandHomePath("/tmp/~archive/file.txt")).toBe("/tmp/~archive/file.txt");
  });
});
