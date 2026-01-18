import { describe, it, expect } from "vitest";
import { CHARACTER_LIMIT } from "../src/constants";

describe("constants", () => {
  it("exports CHARACTER_LIMIT", () => {
    expect(CHARACTER_LIMIT).toBeGreaterThan(0);
  });
});
