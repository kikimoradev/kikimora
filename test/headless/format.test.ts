import { describe, expect, it } from "vitest";
import type { HeadlessLogEvent } from "../../src/headless/events.js";
import {
  formatJsonLine,
  formatPrettyLine,
  parseHeadlessLogFormat,
} from "../../src/headless/format.js";

const AT = new Date(2026, 6, 8, 9, 5, 3);

function event(overrides: Partial<HeadlessLogEvent> = {}): HeadlessLogEvent {
  return {
    level: "info",
    event: "cycle.finished",
    agent: "monitor",
    fields: {},
    ...overrides,
  };
}

describe("parseHeadlessLogFormat", () => {
  it("accepts the two supported formats", () => {
    expect(parseHeadlessLogFormat("pretty")).toBe("pretty");
    expect(parseHeadlessLogFormat("json")).toBe("json");
  });

  it("rejects anything else", () => {
    expect(parseHeadlessLogFormat("logfmt")).toBeNull();
    expect(parseHeadlessLogFormat("")).toBeNull();
    expect(parseHeadlessLogFormat("JSON")).toBeNull();
  });
});

describe("formatJsonLine", () => {
  it("emits a stable envelope with ts, level, agent, event, then fields", () => {
    const line = formatJsonLine(
      event({ fields: { cycle: 3, ok: true, durationMs: 1500 } }),
      AT,
    );

    expect(JSON.parse(line)).toEqual({
      ts: AT.toISOString(),
      level: "info",
      agent: "monitor",
      event: "cycle.finished",
      cycle: 3,
      ok: true,
      durationMs: 1500,
    });
    expect(line.indexOf('"ts"')).toBeLessThan(line.indexOf('"level"'));
    expect(line.indexOf('"event"')).toBeLessThan(line.indexOf('"cycle"'));
  });

  it("omits the agent key for worker-level events", () => {
    const line = formatJsonLine(
      event({ agent: undefined, event: "worker.started", fields: { pid: 42 } }),
      AT,
    );

    expect(JSON.parse(line)).toEqual({
      ts: AT.toISOString(),
      level: "info",
      event: "worker.started",
      pid: 42,
    });
  });
});

describe("formatPrettyLine", () => {
  it("renders time, agent, event and key=value fields", () => {
    const line = formatPrettyLine(
      event({ fields: { cycle: 3, ok: true, addedTasks: 2 } }),
      AT,
    );

    expect(line).toBe("09:05:03 [monitor] cycle.finished cycle=3 ok=true addedTasks=2");
  });

  it("marks warnings and errors with a symbol", () => {
    expect(formatPrettyLine(event({ level: "warn" }), AT)).toContain("⚠ ");
    expect(formatPrettyLine(event({ level: "error" }), AT)).toContain("✖ ");
  });

  it("humanizes duration and cost fields", () => {
    const line = formatPrettyLine(
      event({ fields: { durationMs: 1500, costUsd: 0.12345 } }),
      AT,
    );

    expect(line).toContain("duration=1.5s");
    expect(line).toContain("cost=$0.1235");
  });

  it("renders the source of a task as plain fields", () => {
    const line = formatPrettyLine(
      event({
        agent: "executor",
        event: "task.started",
        fields: {
          taskId: "issue-142",
          sourceLabel: "ENG-142",
          sourceUrl: "https://linear.app/acme/issue/ENG-142",
          attempt: 1,
          maxAttempts: 3,
        },
      }),
      AT,
    );

    expect(line).toBe(
      "09:05:03 [executor] task.started taskId=issue-142 sourceLabel=ENG-142 " +
        "sourceUrl=https://linear.app/acme/issue/ENG-142 attempt=1 maxAttempts=3",
    );
  });

  it("quotes string values containing whitespace", () => {
    const line = formatPrettyLine(
      event({ fields: { title: "Fix the bug", taskId: "t-1" } }),
      AT,
    );

    expect(line).toContain('title="Fix the bug"');
    expect(line).toContain("taskId=t-1");
  });

  it("renders events without fields and without agent cleanly", () => {
    const line = formatPrettyLine(
      event({ agent: undefined, event: "worker.stopped", fields: {} }),
      AT,
    );

    expect(line).toBe("09:05:03 worker.stopped");
  });
});

describe("formatPrettyLine, what a terminal can take", () => {
  it("cuts a value too long for a line, and says it cut it", () => {
    const line = formatPrettyLine(
      event({ event: "session.text", fields: { text: "a".repeat(900) } }),
      AT,
    );

    expect(line).toContain("\u2026");
    expect(line.length).toBeLessThan(600);
  });

  it("leaves the json line whole, because nothing reads it by eye", () => {
    const text = "a".repeat(900);

    const line = formatJsonLine(event({ event: "session.text", fields: { text } }), AT);

    expect(JSON.parse(line)).toMatchObject({ text });
  });
});
