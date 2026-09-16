import { describe, expect, it } from "vitest";
import {
  buildControlStatus,
  buildDrainAck,
  CONTROL_COMMANDS,
  MEMORY_LIMIT_DEFAULT,
  parseControlRequest,
  UNRECOGNIZED_REQUEST,
  type WorkerIdentity,
} from "../src/control-protocol.js";
import type { WorkerStatus } from "../src/status.js";
import type { Task } from "../src/types.js";

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

function buildSnapshot(overrides: Partial<WorkerStatus> = {}): WorkerStatus {
  return {
    startedAt: Date.parse("2026-07-08T08:00:00.000Z"),
    monitor: {
      phase: { kind: "starting" },
      control: "running",
      tail: [],
      recentOutcomes: [],
    },
    executor: {
      phase: { kind: "waiting" },
      control: "running",
      tail: [],
      recentOutcomes: [],
    },
    tasks: [],
    stats: { cycles: 0, tasksSucceeded: 0, tasksFailed: 0, totalCostUsd: 0 },
    ...overrides,
  };
}

function accepted(line: string): unknown {
  const parsed = parseControlRequest(line);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.request;
}

function rejected(line: string): string {
  const parsed = parseControlRequest(line);
  if (parsed.ok) throw new Error(`accepted ${line}`);
  return parsed.error;
}

describe("parseControlRequest", () => {
  it("parses the control commands", () => {
    expect(accepted('{"cmd":"status"}')).toEqual({ cmd: "status" });
    expect(accepted('{"cmd":"version"}')).toEqual({ cmd: "version" });
    expect(accepted('{"cmd":"pause","agent":"monitor"}')).toEqual({
      cmd: "pause",
      agent: "monitor",
    });
    expect(accepted('{"cmd":"resume","agent":"all"}')).toEqual({
      cmd: "resume",
      agent: "all",
    });
    expect(accepted('{"cmd":"drain"}')).toEqual({ cmd: "drain" });
    expect(accepted('{"cmd":"drain","timeoutMs":86400000}')).toEqual({
      cmd: "drain",
      timeoutMs: 86_400_000,
    });
  });

  it("parses every data command and fills in defaults", () => {
    expect(accepted('{"cmd":"settings.get"}')).toEqual({ cmd: "settings.get" });
    expect(
      accepted(
        '{"cmd":"settings.patch","patch":{"monitor":{"activeHours":null,"x":[1,"a"]}}}',
      ),
    ).toEqual({
      cmd: "settings.patch",
      patch: { monitor: { activeHours: null, x: [1, "a"] } },
    });
    expect(accepted('{"cmd":"tasks.list"}')).toEqual({ cmd: "tasks.list" });
    expect(accepted('{"cmd":"tasks.list","status":"failed"}')).toEqual({
      cmd: "tasks.list",
      status: "failed",
    });
    expect(accepted('{"cmd":"tasks.add","description":"Do it"}')).toEqual({
      cmd: "tasks.add",
      description: "Do it",
    });
    expect(
      accepted('{"cmd":"tasks.add","description":"Do it","id":"t-1","title":"T"}'),
    ).toEqual({ cmd: "tasks.add", description: "Do it", id: "t-1", title: "T" });
    expect(accepted('{"cmd":"tasks.retry","id":"t-1"}')).toEqual({
      cmd: "tasks.retry",
      id: "t-1",
    });
    expect(accepted('{"cmd":"tasks.cancel","id":"t-1"}')).toEqual({
      cmd: "tasks.cancel",
      id: "t-1",
    });
    expect(accepted('{"cmd":"memory.search","query":"deploy"}')).toEqual({
      cmd: "memory.search",
      query: "deploy",
      limit: MEMORY_LIMIT_DEFAULT,
    });
    expect(accepted('{"cmd":"memory.search","query":"deploy","limit":3}')).toEqual({
      cmd: "memory.search",
      query: "deploy",
      limit: 3,
    });
    expect(accepted('{"cmd":"memory.recent"}')).toEqual({
      cmd: "memory.recent",
      limit: MEMORY_LIMIT_DEFAULT,
    });
    expect(accepted('{"cmd":"prompt.get","agent":"monitor"}')).toEqual({
      cmd: "prompt.get",
      agent: "monitor",
    });
    expect(accepted('{"cmd":"prompt.set","agent":"executor","content":"# Do"}')).toEqual({
      cmd: "prompt.set",
      agent: "executor",
      content: "# Do",
    });
    expect(accepted('{"cmd":"context.get"}')).toEqual({ cmd: "context.get" });
    expect(accepted('{"cmd":"context.set","content":"# Workspace context"}')).toEqual({
      cmd: "context.set",
      content: "# Workspace context",
    });
  });

  it("accepts an empty context, the way to clear it", () => {
    expect(accepted('{"cmd":"context.set","content":""}')).toEqual({
      cmd: "context.set",
      content: "",
    });
  });

  it("rejects unrecognized requests with the legacy message", () => {
    for (const line of [
      "not json",
      "42",
      "[]",
      '{"cmd":"shutdown"}',
      '{"agent":"all"}',
    ]) {
      expect(rejected(line)).toBe(UNRECOGNIZED_REQUEST);
    }
  });

  it("explains an invalid payload of a known command", () => {
    expect(rejected('{"cmd":"pause"}')).toMatch(/^Invalid pause request: agent: /);
    expect(rejected('{"cmd":"pause","agent":"summarizer"}')).toMatch(
      /^Invalid pause request: agent: /,
    );
    expect(rejected('{"cmd":"tasks.add"}')).toMatch(
      /^Invalid tasks.add request: description: /,
    );
    expect(rejected('{"cmd":"tasks.add","description":"  "}')).toMatch(
      /must not be blank/,
    );
    expect(rejected('{"cmd":"tasks.list","status":"nope"}')).toMatch(
      /^Invalid tasks.list request: status: /,
    );
    expect(rejected('{"cmd":"memory.recent","limit":0}')).toMatch(/limit: /);
    expect(rejected('{"cmd":"memory.recent","limit":101}')).toMatch(/limit: /);
    expect(rejected('{"cmd":"memory.recent","limit":2.5}')).toMatch(/limit: /);
    expect(rejected('{"cmd":"settings.patch","patch":[1]}')).toMatch(/patch/);
    expect(rejected('{"cmd":"settings.patch","patch":"x"}')).toMatch(/patch/);
    expect(rejected('{"cmd":"prompt.set","agent":"monitor","content":""}')).toMatch(
      /content: must not be blank/,
    );
    expect(rejected('{"cmd":"context.get","agent":"monitor"}')).toMatch(
      /^Invalid context.get request: \(root\): Unrecognized key/,
    );
    expect(
      rejected(`{"cmd":"context.set","content":"${"x".repeat(1_000_001)}"}`),
    ).toMatch(/^Invalid context.set request: content: /);
    expect(rejected('{"cmd":"status","extra":1}')).toMatch(
      /^Invalid status request: \(root\): Unrecognized key/,
    );
    expect(rejected('{"cmd":"version","json":true}')).toMatch(
      /^Invalid version request: \(root\): Unrecognized key/,
    );
    expect(rejected('{"cmd":"drain","timeoutMs":0}')).toMatch(
      /^Invalid drain request: timeoutMs: /,
    );
    expect(rejected('{"cmd":"drain","timeoutMs":86400001}')).toMatch(
      /^Invalid drain request: timeoutMs: /,
    );
    expect(rejected('{"cmd":"drain","timeoutMs":"60000"}')).toMatch(
      /^Invalid drain request: timeoutMs: /,
    );
    expect(rejected('{"cmd":"drain","agent":"all"}')).toMatch(
      /^Invalid drain request: \(root\): Unrecognized key/,
    );
  });

  it("lists every command", () => {
    expect([...CONTROL_COMMANDS].sort()).toEqual(
      [
        "status",
        "version",
        "pause",
        "resume",
        "drain",
        "settings.get",
        "settings.patch",
        "tasks.list",
        "tasks.add",
        "tasks.retry",
        "tasks.cancel",
        "memory.search",
        "memory.recent",
        "sessions.list",
        "sessions.get",
        "prompt.get",
        "prompt.set",
        "context.get",
        "context.set",
      ].sort(),
    );
  });
});

describe("buildControlStatus", () => {
  const identity: WorkerIdentity = {
    version: "1.2.3",
    claudeVersion: "2.1.268",
    nodeVersion: "22.16.0",
    pid: 4242,
    startedAt: "2026-07-08T08:00:00.000Z",
    projectDir: "/srv/project",
    authKind: "oauth",
  };
  const context = { identity, headless: true };

  it("maps worker identity, stats and task counts", () => {
    const snapshot = buildSnapshot({
      tasks: [
        buildTask(),
        buildTask({ id: "t-2", status: "done" }),
        buildTask({ id: "t-3", status: "done" }),
        buildTask({ id: "t-4", status: "failed" }),
        buildTask({ id: "t-5", status: "in_progress" }),
      ],
      stats: { cycles: 7, tasksSucceeded: 2, tasksFailed: 1, totalCostUsd: 1.5 },
    });

    const status = buildControlStatus({ ...context, snapshot });

    expect(status).toMatchObject({
      ...identity,
      headless: true,
      stats: { cycles: 7, tasksSucceeded: 2, tasksFailed: 1, totalCostUsd: 1.5 },
      taskCounts: { pending: 1, in_progress: 1, done: 2, failed: 1, cancelled: 0 },
    });
  });

  it("carries the identity through without adding fields it lacks", () => {
    const { version, nodeVersion, pid, startedAt, projectDir, authKind } = identity;
    const status = buildControlStatus({
      identity: { version, nodeVersion, pid, startedAt, projectDir, authKind },
      headless: false,
      snapshot: buildSnapshot(),
    });

    expect(status).not.toHaveProperty("claudeVersion");
    expect(status.headless).toBe(false);
  });

  it("serializes monitor phases with ISO timestamps", () => {
    const resumeAt = Date.parse("2026-07-08T09:00:00.000Z");
    const session = buildControlStatus({
      ...context,
      snapshot: buildSnapshot({
        monitor: {
          phase: { kind: "session", cycle: 3, startedAt: resumeAt },
          control: "running",
          tail: [],
          recentOutcomes: [],
        },
      }),
    });
    expect(session.agents.monitor.phase).toEqual({
      kind: "session",
      since: "2026-07-08T09:00:00.000Z",
      cycle: 3,
    });

    const sleeping = buildControlStatus({
      ...context,
      snapshot: buildSnapshot({
        monitor: {
          phase: { kind: "sleeping", nextCycleAt: resumeAt },
          control: "running",
          tail: [],
          recentOutcomes: [],
        },
      }),
    });
    expect(sleeping.agents.monitor.phase).toEqual({
      kind: "sleeping",
      until: "2026-07-08T09:00:00.000Z",
    });

    const limitWait = buildControlStatus({
      ...context,
      snapshot: buildSnapshot({
        monitor: {
          phase: { kind: "limitWait", resumeAt },
          control: "running",
          tail: [],
          recentOutcomes: [],
        },
      }),
    });
    expect(limitWait.agents.monitor.phase).toEqual({
      kind: "limitWait",
      until: "2026-07-08T09:00:00.000Z",
    });

    const authBlocked = buildControlStatus({
      ...context,
      snapshot: buildSnapshot({
        monitor: {
          phase: { kind: "authBlocked", reason: "Not logged in", since: resumeAt },
          control: "paused",
          tail: [],
          recentOutcomes: [],
        },
        executor: {
          phase: { kind: "authBlocked", reason: "HTTP 401", since: resumeAt },
          control: "paused",
          tail: [],
          recentOutcomes: [],
        },
      }),
    });
    expect(authBlocked.agents.monitor.phase).toEqual({
      kind: "authBlocked",
      since: "2026-07-08T09:00:00.000Z",
      reason: "Not logged in",
    });
    expect(authBlocked.agents.executor.phase).toEqual({
      kind: "authBlocked",
      since: "2026-07-08T09:00:00.000Z",
      reason: "HTTP 401",
    });
  });

  it("serializes executor phases with the task identity", () => {
    const at = Date.parse("2026-07-08T09:00:00.000Z");
    const task = buildTask();

    const session = buildControlStatus({
      ...context,
      snapshot: buildSnapshot({
        executor: {
          phase: { kind: "session", task, startedAt: at },
          control: "running",
          tail: [],
          recentOutcomes: [],
        },
      }),
    });
    expect(session.agents.executor.phase).toEqual({
      kind: "session",
      since: "2026-07-08T09:00:00.000Z",
      taskId: "task-1",
      title: "Fix the bug",
    });

    const backoff = buildControlStatus({
      ...context,
      snapshot: buildSnapshot({
        executor: {
          phase: { kind: "backoff", task, resumeAt: at },
          control: "paused",
          tail: [],
          recentOutcomes: [],
        },
      }),
    });
    expect(backoff.agents.executor.phase).toEqual({
      kind: "backoff",
      until: "2026-07-08T09:00:00.000Z",
      taskId: "task-1",
      title: "Fix the bug",
    });
    expect(backoff.agents.executor.control).toBe("paused");
  });

  it("leaves drain out until one is requested, then serializes it with ISO timestamps", () => {
    const idle = buildControlStatus({ ...context, snapshot: buildSnapshot() });
    const draining = buildControlStatus({
      ...context,
      snapshot: buildSnapshot({
        drain: {
          since: Date.parse("2026-07-08T09:00:00.000Z"),
          until: Date.parse("2026-07-08T09:15:00.000Z"),
          reason: "SIGTERM",
        },
      }),
    });
    const open = buildControlStatus({
      ...context,
      snapshot: buildSnapshot({
        drain: {
          since: Date.parse("2026-07-08T09:00:00.000Z"),
          until: undefined,
          reason: "drain",
        },
      }),
    });

    expect(JSON.parse(JSON.stringify(idle))).not.toHaveProperty("drain");
    expect(draining.drain).toEqual({
      since: "2026-07-08T09:00:00.000Z",
      until: "2026-07-08T09:15:00.000Z",
      reason: "SIGTERM",
    });
    expect(JSON.parse(JSON.stringify(open))).toMatchObject({
      drain: { since: "2026-07-08T09:00:00.000Z", reason: "drain" },
    });
    expect(JSON.parse(JSON.stringify(open.drain))).not.toHaveProperty("until");
  });

  it("caps recent outcomes at five entries", () => {
    const outcome = {
      cycle: 1,
      ok: true,
      durationMs: 10,
      addedTasks: 0,
      skippedDuplicates: 0,
      finishedAt: 1,
    };
    const status = buildControlStatus({
      ...context,
      snapshot: buildSnapshot({
        monitor: {
          phase: { kind: "starting" },
          control: "running",
          tail: [],
          recentOutcomes: Array.from({ length: 8 }, (_, index) => ({
            ...outcome,
            cycle: index + 1,
          })),
        },
      }),
    });

    expect(status.agents.monitor.recentOutcomes).toHaveLength(5);
    expect(status.agents.monitor.recentOutcomes[0]?.cycle).toBe(1);
  });
});

describe("buildDrainAck", () => {
  it("answers with the drain start and deadline as ISO timestamps", () => {
    expect(
      buildDrainAck({
        since: Date.parse("2026-07-08T09:00:00.000Z"),
        until: Date.parse("2026-07-08T09:15:00.000Z"),
        reason: "drain",
      }),
    ).toEqual({
      state: "draining",
      since: "2026-07-08T09:00:00.000Z",
      until: "2026-07-08T09:15:00.000Z",
    });
  });

  it("leaves until off the wire without a deadline", () => {
    const ack = buildDrainAck({
      since: Date.parse("2026-07-08T09:00:00.000Z"),
      until: undefined,
      reason: "SIGTERM",
    });

    expect(JSON.stringify(ack)).toBe(
      '{"state":"draining","since":"2026-07-08T09:00:00.000Z"}',
    );
  });
});
