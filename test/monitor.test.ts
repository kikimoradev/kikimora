import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskStore } from "../src/tasks.js";
import type { SessionResult, Task } from "../src/types.js";
import { Waker } from "../src/waker.js";
import {
  authFailureResult,
  authGateHarness,
  buildConfig,
  buildGates,
  createMonitorReporterSpy,
  noopController,
  type MonitorReporterSpy,
} from "./helpers.js";

const mocks = vi.hoisted(() => ({
  runSession: vi.fn(),
  readFile: vi.fn(),
  writeMcpConfig: vi.fn(),
}));

vi.mock("../src/runner.js", () => ({ runSession: mocks.runSession }));
vi.mock("../src/mcp-config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/mcp-config.js")>()),
  writeMcpConfig: mocks.writeMcpConfig,
}));
vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs/promises")>()),
  readFile: mocks.readFile,
}));

const { runMonitorLoop } = await import("../src/monitor.js");
const { TASK_REPORT_JSON_SCHEMA } = await import("../src/report.js");

const INTERVAL = 300_000;

function report(...ids: string[]): string {
  return JSON.stringify({
    tasks: ids.map((id) => ({ id, title: `Task ${id}`, description: "" })),
  });
}

function ok(resultText?: string): SessionResult {
  return { ok: true, durationMs: 0, resultText };
}

function fakeStore(addTasks = vi.fn()): { store: TaskStore; addTasks: typeof addTasks } {
  addTasks.mockImplementation((tasks: Task[]) =>
    Promise.resolve(
      tasks.map((task) => ({ ...task, status: "pending" }) as unknown as Task),
    ),
  );
  return { store: { addTasks } as unknown as TaskStore, addTasks };
}

describe("runMonitorLoop", () => {
  let spy: MonitorReporterSpy;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    spy = createMonitorReporterSpy();
    mocks.readFile.mockImplementation((path: string) =>
      path.endsWith("context.md")
        ? Promise.reject(Object.assign(new Error("ENOENT"), { code: "ENOENT" }))
        : Promise.resolve(path.includes("system") ? "system\n" : "prompt\n"),
    );
    mocks.writeMcpConfig.mockImplementation((dataDir: string, input: { role: string }) =>
      Promise.resolve(join(dataDir, "mcp", `${input.role}.json`)),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("appends the report contract to the system prompt and passes the prompt and session sink", async () => {
    mocks.runSession.mockResolvedValue(ok(report()));
    const { store } = fakeStore();
    const controller = new AbortController();
    const config = buildConfig({
      monitor: {
        ...buildConfig().monitor,
        promptPath: "/x/monitor.prompt.md",
        systemPromptPath: "/x/monitor.system.md",
      },
    });

    const promise = runMonitorLoop(
      config,
      store,
      new Waker(),
      spy.reporter,
      noopController(),
      buildGates(),
      controller.signal,
    );
    await vi.advanceTimersByTimeAsync(1);
    controller.abort();
    await vi.advanceTimersByTimeAsync(INTERVAL);
    await promise;

    const spec = mocks.runSession.mock.calls[0]?.[0] as {
      systemPrompt: string;
      prompt: string;
      model: string;
      effort: string;
      mcpConfigPath: string;
      jsonSchema: string;
      events: unknown;
    };
    expect(spec.systemPrompt).toBe("system\n");
    expect(spec.prompt).toBe("prompt\n");
    expect(spec.model).toBe("haiku");
    expect(spec.effort).toBe("medium");
    expect(spec.mcpConfigPath).toBe(join(config.dataDir, "mcp", "monitor.json"));
    expect(spec.jsonSchema).toBe(TASK_REPORT_JSON_SCHEMA);
    expect(spec.events).toBe(spy.reporter.session);
  });

  it("appends the context file to the prompt", async () => {
    mocks.runSession.mockResolvedValue(ok(report()));
    mocks.readFile.mockImplementation((path: string) =>
      Promise.resolve(path.endsWith("context.md") ? "# Workspace context\n" : "prompt\n"),
    );
    const { store } = fakeStore();
    const controller = new AbortController();
    const config = buildConfig();

    const promise = runMonitorLoop(
      config,
      store,
      new Waker(),
      spy.reporter,
      noopController(),
      buildGates(),
      controller.signal,
    );
    await vi.advanceTimersByTimeAsync(1);
    controller.abort();
    await vi.advanceTimersByTimeAsync(INTERVAL);
    await promise;

    const spec = mocks.runSession.mock.calls[0]?.[0] as { prompt: string };
    expect(mocks.readFile).toHaveBeenCalledWith(config.contextFilePath, "utf8");
    expect(spec.prompt).toBe("prompt\n\n# Workspace context\n");
  });

  it("composes the monitor MCP config from the live settings and never with memory", async () => {
    mocks.runSession.mockResolvedValue(ok(report()));
    const { store } = fakeStore();
    const controller = new AbortController();
    const base = buildConfig();
    const config = buildConfig({
      browser: true,
      mcpServers: { linter: { command: "run-linter" } },
      monitor: { ...base.monitor, mcpServers: ["linter"] },
    });

    const promise = runMonitorLoop(
      config,
      store,
      new Waker(),
      spy.reporter,
      noopController(),
      buildGates(),
      controller.signal,
    );
    await vi.advanceTimersByTimeAsync(1);
    controller.abort();
    await vi.advanceTimersByTimeAsync(INTERVAL);
    await promise;

    expect(mocks.writeMcpConfig).toHaveBeenCalledWith(config.dataDir, {
      role: "monitor",
      servers: config.mcpServers,
      selected: ["linter"],
      browser: true,
      memoryDbPath: null,
      playwrightOutputDir: config.playwrightOutputDir,
    });
  });

  it("adds tasks from the report, reports the cycle result and wakes the executor", async () => {
    mocks.runSession.mockResolvedValue(ok(report("redmine-1")));
    const { store, addTasks } = fakeStore();
    const waker = new Waker();
    const notify = vi.spyOn(waker, "notify");
    const controller = new AbortController();

    const promise = runMonitorLoop(
      buildConfig(),
      store,
      waker,
      spy.reporter,
      noopController(),
      buildGates(),
      controller.signal,
    );
    await vi.advanceTimersByTimeAsync(1);

    expect(spy.cycleStarted).toHaveBeenCalledWith(1);
    expect(addTasks).toHaveBeenCalledWith([
      { id: "redmine-1", title: "Task redmine-1", description: "" },
    ]);
    expect(spy.cycleFinished).toHaveBeenCalledWith(
      expect.objectContaining({ cycle: 1, ok: true, addedTasks: 1 }),
    );
    expect(notify).toHaveBeenCalledTimes(1);

    controller.abort();
    await vi.advanceTimersByTimeAsync(INTERVAL);
    await promise;
  });

  it("does not wake the executor when all tasks are duplicates", async () => {
    mocks.runSession.mockResolvedValue(ok(report("known")));
    const addTasks = vi.fn().mockResolvedValue([]);
    const store = { addTasks } as unknown as TaskStore;
    const waker = new Waker();
    const notify = vi.spyOn(waker, "notify");
    const controller = new AbortController();

    const promise = runMonitorLoop(
      buildConfig(),
      store,
      waker,
      spy.reporter,
      noopController(),
      buildGates(),
      controller.signal,
    );
    await vi.advanceTimersByTimeAsync(1);

    expect(addTasks).toHaveBeenCalledTimes(1);
    expect(notify).not.toHaveBeenCalled();
    expect(spy.cycleFinished).toHaveBeenCalledWith(
      expect.objectContaining({ ok: true, addedTasks: 0, skippedDuplicates: 1 }),
    );

    controller.abort();
    await vi.advanceTimersByTimeAsync(INTERVAL);
    await promise;
  });

  it("an invalid report ends the cycle with an error and continues the loop", async () => {
    mocks.runSession
      .mockResolvedValueOnce(ok("gibberish without json"))
      .mockResolvedValue(ok(report()));
    const { store, addTasks } = fakeStore();
    const controller = new AbortController();

    const promise = runMonitorLoop(
      buildConfig(),
      store,
      new Waker(),
      spy.reporter,
      noopController(),
      buildGates(),
      controller.signal,
    );
    await vi.advanceTimersByTimeAsync(1);

    expect(spy.cycleFinished).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: false,
        error: expect.stringContaining("invalid task report") as string,
      }),
    );
    expect(addTasks).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(mocks.runSession).toHaveBeenCalledTimes(2);

    controller.abort();
    await vi.advanceTimersByTimeAsync(INTERVAL);
    await promise;
  });

  it("a missing resultText is treated as an invalid report", async () => {
    mocks.runSession.mockResolvedValue(ok(undefined));
    const { store, addTasks } = fakeStore();
    const controller = new AbortController();

    const promise = runMonitorLoop(
      buildConfig(),
      store,
      new Waker(),
      spy.reporter,
      noopController(),
      buildGates(),
      controller.signal,
    );
    await vi.advanceTimersByTimeAsync(1);

    expect(spy.cycleFinished).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: false,
        error: expect.stringContaining("invalid task report") as string,
      }),
    );
    expect(addTasks).not.toHaveBeenCalled();

    controller.abort();
    await vi.advanceTimersByTimeAsync(INTERVAL);
    await promise;
  });

  it("a usage-limit failure skips the interval and waits for the reset", async () => {
    const resetsAt = Math.floor(Date.now() / 1000) + 2;
    mocks.runSession
      .mockResolvedValueOnce({
        ok: false,
        durationMs: 10,
        failureReason: "isError",
        error: "Session ended with an error (is_error)",
        rateLimit: { status: "rejected", resetsAt, rateLimitType: "five_hour" },
      } satisfies SessionResult)
      .mockResolvedValue(ok(report()));
    const { store } = fakeStore();
    const controller = new AbortController();

    const promise = runMonitorLoop(
      buildConfig(),
      store,
      new Waker(),
      spy.reporter,
      noopController(),
      buildGates(),
      controller.signal,
    );
    await vi.advanceTimersByTimeAsync(1);

    expect(spy.cycleFinished).toHaveBeenCalledWith(
      expect.objectContaining({ ok: false, error: "usage limit reached" }),
    );
    expect(spy.sleepUntil).not.toHaveBeenCalled();
    expect(spy.usageLimit).toHaveBeenCalledWith(expect.any(Date));
    expect(mocks.runSession).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(63_000);
    expect(mocks.runSession).toHaveBeenCalledTimes(2);

    controller.abort();
    await vi.advanceTimersByTimeAsync(INTERVAL);
    await promise;
  });

  it("an auth failure parks the loop until resume and never schedules the next cycle", async () => {
    mocks.runSession
      .mockResolvedValueOnce(authFailureResult())
      .mockResolvedValue(ok(report()));
    const { store } = fakeStore();
    const { gates, controller: control } = authGateHarness();
    const controller = new AbortController();

    const promise = runMonitorLoop(
      buildConfig(),
      store,
      new Waker(),
      spy.reporter,
      control,
      gates,
      controller.signal,
    );
    await vi.advanceTimersByTimeAsync(1);

    expect(spy.cycleFinished).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: false,
        error: "authentication failed — Not logged in · Please run /login",
      }),
    );
    expect(spy.authBlocked).toHaveBeenCalledTimes(1);
    expect(spy.authBlocked).toHaveBeenCalledWith({
      reason: "Not logged in · Please run /login",
    });
    expect(spy.sleepUntil).not.toHaveBeenCalled();
    expect(spy.usageLimit).not.toHaveBeenCalled();
    expect(control.state).toBe("paused");
    expect(mocks.runSession).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(INTERVAL * 3);
    expect(mocks.runSession).toHaveBeenCalledTimes(1);

    control.resume();
    await vi.advanceTimersByTimeAsync(1);
    expect(gates.auth.blocked).toBeNull();
    expect(mocks.runSession).toHaveBeenCalledTimes(2);
    expect(spy.sleepUntil).toHaveBeenCalledTimes(1);

    controller.abort();
    await vi.advanceTimersByTimeAsync(INTERVAL);
    await promise;
  });

  it("a 401 with API Error wording is an auth failure, not a usage limit", async () => {
    mocks.runSession
      .mockResolvedValueOnce(
        authFailureResult({
          resultText:
            "Failed to authenticate. API Error: 401 OAuth access token is invalid.",
          apiError: { status: 401, code: "authentication_failed" },
        }),
      )
      .mockResolvedValue(ok(report()));
    const { store } = fakeStore();
    const { gates, controller: control } = authGateHarness();
    const controller = new AbortController();

    const promise = runMonitorLoop(
      buildConfig(),
      store,
      new Waker(),
      spy.reporter,
      control,
      gates,
      controller.signal,
    );
    await vi.advanceTimersByTimeAsync(1);

    expect(spy.usageLimit).not.toHaveBeenCalled();
    expect(spy.authBlocked).toHaveBeenCalledWith({
      reason: "Failed to authenticate. API Error: 401 OAuth access token is invalid.",
    });
    expect(gates.limit.msRemaining(Date.now())).toBe(0);

    controller.abort();
    await promise;
  });

  it("a failed session does not parse the report, the loop keeps going", async () => {
    mocks.runSession
      .mockResolvedValueOnce({
        ok: false,
        durationMs: 100,
        error: "Session timed out",
        resultText: report("should-not-arrive"),
      } satisfies SessionResult)
      .mockResolvedValue(ok(report()));
    const { store, addTasks } = fakeStore();
    const controller = new AbortController();

    const promise = runMonitorLoop(
      buildConfig(),
      store,
      new Waker(),
      spy.reporter,
      noopController(),
      buildGates(),
      controller.signal,
    );
    await vi.advanceTimersByTimeAsync(1);

    expect(spy.cycleFinished).toHaveBeenCalledWith(
      expect.objectContaining({ ok: false, error: "Session timed out" }),
    );
    expect(addTasks).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(mocks.runSession).toHaveBeenCalledTimes(2);

    controller.abort();
    await vi.advanceTimersByTimeAsync(INTERVAL);
    await promise;
  });

  it("runs the next cycle after the interval elapses and reports sleep", async () => {
    mocks.runSession.mockResolvedValue(ok(report()));
    const { store } = fakeStore();
    const controller = new AbortController();

    const promise = runMonitorLoop(
      buildConfig(),
      store,
      new Waker(),
      spy.reporter,
      noopController(),
      buildGates(),
      controller.signal,
    );
    await vi.advanceTimersByTimeAsync(1);
    expect(mocks.runSession).toHaveBeenCalledTimes(1);
    expect(spy.sleepUntil).toHaveBeenCalledWith(expect.any(Date));

    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(mocks.runSession).toHaveBeenCalledTimes(2);
    expect(spy.cycleStarted).toHaveBeenLastCalledWith(2);

    controller.abort();
    await vi.advanceTimersByTimeAsync(INTERVAL);
    await promise;
  });

  it("when the interval is exceeded the next cycle starts immediately without sleeping", async () => {
    mocks.runSession.mockImplementation(
      () =>
        new Promise<SessionResult>((res) =>
          setTimeout(() => res(ok(report())), INTERVAL + 1000),
        ),
    );
    const { store } = fakeStore();
    const controller = new AbortController();

    const promise = runMonitorLoop(
      buildConfig(),
      store,
      new Waker(),
      spy.reporter,
      noopController(),
      buildGates(),
      controller.signal,
    );

    await vi.advanceTimersByTimeAsync(INTERVAL + 1000);
    expect(spy.sleepUntil).not.toHaveBeenCalled();
    expect(mocks.runSession).toHaveBeenCalledTimes(2);

    controller.abort();
    await vi.advanceTimersByTimeAsync(INTERVAL + 1000);
    await promise;
  });

  it("abort during a session breaks the loop without parsing and without a cycle result", async () => {
    const controller = new AbortController();
    const { store, addTasks } = fakeStore();
    mocks.runSession.mockImplementation(() => {
      controller.abort();
      return Promise.resolve(ok(report("after-abort")));
    });

    const promise = runMonitorLoop(
      buildConfig(),
      store,
      new Waker(),
      spy.reporter,
      noopController(),
      buildGates(),
      controller.signal,
    );
    await vi.advanceTimersByTimeAsync(1);
    await promise;

    expect(mocks.runSession).toHaveBeenCalledTimes(1);
    expect(addTasks).not.toHaveBeenCalled();
    expect(spy.cycleFinished).not.toHaveBeenCalled();
  });

  it("outside active hours reports resumption and wakes up within the window", async () => {
    vi.setSystemTime(new Date("2026-07-01T06:00:00"));
    mocks.runSession.mockResolvedValue(ok(report()));
    const { store } = fakeStore();
    const controller = new AbortController();
    const base = buildConfig();
    const config = buildConfig({
      monitor: {
        ...base.monitor,
        schedule: { startMinute: 480, endMinute: 1080, days: [1, 2, 3, 4, 5] },
      },
    });

    const promise = runMonitorLoop(
      config,
      store,
      new Waker(),
      spy.reporter,
      noopController(),
      buildGates(),
      controller.signal,
    );
    await vi.advanceTimersByTimeAsync(1);
    expect(mocks.runSession).not.toHaveBeenCalled();
    expect(spy.offHours).toHaveBeenCalledWith(new Date("2026-07-01T08:00:00"));

    await vi.advanceTimersByTimeAsync(2 * 60 * 60_000);
    expect(mocks.runSession).toHaveBeenCalledTimes(1);

    controller.abort();
    await vi.advanceTimersByTimeAsync(INTERVAL);
    await promise;
  });

  it("an exception from the cycle ends it with an error, the loop keeps going", async () => {
    mocks.runSession
      .mockRejectedValueOnce(new Error("crash"))
      .mockResolvedValue(ok(report()));
    const { store } = fakeStore();
    const controller = new AbortController();

    const promise = runMonitorLoop(
      buildConfig(),
      store,
      new Waker(),
      spy.reporter,
      noopController(),
      buildGates(),
      controller.signal,
    );
    await vi.advanceTimersByTimeAsync(1);
    expect(spy.cycleFinished).toHaveBeenCalledWith(
      expect.objectContaining({ ok: false, error: "crash" }),
    );

    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(mocks.runSession).toHaveBeenCalledTimes(2);

    controller.abort();
    await vi.advanceTimersByTimeAsync(INTERVAL);
    await promise;
  });

  it("pause during the interval sleep blocks the next cycle until resume", async () => {
    mocks.runSession.mockResolvedValue(ok(report()));
    const { store } = fakeStore();
    const abort = new AbortController();
    const control = noopController();

    const promise = runMonitorLoop(
      buildConfig(),
      store,
      new Waker(),
      spy.reporter,
      control,
      buildGates(),
      abort.signal,
    );
    await vi.advanceTimersByTimeAsync(1);
    expect(mocks.runSession).toHaveBeenCalledTimes(1);

    control.pause();
    await vi.advanceTimersByTimeAsync(3 * INTERVAL);
    expect(mocks.runSession).toHaveBeenCalledTimes(1);
    expect(control.state).toBe("paused");

    control.resume();
    await vi.advanceTimersByTimeAsync(1);
    expect(mocks.runSession).toHaveBeenCalledTimes(2);

    abort.abort();
    await vi.advanceTimersByTimeAsync(INTERVAL);
    await promise;
  });

  it("pause during a session lets it finish and abort releases a paused loop", async () => {
    let finishSession: (result: SessionResult) => void = () => undefined;
    mocks.runSession.mockImplementation(
      () =>
        new Promise<SessionResult>((resolvePromise) => {
          finishSession = resolvePromise;
        }),
    );
    const { store, addTasks } = fakeStore();
    const abort = new AbortController();
    const control = noopController();

    const promise = runMonitorLoop(
      buildConfig(),
      store,
      new Waker(),
      spy.reporter,
      control,
      buildGates(),
      abort.signal,
    );
    await vi.advanceTimersByTimeAsync(1);
    expect(mocks.runSession).toHaveBeenCalledTimes(1);

    control.pause();
    expect(control.state).toBe("pausing");

    finishSession(ok(report("late-1")));
    await vi.advanceTimersByTimeAsync(1);
    expect(addTasks).toHaveBeenCalledTimes(1);
    expect(control.state).toBe("paused");

    abort.abort();
    await vi.advanceTimersByTimeAsync(INTERVAL);
    await promise;
    expect(mocks.runSession).toHaveBeenCalledTimes(1);
  });

  it("a pause requested while the session is being prepared starts no session and announces no cycle", async () => {
    let finishWrite: (path: string) => void = () => undefined;
    mocks.writeMcpConfig.mockImplementationOnce(
      () =>
        new Promise<string>((resolvePromise) => {
          finishWrite = resolvePromise;
        }),
    );
    mocks.runSession.mockResolvedValue(ok(report()));
    const { store } = fakeStore();
    const abort = new AbortController();
    const control = noopController();

    const promise = runMonitorLoop(
      buildConfig(),
      store,
      new Waker(),
      spy.reporter,
      control,
      buildGates(),
      abort.signal,
    );
    await vi.advanceTimersByTimeAsync(1);
    expect(mocks.writeMcpConfig).toHaveBeenCalledTimes(1);

    control.pause();
    finishWrite(join("data", "mcp", "monitor.json"));
    await vi.advanceTimersByTimeAsync(1);

    expect(mocks.runSession).not.toHaveBeenCalled();
    expect(spy.cycleStarted).not.toHaveBeenCalled();
    expect(spy.cycleFinished).not.toHaveBeenCalled();
    expect(control.state).toBe("paused");

    control.resume();
    await vi.advanceTimersByTimeAsync(1);
    expect(mocks.runSession).toHaveBeenCalledTimes(1);
    expect(spy.cycleStarted).toHaveBeenCalledWith(1);

    abort.abort();
    await vi.advanceTimersByTimeAsync(INTERVAL);
    await promise;
  });

  it("an abort while the session is being prepared ends the loop without a session", async () => {
    let finishWrite: (path: string) => void = () => undefined;
    mocks.writeMcpConfig.mockImplementationOnce(
      () =>
        new Promise<string>((resolvePromise) => {
          finishWrite = resolvePromise;
        }),
    );
    const { store } = fakeStore();
    const abort = new AbortController();

    const promise = runMonitorLoop(
      buildConfig(),
      store,
      new Waker(),
      spy.reporter,
      noopController(),
      buildGates(),
      abort.signal,
    );
    await vi.advanceTimersByTimeAsync(1);
    abort.abort();
    finishWrite(join("data", "mcp", "monitor.json"));
    await promise;

    expect(mocks.runSession).not.toHaveBeenCalled();
    expect(spy.cycleStarted).not.toHaveBeenCalled();
  });

  it("a prompt that cannot be read still ends a started cycle with the error", async () => {
    mocks.readFile.mockImplementationOnce(() =>
      Promise.reject(new Error("ENOENT: monitor.prompt.md")),
    );
    const { store } = fakeStore();
    const abort = new AbortController();

    const promise = runMonitorLoop(
      buildConfig(),
      store,
      new Waker(),
      spy.reporter,
      noopController(),
      buildGates(),
      abort.signal,
    );
    await vi.advanceTimersByTimeAsync(1);

    expect(spy.cycleStarted).toHaveBeenCalledWith(1);
    expect(spy.cycleFinished).toHaveBeenCalledWith(
      expect.objectContaining({
        cycle: 1,
        ok: false,
        error: "ENOENT: monitor.prompt.md",
      }),
    );
    expect(mocks.runSession).not.toHaveBeenCalled();
    expect(spy.sleepUntil).toHaveBeenCalledTimes(1);

    abort.abort();
    await vi.advanceTimersByTimeAsync(INTERVAL);
    await promise;
  });
});
