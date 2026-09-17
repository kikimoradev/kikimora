import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sendControlRequest, WorkerNotRunningError } from "../src/control-client.js";
import {
  buildControlStatus,
  type ControlStatus,
  type WorkerIdentity,
} from "../src/control-protocol.js";
import {
  AlreadyRunningError,
  RESUME_WHILE_DRAINING,
  startControlServer,
  type ControlServerDeps,
  type ControlServerHandle,
} from "../src/control-server.js";
import { DrainController } from "../src/drain.js";
import type { SessionRecord } from "../src/sessions/index.js";
import { WorkerStatusStore } from "../src/status.js";
import type { Task } from "../src/types.js";

function buildTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "t-1",
    title: "Fix the bug",
    description: "details",
    status: "pending",
    attempts: 0,
    createdAt: "2026-07-08T08:00:00.000Z",
    updatedAt: "2026-07-08T08:00:00.000Z",
    ...overrides,
  };
}

function buildSessionRecord(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    sessionId: "sess-1",
    agent: "executor",
    taskId: "ci-42",
    model: "opus",
    startedAt: "2026-09-14T15:44:12.531Z",
    finishedAt: "2026-09-14T15:49:00.000Z",
    ok: true,
    costUsd: 0.4183,
    numTurns: 24,
    logPath: "logs/executor/2026-09-14/17-44-12-sess-1.log",
    jsonlPath: "logs/executor/2026-09-14/17-44-12-sess-1.jsonl",
    ...overrides,
  };
}

function fakeDeps() {
  return {
    tasks: {
      list: vi
        .fn()
        .mockReturnValue([buildTask(), buildTask({ id: "t-2", status: "failed" })]),
      retry: vi.fn().mockResolvedValue(true),
      cancel: vi.fn().mockResolvedValue(true),
      addTasks: vi
        .fn()
        .mockImplementation((tasks: Task[]) =>
          Promise.resolve(tasks.map((task) => buildTask({ ...task, status: "pending" }))),
        ),
    },
    memory: {
      search: vi.fn().mockReturnValue([]),
      recent: vi.fn().mockReturnValue([]),
    },
    sessions: {
      list: vi.fn().mockReturnValue([]),
      get: vi.fn().mockReturnValue(undefined),
    },
    settings: {
      current: vi.fn().mockResolvedValue({ streamPartial: true }),
      patch: vi.fn().mockResolvedValue({ streamPartial: false }),
    },
    prompts: {
      read: vi.fn().mockResolvedValue("watch the pipelines"),
      write: vi.fn().mockResolvedValue(undefined),
    },
    context: {
      read: vi.fn().mockResolvedValue("# Workspace context"),
      write: vi.fn().mockResolvedValue(undefined),
    },
    waker: { notify: vi.fn() },
  };
}

type FakeDeps = ReturnType<typeof fakeDeps>;

async function rawRequest(socketPath: string, payload: string): Promise<string> {
  const socketModule = await import("node:net");
  return new Promise<string>((resolve, reject) => {
    const socket = socketModule.connect(socketPath);
    let buffer = "";
    socket.on("error", reject);
    socket.on("connect", () => socket.write(payload));
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      if (buffer.includes("\n")) {
        socket.destroy();
        resolve(buffer);
      }
    });
  });
}

function buildIdentity(overrides: Partial<WorkerIdentity> = {}): WorkerIdentity {
  return {
    version: "1.0.0",
    claudeVersion: "2.1.268",
    nodeVersion: "22.16.0",
    pid: 4242,
    startedAt: "2026-07-08T08:00:00.000Z",
    projectDir: "/srv/project",
    authKind: "oauth",
    ...overrides,
  };
}

function buildStatus(overrides: Partial<ControlStatus> = {}): ControlStatus {
  return {
    ...buildIdentity(),
    headless: true,
    agents: {
      monitor: { phase: { kind: "starting" }, control: "running", recentOutcomes: [] },
      executor: { phase: { kind: "waiting" }, control: "running", recentOutcomes: [] },
    },
    stats: { cycles: 0, tasksSucceeded: 0, tasksFailed: 0, totalCostUsd: 0 },
    taskCounts: { pending: 0, in_progress: 0, done: 0, failed: 0, cancelled: 0 },
    ...overrides,
  };
}

let socketCounter = 0;

function tempSocketPath(): string {
  socketCounter += 1;
  return join(
    tmpdir(),
    `brownie-test-${String(process.pid)}-${String(socketCounter)}.sock`,
  );
}

describe("startControlServer", () => {
  let socketPath: string;
  let abort: AbortController;
  let handles: ControlServerHandle[];
  let drains: DrainController[];

  function controls() {
    return {
      monitor: { pause: vi.fn(), resume: vi.fn() },
      executor: { pause: vi.fn(), resume: vi.fn() },
    };
  }

  function drainOf(agents: ReturnType<typeof controls>): DrainController {
    const drain = new DrainController(
      {
        monitor: { pause: agents.monitor.pause, state: "pausing" },
        executor: { pause: agents.executor.pause, state: "pausing" },
      },
      () => undefined,
    );
    drains.push(drain);
    return drain;
  }

  interface DepsOverrides {
    identity?: WorkerIdentity;
    buildStatus?: () => ControlStatus;
    controls?: ReturnType<typeof controls>;
    drain?: DrainController;
    fakes?: FakeDeps;
  }

  function fullDeps(overrides: DepsOverrides = {}): ControlServerDeps & FakeDeps {
    const agents = overrides.controls ?? controls();
    return {
      socketPath,
      identity: overrides.identity ?? buildIdentity(),
      buildStatus: overrides.buildStatus ?? (() => buildStatus()),
      controls: agents,
      drain: overrides.drain ?? drainOf(agents),
      ...(overrides.fakes ?? fakeDeps()),
      signal: abort.signal,
    };
  }

  async function startServer(overrides: DepsOverrides = {}) {
    const deps = fullDeps(overrides);
    const handle = await startControlServer(deps);
    handles.push(handle);
    return { handle, deps };
  }

  beforeEach(() => {
    socketPath = tempSocketPath();
    abort = new AbortController();
    handles = [];
    drains = [];
  });

  afterEach(async () => {
    for (const handle of handles) await handle.close();
    for (const drain of drains) drain.dispose();
  });

  it("answers a status request with the built status", async () => {
    await startServer({ buildStatus: () => buildStatus({ pid: 777 }) });

    const response = await sendControlRequest(socketPath, { cmd: "status" });

    expect(response.ok).toBe(true);
    if (response.ok) expect(response.data).toMatchObject({ pid: 777, version: "1.0.0" });
  });

  it("answers a version request with the worker identity alone", async () => {
    const identity = buildIdentity({ pid: 777, claudeVersion: "2.1.300" });
    await startServer({ identity });

    const response = await sendControlRequest(socketPath, { cmd: "version" });

    expect(response).toEqual({ ok: true, data: identity });
  });

  it("routes pause and resume to the right controllers", async () => {
    const ctrl = controls();
    await startServer({ controls: ctrl });

    await sendControlRequest(socketPath, { cmd: "pause", agent: "monitor" });
    await sendControlRequest(socketPath, { cmd: "resume", agent: "executor" });
    await sendControlRequest(socketPath, { cmd: "pause", agent: "all" });

    expect(ctrl.monitor.pause).toHaveBeenCalledTimes(2);
    expect(ctrl.executor.pause).toHaveBeenCalledTimes(1);
    expect(ctrl.executor.resume).toHaveBeenCalledTimes(1);
    expect(ctrl.monitor.resume).not.toHaveBeenCalled();
  });

  it("acknowledges a drain with its start and deadline and pauses both agents", async () => {
    const ctrl = controls();
    await startServer({ controls: ctrl });
    const before = Date.now();

    const response = await sendControlRequest(socketPath, {
      cmd: "drain",
      timeoutMs: 60_000,
    });

    expect(response.ok).toBe(true);
    if (!response.ok) return;
    const since = Date.parse(response.data.since);
    expect(response.data.state).toBe("draining");
    expect(since).toBeGreaterThanOrEqual(before);
    expect(response.data.until).toBe(new Date(since + 60_000).toISOString());
    expect(ctrl.monitor.pause).toHaveBeenCalledTimes(1);
    expect(ctrl.executor.pause).toHaveBeenCalledTimes(1);
  });

  it("answers a repeated drain with the first acknowledgement, deadline unchanged", async () => {
    const ctrl = controls();
    await startServer({ controls: ctrl });

    const first = await sendControlRequest(socketPath, {
      cmd: "drain",
      timeoutMs: 60_000,
    });
    const shorter = await sendControlRequest(socketPath, {
      cmd: "drain",
      timeoutMs: 1_000,
    });
    const open = await sendControlRequest(socketPath, { cmd: "drain" });

    expect(shorter).toEqual(first);
    expect(open).toEqual(first);
    expect(ctrl.monitor.pause).toHaveBeenCalledTimes(1);
  });

  it("omits until from a drain without a timeout", async () => {
    await startServer();

    const raw = await rawRequest(socketPath, '{"cmd":"drain"}\n');

    const response = JSON.parse(raw.trim()) as { ok: boolean; data: object };
    expect(response.ok).toBe(true);
    expect(Object.keys(response.data)).toEqual(["state", "since"]);
  });

  it("rejects a drain timeout out of range or an unknown field", async () => {
    await startServer();

    const errors = await Promise.all(
      [
        '{"cmd":"drain","timeoutMs":0}',
        '{"cmd":"drain","timeoutMs":86400001}',
        '{"cmd":"drain","timeoutMs":1.5}',
        '{"cmd":"drain","force":true}',
      ].map(async (line) => {
        const response = JSON.parse(
          (await rawRequest(socketPath, `${line}\n`)).trim(),
        ) as {
          ok: boolean;
          error: string;
        };
        return response.error;
      }),
    );

    expect(errors[0]).toMatch(/^Invalid drain request: timeoutMs: /);
    expect(errors[1]).toMatch(/^Invalid drain request: timeoutMs: /);
    expect(errors[2]).toMatch(/^Invalid drain request: timeoutMs: /);
    expect(errors[3]).toMatch(/^Invalid drain request: \(root\): /);
  });

  it("refuses resume while draining and still accepts pause", async () => {
    const ctrl = controls();
    await startServer({ controls: ctrl });
    await sendControlRequest(socketPath, { cmd: "drain" });

    const resumed = await sendControlRequest(socketPath, { cmd: "resume", agent: "all" });
    const paused = await sendControlRequest(socketPath, { cmd: "pause", agent: "all" });

    expect(resumed).toEqual({ ok: false, error: RESUME_WHILE_DRAINING });
    expect(ctrl.monitor.resume).not.toHaveBeenCalled();
    expect(ctrl.executor.resume).not.toHaveBeenCalled();
    expect(paused).toEqual({ ok: true });
  });

  it("reports the drain in status once one is requested", async () => {
    const ctrl = controls();
    const store = new WorkerStatusStore();
    const drain = new DrainController(
      {
        monitor: { pause: ctrl.monitor.pause, state: "pausing" },
        executor: { pause: ctrl.executor.pause, state: "pausing" },
      },
      () => undefined,
      (snapshot) => {
        store.drainRequested(snapshot);
      },
    );
    drains.push(drain);
    await startServer({
      controls: ctrl,
      drain,
      buildStatus: () => {
        store.flush();
        return buildControlStatus({
          snapshot: store.getSnapshot(),
          identity: buildIdentity(),
          headless: true,
        });
      },
    });

    const idle = await rawRequest(socketPath, '{"cmd":"status"}\n');
    const ack = await sendControlRequest(socketPath, { cmd: "drain", timeoutMs: 5_000 });
    const draining = await sendControlRequest(socketPath, { cmd: "status" });

    expect(idle).not.toContain('"drain"');
    expect(ack.ok && draining.ok).toBe(true);
    if (!ack.ok || !draining.ok) return;
    expect(draining.data.drain).toEqual({
      since: ack.data.since,
      until: ack.data.until,
      reason: "drain",
    });
    store.dispose();
  });

  it("rejects an unrecognized request without crashing", async () => {
    await startServer();

    const raw = await rawRequest(socketPath, "definitely not json\n");

    expect(JSON.parse(raw.trim())).toEqual({
      ok: false,
      error: "Unrecognized control request.",
    });

    const response = await sendControlRequest(socketPath, { cmd: "status" });
    expect(response.ok).toBe(true);
  });

  it("explains an invalid payload and answers only once per connection", async () => {
    await startServer();

    const raw = await rawRequest(socketPath, '{"cmd":"tasks.add"}\n{"cmd":"status"}\n');

    const lines = raw.trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "")).toEqual({
      ok: false,
      error: expect.stringMatching(/^Invalid tasks.add request: description/) as string,
    });
  });

  it("refuses an oversized request", async () => {
    await startServer();

    const raw = await rawRequest(
      socketPath,
      `{"cmd":"prompt.set","content":"${"x".repeat(1_100_000)}`,
    );

    expect(JSON.parse(raw.trim())).toEqual({
      ok: false,
      error: "Control request too large.",
    });
  });

  it("serves settings.get and settings.patch through the controller", async () => {
    const { deps } = await startServer();

    const current = await sendControlRequest(socketPath, { cmd: "settings.get" });
    const patched = await sendControlRequest(socketPath, {
      cmd: "settings.patch",
      patch: { monitor: { intervalMinutes: 5 } },
    });

    expect(current).toEqual({ ok: true, data: { streamPartial: true } });
    expect(deps.settings.patch).toHaveBeenCalledWith({ monitor: { intervalMinutes: 5 } });
    expect(patched).toEqual({ ok: true, data: { streamPartial: false } });
  });

  it("maps a rejected settings patch to an error and keeps serving", async () => {
    const fakes = fakeDeps();
    fakes.settings.patch.mockRejectedValue(
      new Error(
        "Invalid configuration (.brownie/settings.json):\n  - monitor.intervalMinutes: bad",
      ),
    );
    await startServer({ fakes });

    const response = await sendControlRequest(socketPath, {
      cmd: "settings.patch",
      patch: { monitor: { intervalMinutes: -1 } },
    });

    expect(response).toEqual({
      ok: false,
      error: expect.stringContaining("monitor.intervalMinutes") as string,
    });
    const status = await sendControlRequest(socketPath, { cmd: "status" });
    expect(status.ok).toBe(true);
  });

  it("lists tasks with and without a status filter", async () => {
    await startServer();

    const all = await sendControlRequest(socketPath, { cmd: "tasks.list" });
    const failed = await sendControlRequest(socketPath, {
      cmd: "tasks.list",
      status: "failed",
    });

    expect(all.ok && all.data.map((task) => task.id)).toEqual(["t-1", "t-2"]);
    expect(failed.ok && failed.data.map((task) => task.id)).toEqual(["t-2"]);
  });

  it("adds a task from a description, generating id and title, and wakes the executor", async () => {
    const { deps } = await startServer();

    const response = await sendControlRequest(socketPath, {
      cmd: "tasks.add",
      description: "Rotate the API key\nbefore Friday",
    });

    expect(response.ok).toBe(true);
    if (response.ok) {
      expect(response.data.id).toMatch(/^manual-/);
      expect(response.data.title).toBe("Rotate the API key");
      expect(response.data.description).toBe("Rotate the API key\nbefore Friday");
    }
    expect(deps.waker.notify).toHaveBeenCalledTimes(1);
  });

  it("adds a task with an explicit id and title", async () => {
    const { deps } = await startServer();

    await sendControlRequest(socketPath, {
      cmd: "tasks.add",
      description: "Do the thing",
      id: "ci-42",
      title: "Custom",
    });

    expect(deps.tasks.addTasks).toHaveBeenCalledWith([
      { id: "ci-42", title: "Custom", description: "Do the thing" },
    ]);
  });

  it("reports a duplicate task id without waking the executor", async () => {
    const fakes = fakeDeps();
    fakes.tasks.addTasks.mockResolvedValue([]);
    await startServer({ fakes });

    const response = await sendControlRequest(socketPath, {
      cmd: "tasks.add",
      description: "Again",
      id: "ci-42",
    });

    expect(response).toEqual({ ok: false, error: 'Task "ci-42" already exists.' });
    expect(fakes.waker.notify).not.toHaveBeenCalled();
  });

  it("retries and cancels tasks, waking the executor only on a successful retry", async () => {
    const fakes = fakeDeps();
    fakes.tasks.retry.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    fakes.tasks.cancel.mockResolvedValue(false);
    await startServer({ fakes });

    const retried = await sendControlRequest(socketPath, {
      cmd: "tasks.retry",
      id: "t-2",
    });
    const notRetried = await sendControlRequest(socketPath, {
      cmd: "tasks.retry",
      id: "x",
    });
    const cancelled = await sendControlRequest(socketPath, {
      cmd: "tasks.cancel",
      id: "x",
    });

    expect(retried).toEqual({ ok: true, data: true });
    expect(notRetried).toEqual({ ok: true, data: false });
    expect(cancelled).toEqual({ ok: true, data: false });
    expect(fakes.tasks.retry).toHaveBeenCalledWith("t-2");
    expect(fakes.tasks.cancel).toHaveBeenCalledWith("x");
    expect(fakes.waker.notify).toHaveBeenCalledTimes(1);
  });

  it("searches memory with the requested and the default limit", async () => {
    const { deps } = await startServer();

    await sendControlRequest(socketPath, {
      cmd: "memory.search",
      query: "deploy",
      limit: 5,
    });
    await sendControlRequest(socketPath, { cmd: "memory.recent" });

    expect(deps.memory.search).toHaveBeenCalledWith("deploy", 5);
    expect(deps.memory.recent).toHaveBeenCalledWith(10);
  });

  it("lists sessions with the default limit and forwards every filter", async () => {
    const fakes = fakeDeps();
    fakes.sessions.list.mockReturnValue([buildSessionRecord()]);
    await startServer({ fakes });

    const all = await sendControlRequest(socketPath, { cmd: "sessions.list" });
    await sendControlRequest(socketPath, {
      cmd: "sessions.list",
      agent: "executor",
      taskId: "ci-42",
      before: "2026-09-14T15:44:12.531Z",
      limit: 5,
    });

    expect(all.ok && all.data).toEqual([buildSessionRecord()]);
    expect(fakes.sessions.list).toHaveBeenNthCalledWith(1, {
      agent: undefined,
      taskId: undefined,
      before: undefined,
      limit: 20,
    });
    expect(fakes.sessions.list).toHaveBeenNthCalledWith(2, {
      agent: "executor",
      taskId: "ci-42",
      before: "2026-09-14T15:44:12.531Z",
      limit: 5,
    });
  });

  it("gets one session and reports an unknown id", async () => {
    const fakes = fakeDeps();
    fakes.sessions.get.mockReturnValueOnce(buildSessionRecord());
    await startServer({ fakes });

    const found = await sendControlRequest(socketPath, {
      cmd: "sessions.get",
      sessionId: "sess-1",
    });
    const missing = await sendControlRequest(socketPath, {
      cmd: "sessions.get",
      sessionId: "nope",
    });

    expect(found).toEqual({ ok: true, data: buildSessionRecord() });
    expect(missing).toEqual({ ok: false, error: 'Session "nope" is not indexed.' });
  });

  it("rejects an unknown agent and an out-of-range session limit", async () => {
    await startServer();

    const badAgent = await rawRequest(
      socketPath,
      '{"cmd":"sessions.list","agent":"wizard"}\n',
    );
    const badLimit = await rawRequest(socketPath, '{"cmd":"sessions.list","limit":0}\n');

    expect(JSON.parse(badAgent.trim())).toEqual({
      ok: false,
      error: expect.stringMatching(/^Invalid sessions.list request: agent/) as string,
    });
    expect(JSON.parse(badLimit.trim())).toEqual({
      ok: false,
      error: expect.stringMatching(/^Invalid sessions.list request: limit/) as string,
    });
  });

  it("reads and writes prompts", async () => {
    const { deps } = await startServer();
    const content = `# Executor\n${"line\n".repeat(40_000)}`;

    const read = await sendControlRequest(socketPath, {
      cmd: "prompt.get",
      agent: "monitor",
    });
    const written = await sendControlRequest(socketPath, {
      cmd: "prompt.set",
      agent: "executor",
      content,
    });

    expect(read).toEqual({
      ok: true,
      data: { agent: "monitor", content: "watch the pipelines" },
    });
    expect(written).toEqual({ ok: true });
    expect(deps.prompts.write).toHaveBeenCalledWith("executor", content);
  });

  it("reads and writes the context file", async () => {
    const { deps } = await startServer();

    const read = await sendControlRequest(socketPath, { cmd: "context.get" });
    const written = await sendControlRequest(socketPath, {
      cmd: "context.set",
      content: "# Workspace context\n\nacme-shop",
    });

    expect(read).toEqual({ ok: true, data: { content: "# Workspace context" } });
    expect(written).toEqual({ ok: true });
    expect(deps.context.write).toHaveBeenCalledWith("# Workspace context\n\nacme-shop");
  });

  it("clears the context file with an empty string", async () => {
    const { deps } = await startServer();

    const response = await sendControlRequest(socketPath, {
      cmd: "context.set",
      content: "",
    });

    expect(response).toEqual({ ok: true });
    expect(deps.context.write).toHaveBeenCalledWith("");
  });

  it("reports an absent context file as an empty context", async () => {
    const fakes = fakeDeps();
    fakes.context.read.mockResolvedValue("");
    await startServer({ fakes });

    const response = await sendControlRequest(socketPath, { cmd: "context.get" });

    expect(response).toEqual({ ok: true, data: { content: "" } });
  });

  it("explains a missing prompt file", async () => {
    const fakes = fakeDeps();
    fakes.prompts.read.mockRejectedValue(
      Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
    );
    await startServer({ fakes });

    const response = await sendControlRequest(socketPath, {
      cmd: "prompt.get",
      agent: "executor",
    });

    expect(response).toEqual({
      ok: false,
      error: "Prompt file for executor is missing — run brownie init.",
    });
  });

  it("removes a stale socket file before listening", async () => {
    await writeFile(socketPath, "", "utf8");

    await startServer();

    const response = await sendControlRequest(socketPath, { cmd: "status" });
    expect(response.ok).toBe(true);
  });

  it("creates the socket directory when it is missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "brownie-socket-dir-"));
    socketPath = join(dir, "nested", "control.sock");

    try {
      await startServer();

      const response = await sendControlRequest(socketPath, { cmd: "status" });
      expect(response.ok).toBe(true);
    } finally {
      for (const handle of handles) await handle.close();
      handles = [];
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("explains a socket that cannot be opened", async () => {
    const dir = await mkdtemp(join(tmpdir(), "brownie-socket-dir-"));
    const blocker = join(dir, "not-a-directory");
    await writeFile(blocker, "", "utf8");
    socketPath = join(blocker, "control.sock");

    try {
      await expect(startServer()).rejects.toThrow(
        /Cannot open the control socket .*control\.sock .*BROWNIE_CONTROL_SOCKET/,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("refuses to start when another worker owns the socket", async () => {
    await startServer({ buildStatus: () => buildStatus({ pid: 12345 }) });

    await expect(startControlServer(fullDeps())).rejects.toThrow(AlreadyRunningError);
    await expect(startControlServer(fullDeps())).rejects.toThrow("pid 12345");
  });

  it("close() removes the socket and stops answering", async () => {
    const { handle } = await startServer();

    await handle.close();

    expect(existsSync(socketPath)).toBe(false);
    await expect(sendControlRequest(socketPath, { cmd: "status" })).rejects.toThrow(
      WorkerNotRunningError,
    );
  });

  it("closes when the abort signal fires", async () => {
    await startServer();

    abort.abort();
    await vi.waitFor(() => {
      expect(existsSync(socketPath)).toBe(false);
    });
  });
});
