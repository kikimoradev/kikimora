import { describe, expect, it } from "vitest";
import type { Task } from "../../src/types.js";
import {
  countLabel,
  countTasks,
  detectStall,
  formatAge,
  formatCost,
  formatCountdown,
  formatDrainNotice,
  formatElapsed,
  formatExecutorOutcome,
  formatExecutorPhase,
  formatHeaderStats,
  formatInterval,
  formatMonitorOutcome,
  formatMonitorPhase,
  formatUptime,
  formatWhen,
  plural,
  withControl,
  withStall,
  type StatusLine,
} from "../../src/ui/format.js";

function task(): Task {
  return {
    id: "t-1",
    title: "Title",
    description: "Description",
    status: "in_progress",
    attempts: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("formatCountdown", () => {
  it("formats minutes and seconds", () => {
    expect(formatCountdown(65_000)).toBe("01:05");
  });

  it("formats hours", () => {
    expect(formatCountdown(3_665_000)).toBe("1:01:05");
  });

  it("does not go below zero", () => {
    expect(formatCountdown(-5_000)).toBe("00:00");
  });
});

describe("formatInterval", () => {
  it("formats whole minutes", () => {
    expect(formatInterval(900_000)).toBe("15 min");
  });

  it("formats hours with minutes", () => {
    expect(formatInterval(5_400_000)).toBe("1 h 30 min");
  });

  it("formats seconds", () => {
    expect(formatInterval(45_000)).toBe("45 s");
  });

  it("shows zero as 0 s", () => {
    expect(formatInterval(0)).toBe("0 s");
  });
});

describe("formatElapsed", () => {
  it("keeps a tenth of a second under ten seconds", () => {
    expect(formatElapsed(3_700)).toBe("3.7s");
  });

  it("drops the fraction from ten seconds on", () => {
    expect(formatElapsed(42_900)).toBe("42s");
  });

  it("switches to minutes and seconds past a minute", () => {
    expect(formatElapsed(725_000)).toBe("12m 05s");
  });

  it("switches to hours and minutes past an hour", () => {
    expect(formatElapsed(3_720_000)).toBe("1h 02m");
  });

  it("never goes below zero", () => {
    expect(formatElapsed(-100)).toBe("0.0s");
  });
});

describe("formatUptime", () => {
  it("counts whole seconds under a minute", () => {
    expect(formatUptime(18_400)).toBe("18s");
  });

  it("uses the elapsed format past a minute", () => {
    expect(formatUptime(3_660_000)).toBe("1h 01m");
  });
});

describe("formatCost", () => {
  it("shows zero with two decimals", () => {
    expect(formatCost(0)).toBe("$0.00");
  });

  it("marks amounts below a tenth of a cent", () => {
    expect(formatCost(0.0004)).toBe("<$0.001");
  });

  it("keeps three decimals below a dollar", () => {
    expect(formatCost(0.0214)).toBe("$0.021");
  });

  it("keeps two decimals from a dollar on", () => {
    expect(formatCost(1.234)).toBe("$1.23");
  });
});

describe("formatWhen", () => {
  const now = new Date(2026, 6, 2, 10, 0).getTime();

  it("shows only the time today", () => {
    expect(formatWhen(new Date(2026, 6, 2, 14, 5).getTime(), now)).toBe("14:05");
  });

  it("says tomorrow for the next day", () => {
    expect(formatWhen(new Date(2026, 6, 3, 9, 0).getTime(), now)).toBe("tomorrow 09:00");
  });

  it("names the weekday within a week", () => {
    expect(formatWhen(new Date(2026, 6, 6, 9, 0).getTime(), now)).toBe("Mon 09:00");
  });

  it("falls back to the full date further out", () => {
    expect(formatWhen(new Date(2026, 6, 20, 9, 0).getTime(), now)).toBe(
      "2026-07-20 09:00",
    );
  });
});

describe("plural and countLabel", () => {
  it("picks the singular for one", () => {
    expect(plural(1, "cycle", "cycles")).toBe("cycle");
    expect(countLabel(1, "cycle", "cycles")).toBe("1 cycle");
  });

  it("picks the plural otherwise", () => {
    expect(countLabel(0, "cycle", "cycles")).toBe("0 cycles");
    expect(countLabel(3, "cycle", "cycles")).toBe("3 cycles");
  });
});

describe("formatMonitorPhase", () => {
  const now = Date.parse("2026-07-02T10:00:00");

  it("starting is busy", () => {
    expect(formatMonitorPhase({ kind: "starting" }, now)).toMatchObject({
      text: "starting…",
      tone: "info",
      busy: true,
    });
  });

  it("outside working hours with the resume time and countdown aside", () => {
    const line = formatMonitorPhase({ kind: "offHours", resumeAt: now + 60_000 }, now);
    expect(line.text).toBe("outside working hours");
    expect(line.aside).toBe("resumes 10:01 · in 01:00");
    expect(line.busy).toBe(false);
  });

  it("session with the elapsed time aside", () => {
    const line = formatMonitorPhase(
      { kind: "session", cycle: 4, startedAt: now - 2_500 },
      now,
    );
    expect(line).toMatchObject({ text: "cycle #4", aside: "2.5s", busy: true });
  });

  it("sleeping with the countdown aside", () => {
    const line = formatMonitorPhase(
      { kind: "sleeping", nextCycleAt: now + 125_000 },
      now,
    );
    expect(line).toMatchObject({ text: "next cycle", aside: "in 02:05", tone: "muted" });
  });

  it("usage limit with countdown to the reset", () => {
    const line = formatMonitorPhase({ kind: "limitWait", resumeAt: now + 90_000 }, now);
    expect(line).toMatchObject({ text: "usage limit reached", tone: "warn", glyph: "⚠" });
    expect(line.aside).toContain("01:30");
  });

  it("auth block with the reason and the way out", () => {
    const line = formatMonitorPhase(
      { kind: "authBlocked", reason: "Not logged in", since: now },
      now,
    );
    expect(line.tone).toBe("error");
    expect(line.text).toContain("authentication failed");
    expect(line.text).toContain("Not logged in");
    expect(line.text).toContain("/start");
  });
});

describe("formatExecutorPhase", () => {
  const now = Date.parse("2026-07-02T10:00:00");

  it("waiting is idle", () => {
    expect(formatExecutorPhase({ kind: "waiting" }, now)).toMatchObject({
      text: "waiting for tasks",
      tone: "muted",
      busy: false,
    });
  });

  it("session with a task", () => {
    const line = formatExecutorPhase(
      { kind: "session", task: task(), startedAt: now - 1_000 },
      now,
    );
    expect(line).toMatchObject({ text: "t-1 · Title", aside: "1.0s", busy: true });
  });

  it("backoff with countdown to retry", () => {
    const line = formatExecutorPhase(
      { kind: "backoff", task: task(), resumeAt: now + 30_000 },
      now,
    );
    expect(line).toMatchObject({
      glyph: "↻",
      tone: "warn",
      text: "retrying t-1",
      aside: "in 00:30",
    });
  });

  it("summarizing session to memory", () => {
    const line = formatExecutorPhase(
      { kind: "summary", task: task(), startedAt: now - 2_000 },
      now,
    );
    expect(line).toMatchObject({ text: "summarizing t-1 to memory", aside: "2.0s" });
  });

  it("usage limit with countdown to the reset", () => {
    const line = formatExecutorPhase({ kind: "limitWait", resumeAt: now + 90_000 }, now);
    expect(line.text).toBe("usage limit reached");
    expect(line.aside).toContain("01:30");
  });

  it("auth block with the reason and the way out", () => {
    const line = formatExecutorPhase(
      { kind: "authBlocked", reason: "HTTP 401 authentication_failed", since: now },
      now,
    );
    expect(line.text).toContain("HTTP 401");
    expect(line.text).toContain("/start");
  });
});

describe("detectStall and withStall", () => {
  const now = 1_000_000;
  const running: StatusLine = {
    glyph: "●",
    tone: "info",
    text: "cycle #1",
    aside: "3m 00s",
    busy: true,
  };

  it("returns undefined below the threshold", () => {
    expect(detectStall(now - 119_000, undefined, now)).toBeUndefined();
  });

  it("measures from the session start when there are no events yet", () => {
    expect(detectStall(now - 180_000, undefined, now)).toBe("no output for 3 min");
  });

  it("measures from the last event when one arrived", () => {
    expect(detectStall(now - 600_000, now - 125_000, now)).toBe(
      "no output for 2 min 5 s",
    );
  });

  it("returns undefined right after an event", () => {
    expect(detectStall(now - 600_000, now - 1_000, now)).toBeUndefined();
  });

  it("turns a stalled line into a warning and stops the spinner", () => {
    expect(withStall(running, "no output for 3 min")).toEqual({
      glyph: "⚠",
      tone: "warn",
      text: "cycle #1 · no output for 3 min",
      aside: "3m 00s",
      busy: false,
    });
  });

  it("keeps the line when nothing stalled", () => {
    expect(withStall(running, undefined)).toBe(running);
  });
});

describe("withControl", () => {
  const running: StatusLine = { glyph: "●", tone: "info", text: "cycle #1", busy: true };
  const sleeping: StatusLine = { glyph: "○", tone: "muted", text: "next", busy: false };

  it("keeps the line while running", () => {
    expect(withControl("running", "session", running)).toBe(running);
  });

  it("shows finishing and keeps the spinner while pausing during a session", () => {
    expect(withControl("pausing", "session", running)).toMatchObject({
      tone: "warn",
      text: "finishing · cycle #1",
      busy: true,
    });
    expect(withControl("pausing", "summary", running).text).toBe("finishing · cycle #1");
  });

  it("shows pausing and paused outside a session", () => {
    expect(withControl("pausing", "sleeping", sleeping)).toMatchObject({
      glyph: "‖",
      text: "pausing…",
    });
    expect(withControl("paused", "sleeping", sleeping)).toMatchObject({
      glyph: "‖",
      text: "paused",
    });
  });

  it("lets the auth block win over the pause state", () => {
    const blocked: StatusLine = { glyph: "✖", tone: "error", text: "auth", busy: false };
    expect(withControl("paused", "authBlocked", blocked)).toBe(blocked);
    expect(withControl("pausing", "authBlocked", blocked)).toBe(blocked);
  });
});

describe("formatHeaderStats", () => {
  it("formats uptime, cost and cycles", () => {
    expect(
      formatHeaderStats(
        { cycles: 3, tasksSucceeded: 2, tasksFailed: 1, totalCostUsd: 1.234 },
        3_660_000,
      ),
    ).toBe("↑ 1h 01m · $1.23 · 3 cycles");
  });

  it("uses the singular for one cycle", () => {
    expect(
      formatHeaderStats(
        { cycles: 1, tasksSucceeded: 0, tasksFailed: 0, totalCostUsd: 0 },
        4_000,
      ),
    ).toBe("↑ 4s · $0.00 · 1 cycle");
  });
});

describe("formatDrainNotice", () => {
  it("names the deadline when there is one", () => {
    expect(formatDrainNotice({ since: 0, until: 90_000, reason: "SIGTERM" }, 0)).toBe(
      "draining — exits after the current session · stops in 01:30 at the latest",
    );
  });

  it("omits the deadline otherwise", () => {
    expect(formatDrainNotice({ since: 0, until: undefined, reason: "drain" }, 0)).toBe(
      "draining — exits after the current session",
    );
  });
});

describe("countTasks", () => {
  it("counts every status", () => {
    expect(
      countTasks([
        task(),
        { ...task(), id: "t-2", status: "pending" },
        { ...task(), id: "t-3", status: "done" },
        { ...task(), id: "t-4", status: "failed" },
        { ...task(), id: "t-5", status: "cancelled" },
        { ...task(), id: "t-6", status: "done" },
      ]),
    ).toEqual({ in_progress: 1, pending: 1, done: 2, failed: 1, cancelled: 1 });
  });
});

describe("formatAge", () => {
  const now = Date.parse("2026-07-02T12:00:00Z");

  it("shows just now under a minute", () => {
    expect(formatAge(new Date(now - 30_000).toISOString(), now)).toBe("just now");
  });

  it("shows minutes", () => {
    expect(formatAge(new Date(now - 5 * 60_000).toISOString(), now)).toBe("5m ago");
  });

  it("shows hours", () => {
    expect(formatAge(new Date(now - 3 * 3_600_000).toISOString(), now)).toBe("3h ago");
  });

  it("shows days", () => {
    expect(formatAge(new Date(now - 49 * 3_600_000).toISOString(), now)).toBe("2d ago");
  });

  it("returns an empty string for an invalid date", () => {
    expect(formatAge("not-a-date", now)).toBe("");
  });
});

describe("formatMonitorOutcome", () => {
  it("success with cost and duplicates", () => {
    expect(
      formatMonitorOutcome({
        cycle: 2,
        ok: true,
        durationMs: 1_500,
        costUsd: 0.0123,
        addedTasks: 3,
        skippedDuplicates: 1,
        finishedAt: 0,
      }),
    ).toEqual({
      glyph: "✔",
      tone: "ok",
      text: "cycle #2 · +3 tasks · 1 duplicate skipped",
      meta: "1.5s · $0.012",
    });
  });

  it("success without new tasks", () => {
    expect(
      formatMonitorOutcome({
        cycle: 1,
        ok: true,
        durationMs: 500,
        addedTasks: 0,
        skippedDuplicates: 0,
        finishedAt: 0,
      }).text,
    ).toBe("cycle #1 · no new tasks");
  });

  it("error with description", () => {
    expect(
      formatMonitorOutcome({
        cycle: 3,
        ok: false,
        durationMs: 500,
        addedTasks: 0,
        skippedDuplicates: 0,
        error: "invalid task report",
        finishedAt: 0,
      }),
    ).toEqual({
      glyph: "✖",
      tone: "error",
      text: "cycle #3 · invalid task report",
      meta: "0.5s",
    });
  });
});

describe("formatExecutorOutcome", () => {
  it("success with turns", () => {
    expect(
      formatExecutorOutcome({
        taskId: "t-1",
        title: "Title",
        ok: true,
        durationMs: 2_000,
        costUsd: 0.5,
        numTurns: 7,
        finishedAt: 0,
      }),
    ).toEqual({ glyph: "✔", tone: "ok", text: "t-1 · 7 turns", meta: "2.0s · $0.500" });
  });

  it("success without a turn count", () => {
    expect(
      formatExecutorOutcome({
        taskId: "t-1",
        title: "Title",
        ok: true,
        durationMs: 2_000,
        finishedAt: 0,
      }).text,
    ).toBe("t-1");
  });

  it("error with description", () => {
    expect(
      formatExecutorOutcome({
        taskId: "t-2",
        title: "Title",
        ok: false,
        durationMs: 100,
        error: "Session timed out",
        finishedAt: 0,
      }),
    ).toEqual({
      glyph: "✖",
      tone: "error",
      text: "t-2 · Session timed out",
      meta: "0.1s",
    });
  });

  it("transient error with a scheduled retry", () => {
    expect(
      formatExecutorOutcome({
        taskId: "t-3",
        title: "Title",
        ok: false,
        durationMs: 100,
        error: "Session ended with an error (is_error)",
        willRetry: true,
        attempt: 1,
        maxAttempts: 3,
        finishedAt: 0,
      }),
    ).toMatchObject({
      glyph: "↻",
      tone: "warn",
      text: "t-3 · Session ended with an error (is_error) · retry 1/3",
    });
  });

  it("retry without attempt counts", () => {
    expect(
      formatExecutorOutcome({
        taskId: "t-3",
        title: "Title",
        ok: false,
        durationMs: 100,
        willRetry: true,
        finishedAt: 0,
      }).text,
    ).toBe("t-3 · unknown error · retry");
  });
});
