import { describe, expect, it } from "vitest";
import type { HeadlessLogEvent } from "../../src/headless/events.js";
import {
  createHeadlessReporters,
  emitAdmissionChange,
} from "../../src/headless/reporters.js";
import type { Task } from "../../src/types.js";

const RESUME_AT = new Date("2026-07-08T09:00:00.000Z");

function buildTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    title: "Fix the bug",
    description: "details",
    status: "pending",
    attempts: 0,
    createdAt: "2026-07-08T08:00:00.000Z",
    updatedAt: "2026-07-08T08:00:00.000Z",
    ...overrides,
  };
}

function collect(options: { verbose?: boolean } = {}) {
  const events: HeadlessLogEvent[] = [];
  const reporters = createHeadlessReporters((event) => events.push(event), options);
  return { events, ...reporters };
}

describe("createHeadlessReporters", () => {
  it("logs admission waits with the ticket, its start and the task", () => {
    const { events, monitor, executor } = collect();
    const since = RESUME_AT.getTime();

    monitor.admissionWait({ ticket: "m-1", since, seq: 1 });
    executor.admissionWait({ ticket: "e-1", since, seq: 2 }, buildTask());

    expect(events).toEqual([
      {
        level: "info",
        agent: "monitor",
        event: "monitor.admissionWait",
        fields: { ticket: "m-1", since: RESUME_AT.toISOString(), seq: 1 },
      },
      {
        level: "info",
        agent: "executor",
        event: "executor.admissionWait",
        fields: {
          ticket: "e-1",
          since: RESUME_AT.toISOString(),
          seq: 2,
          taskId: "task-1",
        },
      },
    ]);
  });

  it("logs admission changes under the agent that holds the ticket", () => {
    const events: HeadlessLogEvent[] = [];

    emitAdmissionChange((event) => events.push(event), {
      kind: "released",
      role: "executor",
      ticket: "e-1",
      seq: 4,
    });

    expect(events).toEqual([
      {
        level: "info",
        agent: "executor",
        event: "admission.released",
        fields: { ticket: "e-1", seq: 4 },
      },
    ]);
  });

  it("logs an auth block as an error for both agents", () => {
    const { events, monitor, executor } = collect();

    monitor.authBlocked({ reason: "Not logged in · Please run /login" });
    executor.authBlocked({ reason: "HTTP 401 authentication_failed" });

    expect(events).toEqual([
      {
        level: "error",
        agent: "monitor",
        event: "monitor.authBlocked",
        fields: { reason: "Not logged in · Please run /login" },
      },
      {
        level: "error",
        agent: "executor",
        event: "executor.authBlocked",
        fields: { reason: "HTTP 401 authentication_failed" },
      },
    ]);
  });

  it("maps monitor lifecycle callbacks to events", () => {
    const { events, monitor } = collect();

    monitor.offHours(RESUME_AT);
    monitor.usageLimit(RESUME_AT);
    monitor.cycleStarted(3);
    monitor.sleepUntil(RESUME_AT);

    expect(events).toEqual([
      {
        level: "info",
        agent: "monitor",
        event: "monitor.offHours",
        fields: { resumeAt: RESUME_AT.toISOString() },
      },
      {
        level: "warn",
        agent: "monitor",
        event: "monitor.limitWait",
        fields: { resumeAt: RESUME_AT.toISOString() },
      },
      {
        level: "info",
        agent: "monitor",
        event: "cycle.started",
        fields: { cycle: 3 },
      },
      {
        level: "info",
        agent: "monitor",
        event: "monitor.sleeping",
        fields: { nextCycleAt: RESUME_AT.toISOString() },
      },
    ]);
  });

  it("reports a successful cycle at info level with compacted fields", () => {
    const { events, monitor } = collect();

    monitor.cycleFinished({
      cycle: 1,
      ok: true,
      durationMs: 2000,
      costUsd: 0.5,
      addedTasks: 2,
      skippedDuplicates: 1,
      error: undefined,
    });

    expect(events).toEqual([
      {
        level: "info",
        agent: "monitor",
        event: "cycle.finished",
        fields: {
          cycle: 1,
          ok: true,
          durationMs: 2000,
          costUsd: 0.5,
          addedTasks: 2,
          skippedDuplicates: 1,
        },
      },
    ]);
  });

  it("reports a failed cycle at error level", () => {
    const { events, monitor } = collect();

    monitor.cycleFinished({
      cycle: 2,
      ok: false,
      durationMs: 100,
      costUsd: undefined,
      addedTasks: 0,
      skippedDuplicates: 0,
      error: "session failed",
      failureReason: "exit",
    });

    expect(events[0]).toMatchObject({
      level: "error",
      event: "cycle.finished",
      fields: { ok: false, error: "session failed", failureReason: "exit" },
    });
    expect(events[0]?.fields).not.toHaveProperty("costUsd");
  });

  it("names the session a resumed task continues", () => {
    const { events, executor } = collect();

    executor.taskStarted(
      buildTask({
        resume: { sessionId: "sess-limited", limitedAt: "2026-10-22T12:33:58.000Z" },
      }),
    );

    expect(events[0]).toMatchObject({
      event: "task.started",
      fields: { taskId: "task-1", resumedSessionId: "sess-limited" },
    });
  });

  it("maps executor lifecycle callbacks to events", () => {
    const { events, executor } = collect();
    const task = buildTask();

    executor.taskStarted(task);
    executor.retryScheduled(task, RESUME_AT);
    executor.usageLimit(RESUME_AT);
    executor.waiting();

    expect(events).toEqual([
      {
        level: "info",
        agent: "executor",
        event: "task.started",
        fields: { taskId: "task-1", title: "Fix the bug" },
      },
      {
        level: "warn",
        agent: "executor",
        event: "task.retryScheduled",
        fields: { taskId: "task-1", resumeAt: RESUME_AT.toISOString() },
      },
      {
        level: "warn",
        agent: "executor",
        event: "executor.limitWait",
        fields: { resumeAt: RESUME_AT.toISOString() },
      },
      {
        level: "info",
        agent: "executor",
        event: "executor.waiting",
        fields: {},
      },
    ]);
  });

  it("grades task.finished by outcome: ok, retry, terminal failure", () => {
    const { events, executor } = collect();
    const base = {
      taskId: "task-1",
      title: "Fix the bug",
      durationMs: 1000,
      costUsd: undefined,
      numTurns: undefined,
      error: undefined,
      willRetry: undefined,
      attempt: undefined,
      maxAttempts: undefined,
    };

    executor.taskFinished({ ...base, ok: true, costUsd: 0.25, numTurns: 12 });
    executor.taskFinished({
      ...base,
      ok: false,
      willRetry: true,
      attempt: 1,
      maxAttempts: 3,
      error: "Session killed by the pool memory limit",
      failureReason: "poolMemoryLimit",
    });
    executor.taskFinished({ ...base, ok: false, error: "fatal" });

    expect(events.map((event) => event.level)).toEqual(["info", "warn", "error"]);
    expect(events[0]?.fields).toEqual({
      taskId: "task-1",
      title: "Fix the bug",
      ok: true,
      durationMs: 1000,
      costUsd: 0.25,
      numTurns: 12,
    });
    expect(events[1]?.fields).toMatchObject({
      willRetry: true,
      attempt: 1,
      maxAttempts: 3,
      error: "Session killed by the pool memory limit",
      failureReason: "poolMemoryLimit",
    });
    expect(events[2]?.fields).not.toHaveProperty("failureReason");
  });

  it("adds a handoff to a human to task.finished only when the task carries one", () => {
    const { events, executor } = collect();
    const base = { taskId: "task-1", title: "Fix the bug", durationMs: 1000 };

    executor.taskFinished({
      ...base,
      ok: true,
      sessionId: "sess-1",
      handedOff: true,
      handoffReason: "Needs the owner's approval of the budget",
    });
    executor.taskFinished({
      ...base,
      ok: false,
      error: "exit 1",
      handedOff: true,
      handoffReason: "left for a human",
    });
    executor.taskFinished({ ...base, ok: true, handedOff: undefined });

    expect(events[0]?.fields).toEqual({
      ...base,
      ok: true,
      sessionId: "sess-1",
      handedOff: true,
      handoffReason: "Needs the owner's approval of the budget",
    });
    expect(events[1]).toMatchObject({
      level: "error",
      fields: { ok: false, handedOff: true, handoffReason: "left for a human" },
    });
    expect(events[2]?.fields).not.toHaveProperty("handedOff");
    expect(events[2]?.fields).not.toHaveProperty("handoffReason");
  });

  it("keeps executor summary callbacks silent and routes them via the summarizer reporter", () => {
    const { events, executor, summarizer } = collect();
    const task = buildTask();

    executor.summaryStarted(task);
    executor.summaryFinished({
      taskId: task.id,
      ok: true,
      durationMs: 10,
      costUsd: undefined,
      error: undefined,
    });
    expect(events).toEqual([]);

    summarizer.summaryStarted(task);
    summarizer.summaryFinished({
      taskId: task.id,
      ok: false,
      durationMs: 20,
      costUsd: 0.01,
      error: "boom",
    });

    expect(events).toEqual([
      {
        level: "info",
        agent: "summarizer",
        event: "summary.started",
        fields: { taskId: "task-1" },
      },
      {
        level: "error",
        agent: "summarizer",
        event: "summary.finished",
        fields: {
          taskId: "task-1",
          ok: false,
          durationMs: 20,
          costUsd: 0.01,
          error: "boom",
        },
      },
    ]);
  });

  it("logs the spawned session process with its placement", () => {
    const { events, executor, summarizer } = collect();

    executor.session({
      type: "spawned",
      pid: 77,
      role: "executor",
      pool: "executor",
      ticket: "t-1",
      seq: 4,
    });
    summarizer.session({
      type: "spawned",
      pid: 78,
      role: "summarizer",
      pool: "executor",
    });

    expect(events).toEqual([
      {
        level: "info",
        agent: "executor",
        event: "session.spawned",
        fields: { pid: 77, role: "executor", pool: "executor", ticket: "t-1", seq: 4 },
      },
      {
        level: "info",
        agent: "summarizer",
        event: "session.spawned",
        fields: { pid: 78, role: "summarizer", pool: "executor" },
      },
    ]);
  });

  it("always logs session init, stderr, procError and killing", () => {
    const { events, monitor } = collect();

    monitor.session({ type: "init", model: "haiku", sessionId: "s-1", toolCount: 5 });
    monitor.session({ type: "stderr", line: "warning: deprecated" });
    monitor.session({ type: "procError", message: "spawn failed" });
    monitor.session({ type: "killing", reason: "timeout" });

    expect(events).toEqual([
      {
        level: "info",
        agent: "monitor",
        event: "session.init",
        fields: { model: "haiku", sessionId: "s-1" },
      },
      {
        level: "warn",
        agent: "monitor",
        event: "session.stderr",
        fields: { line: "warning: deprecated" },
      },
      {
        level: "error",
        agent: "monitor",
        event: "session.procError",
        fields: { message: "spawn failed" },
      },
      {
        level: "warn",
        agent: "monitor",
        event: "session.killed",
        fields: { reason: "timeout" },
      },
    ]);
  });

  it("logs the ids of the killed session when the event carries them", () => {
    const { events, executor, monitor } = collect();

    executor.session({
      type: "killing",
      reason: "abort",
      sessionId: "s-2",
      taskId: "ci-9",
    });
    monitor.session({ type: "killing", reason: "timeout", sessionId: "s-3", cycle: 4 });

    expect(events).toStrictEqual([
      {
        level: "warn",
        agent: "executor",
        event: "session.killed",
        fields: { reason: "abort", sessionId: "s-2", taskId: "ci-9" },
      },
      {
        level: "warn",
        agent: "monitor",
        event: "session.killed",
        fields: { reason: "timeout", sessionId: "s-3", cycle: 4 },
      },
    ]);
  });

  it("carries taskId and cycle into session.init when the session has them", () => {
    const { events, executor, monitor } = collect();

    executor.session({
      type: "init",
      model: "opus",
      sessionId: "s-1",
      toolCount: 5,
      taskId: "ci-42",
    });
    monitor.session({
      type: "init",
      model: "haiku",
      sessionId: "s-2",
      toolCount: 5,
      cycle: 3,
    });

    expect(events[0]?.fields).toEqual({
      model: "opus",
      sessionId: "s-1",
      taskId: "ci-42",
    });
    expect(events[1]?.fields).toEqual({
      model: "haiku",
      sessionId: "s-2",
      cycle: 3,
    });
  });

  it("carries the session id into every *.finished event", () => {
    const { events, executor, monitor, summarizer } = collect();

    monitor.cycleFinished({
      cycle: 1,
      ok: true,
      durationMs: 10,
      addedTasks: 0,
      skippedDuplicates: 0,
      sessionId: "m-1",
    });
    executor.taskFinished({
      taskId: "task-1",
      title: "Fix the bug",
      ok: true,
      durationMs: 10,
      sessionId: "e-1",
    });
    summarizer.summaryFinished({
      taskId: "task-1",
      ok: true,
      durationMs: 10,
      sessionId: "s-1",
    });

    expect(events.map((event) => event.fields.sessionId)).toEqual(["m-1", "e-1", "s-1"]);
  });

  it("ignores the raw stream tap", () => {
    const { events, executor } = collect({ verbose: true });

    executor.session({ type: "stream", event: { type: "assistant" } });

    expect(events).toEqual([]);
  });

  it("suppresses session text, tool calls and results by default", () => {
    const { events, executor } = collect();

    executor.session({ type: "text", text: "thinking" });
    executor.session({ type: "toolUse", name: "Bash", input: { command: "ls" } });
    executor.session({ type: "toolResult", isError: true, lines: ["boom"], dropped: 0 });
    executor.session({ type: "partial", text: "chunk" });
    executor.session({ type: "raw", line: "{}" });

    expect(events).toEqual([]);
  });

  it("keeps the whole thought an agent had, however long it ran", () => {
    const { events, executor } = collect({ verbose: true });
    const thought = `${"a".repeat(900)}\nsecond paragraph`;

    executor.session({ type: "text", text: thought });

    expect(events).toEqual([
      {
        level: "info",
        agent: "executor",
        event: "session.text",
        fields: { text: thought },
      },
    ]);
  });

  it("keeps the lines of a failed tool apart instead of running them together", () => {
    const { events, executor } = collect({ verbose: true });

    executor.session({
      type: "toolResult",
      isError: true,
      lines: ["first", "second"],
      dropped: 0,
    });

    expect(events[0]?.fields).toEqual({ output: "first\nsecond" });
  });

  it("logs session text, tool calls and failed tool results when verbose", () => {
    const { events, executor } = collect({ verbose: true });

    executor.session({ type: "text", text: "thinking" });
    executor.session({ type: "toolUse", name: "Bash", input: { command: "ls -la" } });
    executor.session({ type: "toolResult", isError: true, lines: ["boom"], dropped: 0 });
    executor.session({ type: "toolResult", isError: false, lines: ["ok"], dropped: 0 });
    executor.session({ type: "partial", text: "chunk" });

    expect(events).toEqual([
      {
        level: "info",
        agent: "executor",
        event: "session.text",
        fields: { text: "thinking" },
      },
      {
        level: "info",
        agent: "executor",
        event: "session.tool",
        fields: { tool: "Bash", detail: "ls -la" },
      },
      {
        level: "warn",
        agent: "executor",
        event: "session.toolError",
        fields: { output: "boom" },
      },
    ]);
  });
});
