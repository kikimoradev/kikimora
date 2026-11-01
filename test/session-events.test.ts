import { describe, expect, it } from "vitest";
import {
  boundText,
  describeToolUse,
  formatDroppedLines,
  LIVE_FIELD_MAX,
  truncate,
} from "../src/session-events.js";

describe("describeToolUse", () => {
  it("extracts the primary argument for known tools", () => {
    expect(describeToolUse("Bash", { command: "git status" })).toEqual({
      name: "Bash",
      detail: "git status",
    });
    expect(describeToolUse("Grep", { pattern: "TODO", path: "src" })).toEqual({
      name: "Grep",
      detail: "TODO",
    });
    expect(describeToolUse("WebFetch", { url: "https://example.com" })).toEqual({
      name: "WebFetch",
      detail: "https://example.com",
    });
  });

  it("strips the working directory from file paths", () => {
    expect(describeToolUse("Read", { file_path: "/repo/src/index.ts" }, "/repo")).toEqual(
      { name: "Read", detail: "src/index.ts" },
    );
    expect(describeToolUse("Edit", { file_path: "/elsewhere/file.ts" }, "/repo")).toEqual(
      { name: "Edit", detail: "/elsewhere/file.ts" },
    );
  });

  it("summarizes TodoWrite by item count", () => {
    expect(describeToolUse("TodoWrite", { todos: [{}, {}, {}] })).toEqual({
      name: "TodoWrite",
      detail: "3 items",
    });
  });

  it("shortens MCP tool names to server:tool", () => {
    expect(describeToolUse("mcp__memory__memory_search", { query: "ci" })).toEqual({
      name: "memory:memory_search",
      detail: '{"query":"ci"}',
    });
  });

  it("falls back to compact JSON when there is no primary argument", () => {
    expect(describeToolUse("Bash", { timeout: 5 })).toEqual({
      name: "Bash",
      detail: '{"timeout":5}',
    });
    expect(describeToolUse("Custom", "raw")).toEqual({ name: "Custom", detail: "raw" });
    expect(describeToolUse("Custom", undefined)).toEqual({ name: "Custom", detail: "" });
  });

  it("truncates a very long detail", () => {
    const { detail } = describeToolUse("Bash", { command: "x".repeat(500) });
    expect(detail.length).toBeLessThanOrEqual(301);
    expect(detail.endsWith("…")).toBe(true);
  });
});

describe("formatDroppedLines", () => {
  it("uses singular and plural forms", () => {
    expect(formatDroppedLines(1)).toBe(" … +1 line");
    expect(formatDroppedLines(4)).toBe(" … +4 lines");
  });
});

describe("truncate", () => {
  it("collapses whitespace and truncates with an ellipsis", () => {
    expect(truncate("a  b\n c")).toBe("a b c");
    expect(truncate("x".repeat(600), 500).endsWith("…")).toBe(true);
    expect(truncate(undefined)).toBe("");
  });
});

describe("boundText", () => {
  it("keeps a text within the limit whole, line breaks included", () => {
    expect(boundText("a\n\n  b", 10)).toEqual({ text: "a\n\n  b", truncated: false });
    expect(boundText("x".repeat(LIVE_FIELD_MAX), LIVE_FIELD_MAX)).toEqual({
      text: "x".repeat(LIVE_FIELD_MAX),
      truncated: false,
    });
  });

  it("cuts a longer text at the limit and marks it truncated", () => {
    expect(boundText("abcdef", 4)).toEqual({ text: "abcd", truncated: true });
    expect(LIVE_FIELD_MAX).toBe(4000);
  });

  it("does not split a character made of two code units", () => {
    expect(boundText("abc😀def", 4)).toEqual({ text: "abc", truncated: true });
    expect(boundText("abc😀def", 5)).toEqual({ text: "abc😀", truncated: true });
  });
});
