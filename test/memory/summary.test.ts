import { describe, expect, it } from "vitest";
import {
  composeSummaryPrompt,
  parseSummary,
  type SummaryContext,
} from "../../src/memory/summary.js";
import type { SessionResult, Task } from "../../src/types.js";

function buildTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "redmine-1",
    title: "Fix export",
    description: "CSV export returns 500.",
    status: "in_progress",
    attempts: 2,
    createdAt: "2026-07-02T10:00:00.000Z",
    updatedAt: "2026-07-02T10:05:00.000Z",
    ...overrides,
  };
}

function buildResult(overrides: Partial<SessionResult> = {}): SessionResult {
  return {
    ok: true,
    durationMs: 1000,
    sessionId: "abc",
    ...overrides,
  };
}

describe("parseSummary", () => {
  it("parses the last json block from text", () => {
    const text = [
      "I analyzed the log.",
      "```json",
      '{"headline": "first", "summary": "x"}',
      "```",
      "correction:",
      "```json",
      '{"headline": "Fixed CSV export", "summary": "The cause was a missing header."}',
      "```",
    ].join("\n");

    expect(parseSummary(text)).toEqual({
      headline: "Fixed CSV export",
      summary: "The cause was a missing header.",
    });
  });

  it("parses raw json without a code block", () => {
    const text = '{"headline": "OK", "summary": "Done."}';
    expect(parseSummary(text)).toEqual({ headline: "OK", summary: "Done." });
  });

  it("tolerates raw newlines inside strings", () => {
    const text = '```json\n{"headline": "OK", "summary": "line 1\nline 2"}\n```';
    expect(parseSummary(text)).toEqual({
      headline: "OK",
      summary: "line 1\nline 2",
    });
  });

  it("returns null for broken json", () => {
    expect(parseSummary('```json\n{"headline": "OK",\n```')).toBeNull();
  });

  it("returns null when required fields are missing", () => {
    expect(parseSummary('{"headline": "OK"}')).toBeNull();
  });

  it("returns null for empty fields", () => {
    expect(parseSummary('{"headline": "  ", "summary": "x"}')).toBeNull();
  });

  it("returns null for plain text", () => {
    expect(parseSummary("I have nothing to say.")).toBeNull();
  });
});

describe("composeSummaryPrompt", () => {
  const logPath = "/tmp/logs/executor/2026-07-02/10-00-00-abc.log";

  function buildContext(overrides: Partial<SummaryContext> = {}): SummaryContext {
    return {
      task: buildTask(),
      result: buildResult(),
      willRetry: false,
      logPaths: [logPath],
      ...overrides,
    };
  }

  it("includes the task data and the log path", () => {
    const prompt = composeSummaryPrompt(buildContext());

    expect(prompt).toContain("ID: redmine-1");
    expect(prompt).toContain("Title: Fix export");
    expect(prompt).toContain("Attempt: 2");
    expect(prompt).toContain("CSV export returns 500.");
    expect(prompt).toContain(logPath);
    expect(prompt).toContain("Status: success");
    expect(prompt).not.toContain("Error:");
  });

  it("includes the error and retry info on failure", () => {
    const prompt = composeSummaryPrompt(
      buildContext({
        result: buildResult({ ok: false, error: "session timeout" }),
        willRetry: true,
      }),
    );

    expect(prompt).toContain("Status: failure");
    expect(prompt).toContain("Error: session timeout");
    expect(prompt).toContain("Retry scheduled: yes");
  });

  it("lists every log file of a resumed session, oldest first", () => {
    const resumedPath = "/tmp/logs/executor/2026-07-02/14-00-00-abc.log";
    const prompt = composeSummaryPrompt(
      buildContext({ logPaths: [logPath, resumedPath] }),
    );

    expect(prompt).toContain("session was resumed");
    expect(prompt.indexOf(logPath)).toBeLessThan(prompt.indexOf(resumedPath));
    expect(prompt).toContain("Read them all");
  });

  it("describes the error as unknown when there is no error message on failure", () => {
    const prompt = composeSummaryPrompt(
      buildContext({ result: buildResult({ ok: false }) }),
    );

    expect(prompt).toContain("Error: unknown");
    expect(prompt).toContain("Retry scheduled: no");
  });
});
