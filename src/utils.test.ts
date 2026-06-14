import { describe, it, expect } from "vitest";
import { estimateTokens, truncate, sumUsage, createRunId, stringifyError, stripJsonFence } from "./utils.js";

describe("estimateTokens", () => {
  it("estimates tokens based on text length", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("hello")).toBe(2); // 5 chars / 4 = 1.25, ceil = 2
    expect(estimateTokens("a".repeat(100))).toBe(25);
  });
});

describe("truncate", () => {
  it("returns text unchanged if under maxLength", () => {
    expect(truncate("short", 100)).toBe("short");
  });

  it("truncates text exceeding maxLength", () => {
    const result = truncate("hello world", 5);
    expect(result).toBe("hello\n...<truncated 6 chars>");
  });
});

describe("sumUsage", () => {
  it("sums token counts", () => {
    const result = sumUsage([
      { inputTokens: 100, outputTokens: 50 },
      { inputTokens: 200, outputTokens: 30 }
    ]);
    expect(result.inputTokens).toBe(300);
    expect(result.outputTokens).toBe(80);
  });

  it("handles undefined values", () => {
    const result = sumUsage([undefined, { inputTokens: 100 }]);
    expect(result.inputTokens).toBe(100);
  });
});

describe("createRunId", () => {
  it("creates a unique run ID", () => {
    const id1 = createRunId();
    const id2 = createRunId();
    expect(id1).not.toBe(id2);
    expect(id1).toMatch(/^run-/);
  });

  it("uses custom prefix", () => {
    const id = createRunId("test");
    expect(id).toMatch(/^test-/);
  });
});

describe("stringifyError", () => {
  it("stringifies Error objects", () => {
    const error = new Error("test error");
    const result = stringifyError(error);
    expect(result).toContain("test error");
  });

  it("stringifies non-Error values", () => {
    expect(stringifyError("string error")).toBe("string error");
    expect(stringifyError(42)).toBe("42");
  });
});

describe("stripJsonFence", () => {
  it("removes JSON code fence", () => {
    const input = '```json\n{"key": "value"}\n```';
    expect(stripJsonFence(input)).toBe('{"key": "value"}');
  });

  it("handles plain JSON", () => {
    const input = '{"key": "value"}';
    expect(stripJsonFence(input)).toBe('{"key": "value"}');
  });
});
