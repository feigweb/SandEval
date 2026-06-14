import { describe, it, expect } from "vitest";
import { extractContextMentions } from "./contexts.js";

describe("extractContextMentions", () => {
  it("extracts context mentions from prompt", () => {
    const prompt = "Build a page using @workspace and @skill:frontend-ui";
    const result = extractContextMentions(prompt);
    expect(result).toContain("workspace");
  });

  it("deduplicates mentions", () => {
    const prompt = "Use @workspace twice @workspace again";
    const result = extractContextMentions(prompt);
    expect(result.filter((n) => n === "workspace").length).toBe(1);
  });

  it("returns empty array when no mentions", () => {
    const prompt = "Build a simple app";
    const result = extractContextMentions(prompt);
    expect(result).toHaveLength(0);
  });

  it("handles multiple different contexts", () => {
    const prompt = "Use @backend and @frontend";
    const result = extractContextMentions(prompt);
    expect(result).toContain("backend");
    expect(result).toContain("frontend");
  });
});
