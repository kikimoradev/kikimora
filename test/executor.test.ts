import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LOCAL_LEASE, type AdmissionWait } from "../src/admission.js";
import { AgentController } from "../src/control.js";
import { DrainController } from "../src/drain.js";
import type { TaskOutcomeContext, TaskSummarizer } from "../src/memory/summarizer.js";
import type { SessionSpec } from "../src/runner.js";
import { TaskStore } from "../src/tasks.js";
import type { LoopGates } from "../src/gates.js";
import type { SessionResult, Task, TaskResume } from "../src/types.js";
import { UsageLimitGate } from "../src/usage-limit.js";
import { Waker } from "../src/waker.js";
import {
  authFailureResult,
  authGateHarness,
  buildConfig,
  buildGates,
  createExecutorReporterSpy,
  createTempDir,
  createTaskSummarizerSpy,
  externalAdmission,
  heldTicket,
  noopController,
  removeTempDir,
  type ExecutorReporterSpy,
  type TaskSummarizerSpy,
} from "./helpers.js";

const mocks = vi.hoisted(() => ({
  runSession: vi.fn(),
  readFile: vi.fn(),
  rm: vi.fn<(path: string) => Promise<void>>(() => Promise.resolve()),
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
  rm: mocks.rm,
}));

const { runExecutorLoop, composeTaskPrompt, isTransientFailure, attemptCostUsd } =
  await import("../src/executor.js");

class OpenLimitGate extends UsageLimitGate {
  override msRemaining(): number {
    return 0;
  }
}

class NoBackoffController extends AgentController {
  override sleep(): Promise<void> {
    return Promise.resolve();
  }
}

function limitHit(overrides: Partial<SessionResult> = {}): SessionResult {
  return {
    ok: false,
    durationMs: 10,
    failureReason: "isError",
    error: "Session ended with an error (is_error)",
    sessionId: "sess-long",
    rateLimit: { status: "rejected", resetsAt: 1_000, rateLimitType: "five_hour" },
    ...overrides,
  };
}

interface ChainRun {
  result: SessionResult;
  startsAt?: string;
  endsAt?: string;
}

interface ResumeChain {
  store: TaskStore;
  specs: SessionSpec[];
  resumes: (TaskResume | undefined)[];
  costs: (number | undefined)[];
}

function task(id: string): Task {
  return {
    id,
    title: `Task ${id}`,
    description: `Description ${id}`,
    status: "pending",
    attempts: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function scriptedTakes(script: (Task | undefined)[], rest: Task | undefined) {
  const queue = [...script];
  const takeNext = vi.fn(() => Promise.resolve(queue.length > 0 ? queue.shift() : rest));
  const peekNext = (): Task | undefined => {
    if (queue.length === 0) return rest;
    const [head] = queue;
    if (head === undefined) queue.shift();
    return head;
  };
  return { takeNext, peekNext };
}

function ok(): SessionResult {
  return { ok: true, durationMs: 0 };
}

function transientFailure(): SessionResult {
  return {
    ok: false,
    durationMs: 10,
    error: "Session ended with an error (is_error)",
    failureReason: "isError",
    resultText: "API Error: Connection closed mid-response.",
  };
}

interface FakeStore {
  store: TaskStore;
  enqueue: (task: Task) => void;
  takeNext: ReturnType<typeof vi.fn>;
  complete: ReturnType<typeof vi.fn>;
  fail: ReturnType<typeof vi.fn>;
  requeue: ReturnType<typeof vi.fn>;
}

function fakeStore(queue: Task[]): FakeStore {
  const pending = [...queue];
  const takeNext = vi.fn(() => {
    const next = pending.shift();
    return Promise.resolve(next ? { ...next, attempts: next.attempts + 1 } : undefined);
  });
  const complete = vi.fn().mockResolvedValue(undefined);
  const fail = vi.fn().mockResolvedValue(undefined);
  const requeue = vi.fn().mockResolvedValue(undefined);
  return {
    store: {
      takeNext,
      complete,
      fail,
      requeue,
      pendingCount: () => pending.length,
      peekNext: () => pending[0],
    } as unknown as TaskStore,
    enqueue: (queued) => {
      pending.push(queued);
    },
    takeNext,
    complete,
    fail,
    requeue,
  };
}

describe("composeTaskPrompt", () => {
  it("appends the task block to the prompt", () => {
    const prompt = composeTaskPrompt("identity\n", task("redmine-7"));

    expect(prompt).toContain("identity");
    expect(prompt).toContain("## Task to complete");
    expect(prompt).toContain("ID: redmine-7");
    expect(prompt).toContain("Title: Task redmine-7");
    expect(prompt).toContain("Description redmine-7");
  });
});

describe("attemptCostUsd", () => {
  const resume = { sessionId: "sess", limitedAt: "2026-10-22T12:33:58.000Z" };

  it("reports only the part a resumed session added to its running total", () => {
    const resumed: SessionResult = { ...ok(), costUsd: 0.0095128 };

    expect(attemptCostUsd(resumed, { ...resume, costUsd: 0.0058314 })).toBeCloseTo(
      0.0036814,
      10,
    );
    expect(attemptCostUsd({ ...ok(), costUsd: 1 }, { ...resume, costUsd: 2 })).toBe(0);
  });

  it("reports the whole cost without a cost recorded at the limit hit", () => {
    expect(attemptCostUsd({ ...ok(), costUsd: 1.5 }, undefined)).toBe(1.5);
    expect(attemptCostUsd({ ...ok(), costUsd: 1.5 }, resume)).toBe(1.5);
    expect(attemptCostUsd(ok(), { ...resume, costUsd: 2 })).toBeUndefined();
  });
});

describe("runExecutorLoop", () => {
  let spy: ExecutorReporterSpy;
  let summarizerSpy: TaskSummarizerSpy;

  beforeEach(() => {
    vi.clearAllMocks();
    spy = createExecutorReporterSpy();
    summarizerSpy = createTaskSummarizerSpy();
    mocks.readFile.mockImplementation((path: string) =>
      path.endsWith("context.md")
        ? Promise.reject(Object.assign(new Error("ENOENT"), { code: "ENOENT" }))
        : Promise.resolve(path.includes("system") ? "system\n" : "identity\n"),
    );
    mocks.writeMcpConfig.mockImplementation((dataDir: string, input: { role: string }) =>
      Promise.resolve(join(dataDir, "mcp", `${input.role}.json`)),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("drains the queue sequentially and marks tasks as completed", async () => {
    const { store, complete } = fakeStore([task("a"), task("b")]);
    const waker = new Waker();
    const controller = new AbortController();
    let concurrent = 0;
    let maxConcurrent = 0;
    mocks.runSession.mockImplementation(async () => {
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await Promise.resolve();
      concurrent -= 1;
      return ok();
    });

    const promise = runExecutorLoop(
      buildConfig(),
      store,
      waker,
      spy.reporter,
      summarizerSpy.summarizer,
      noopController(),
      buildGates(),
      controller.signal,
    );
    await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(2));

    expect(complete).toHaveBeenNthCalledWith(1, "a", undefined);
    expect(complete).toHaveBeenNthCalledWith(2, "b", undefined);
    expect(maxConcurrent).toBe(1);
    expect(spy.taskStarted).toHaveBeenCalledTimes(2);
    expect(spy.taskFinished).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: "a", ok: true }),
    );
    expect(spy.taskFinished).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: "b", ok: true }),
    );

    controller.abort();
    await promise;
  });

  it("composes the session spec: contract in the system prompt, task in the prompt, session sink", async () => {
    const { store } = fakeStore([task("x")]);
    const controller = new AbortController();
    mocks.runSession.mockResolvedValue(ok());
    const config = buildConfig();
    config.executor = {
      ...config.executor,
      promptPath: "/x/executor.prompt.md",
      systemPromptPath: "/x/executor.system.md",
    };

    const promise = runExecutorLoop(
      config,
      store,
      new Waker(),
      spy.reporter,
      summarizerSpy.summarizer,
      noopController(),
      buildGates(),
      controller.signal,
    );
    await vi.waitFor(() => expect(mocks.runSession).toHaveBeenCalled());
    controller.abort();
    await promise;

    const spec = mocks.runSession.mock.calls[0]?.[0] as {
      model: string;
      effort: string;
      systemPrompt: string;
      prompt: string;
      mcpConfigPath: string;
      jsonSchema?: string;
      events: unknown;
    };
    expect(spec.model).toBe("opus");
    expect(spec.effort).toBe("high");
    expect(spec.systemPrompt).toBe("system\n");
    expect(spec.prompt).toContain("identity");
    expect(spec.prompt).toContain("ID: x");
    expect(spec.mcpConfigPath).toBe(join(config.dataDir, "mcp", "executor.json"));
    expect(spec.jsonSchema).toBeUndefined();
    expect(spec.events).toBe(spy.reporter.session);
    expect(spec.prompt).toBe(composeTaskPrompt("identity\n", task("x")));
  });

  it("puts the context file between the prompt and the task block", async () => {
    const { store } = fakeStore([task("x")]);
    const controller = new AbortController();
    mocks.runSession.mockResolvedValue(ok());
    mocks.readFile.mockImplementation((path: string) =>
      Promise.resolve(
        path.endsWith("context.md") ? "# Workspace context\n" : "identity\n",
      ),
    );
    const config = buildConfig();

    const promise = runExecutorLoop(
      config,
      store,
      new Waker(),
      spy.reporter,
      summarizerSpy.summarizer,
      noopController(),
      buildGates(),
      controller.signal,
    );
    await vi.waitFor(() => expect(mocks.runSession).toHaveBeenCalled());
    controller.abort();
    await promise;

    const spec = mocks.runSession.mock.calls[0]?.[0] as { prompt: string };
    expect(mocks.readFile).toHaveBeenCalledWith(config.contextFilePath, "utf8");
    expect(spec.prompt).toBe(
      composeTaskPrompt("identity\n\n# Workspace context\n", task("x")),
    );
    expect(spec.prompt.indexOf("# Workspace context")).toBeLessThan(
      spec.prompt.indexOf("## Task to complete"),
    );
  });

  it("composes the executor MCP config from the live settings, memory included", async () => {
    const { store } = fakeStore([task("x")]);
    const controller = new AbortController();
    mocks.runSession.mockResolvedValue(ok());
    const config = buildConfig({
      browser: true,
      mcpServers: { linter: { command: "run-linter" } },
    });
    config.executor = { ...config.executor, mcpServers: ["linter"] };

    const promise = runExecutorLoop(
      config,
      store,
      new Waker(),
      spy.reporter,
      summarizerSpy.summarizer,
      noopController(),
      buildGates(),
      controller.signal,
    );
    await vi.waitFor(() => expect(mocks.runSession).toHaveBeenCalled());
    controller.abort();
    await promise;

    expect(mocks.writeMcpConfig).toHaveBeenCalledWith(config.dataDir, {
      role: "executor",
      servers: config.mcpServers,
      selected: ["linter"],
      browser: true,
      memoryDbPath: config.memoryDbPath,
      handoff: { taskId: "x", file: config.handoffFile },
      playwrightOutputDir: config.playwrightOutputDir,
    });
  });

  it("runs a memory summary after a completed task", async () => {
    const { store, complete } = fakeStore([task("a")]);
    const controller = new AbortController();
    const result = { ...ok(), sessionId: "session-a" };
    mocks.runSession.mockResolvedValue(result);

    const promise = runExecutorLoop(
      buildConfig(),
      store,
      new Waker(),
      spy.reporter,
      summarizerSpy.summarizer,
      noopController(),
      buildGates(),
      controller.signal,
    );
    await vi.waitFor(() => expect(summarizerSpy.summarize).toHaveBeenCalled());
    controller.abort();
    await promise;

    expect(complete).toHaveBeenCalledWith("a", undefined);
    expect(summarizerSpy.summarize).toHaveBeenCalledWith(
      expect.objectContaining({ id: "a", attempts: 1 }),
      result,
      { willRetry: false, lease: LOCAL_LEASE },
      controller.signal,
    );
    const finishedOrder = spy.taskFinished.mock.invocationCallOrder[0] ?? Infinity;
    const summarizeOrder =
      summarizerSpy.summarize.mock.invocationCallOrder[0] ?? -Infinity;
    expect(summarizeOrder).toBeGreaterThan(finishedOrder);
  });

  it("runs a summary with retry info after a failed task", async () => {
    const { store } = fakeStore([task("flaky")]);
    const controller = new AbortController();
    const result = { ...transientFailure(), sessionId: "session-f" };
    mocks.runSession.mockResolvedValue(result);

    const promise = runExecutorLoop(
      buildConfig(),
      store,
      new Waker(),
      spy.reporter,
      summarizerSpy.summarizer,
      noopController(),
      buildGates(),
      controller.signal,
    );
    await vi.waitFor(() => expect(summarizerSpy.summarize).toHaveBeenCalled());
    controller.abort();
    await promise;

    expect(summarizerSpy.summarize).toHaveBeenCalledWith(
      expect.objectContaining({ id: "flaky" }),
      result,
      { willRetry: true, lease: LOCAL_LEASE },
      controller.signal,
    );
  });

  it("a throwing summarizer does not change task status and does not break the loop", async () => {
    const { store, complete, fail } = fakeStore([task("a"), task("b")]);
    const controller = new AbortController();
    mocks.runSession.mockResolvedValue(ok());
    summarizerSpy.summarize.mockRejectedValue(new Error("memory failure"));

    const promise = runExecutorLoop(
      buildConfig(),
      store,
      new Waker(),
      spy.reporter,
      summarizerSpy.summarizer,
      noopController(),
      buildGates(),
      controller.signal,
    );
    await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(2));
    controller.abort();
    await promise;

    expect(complete).toHaveBeenNthCalledWith(1, "a", undefined);
    expect(complete).toHaveBeenNthCalledWith(2, "b", undefined);
    expect(fail).not.toHaveBeenCalled();
  });

  it("a failed session marks the task as failed with the error", async () => {
    const { store, complete, fail } = fakeStore([task("bad")]);
    const controller = new AbortController();
    mocks.runSession.mockResolvedValue({
      ok: false,
      durationMs: 10,
      error: "Process exited with code 2",
    } satisfies SessionResult);

    const promise = runExecutorLoop(
      buildConfig(),
      store,
      new Waker(),
      spy.reporter,
      summarizerSpy.summarizer,
      noopController(),
      buildGates(),
      controller.signal,
    );
    await vi.waitFor(() =>
      expect(fail).toHaveBeenCalledWith("bad", "Process exited with code 2", undefined),
    );
    expect(complete).not.toHaveBeenCalled();
    expect(spy.taskFinished).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: "bad",
        ok: false,
        error: "Process exited with code 2",
      }),
    );

    controller.abort();
    await promise;
  });

  it("an exception during a task marks it as failed, the loop keeps going", async () => {
    const { store, fail, complete } = fakeStore([task("crash"), task("good")]);
    const controller = new AbortController();
    mocks.runSession.mockRejectedValueOnce(new Error("boom")).mockResolvedValue(ok());

    const promise = runExecutorLoop(
      buildConfig(),
      store,
      new Waker(),
      spy.reporter,
      summarizerSpy.summarizer,
      noopController(),
      buildGates(),
      controller.signal,
    );
    await vi.waitFor(() => expect(complete).toHaveBeenCalledWith("good", undefined));

    expect(fail).toHaveBeenCalledWith("crash", "boom", undefined);
    expect(spy.taskFinished).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: "crash", ok: false, error: "boom" }),
    );

    controller.abort();
    await promise;
  });

  it("with an empty queue reports waiting and wakes up on notify", async () => {
    const { store, enqueue, takeNext, complete } = fakeStore([]);
    const waker = new Waker();
    const controller = new AbortController();
    mocks.runSession.mockResolvedValue(ok());

    const promise = runExecutorLoop(
      buildConfig(),
      store,
      waker,
      spy.reporter,
      summarizerSpy.summarizer,
      noopController(),
      buildGates(),
      controller.signal,
    );
    await vi.waitFor(() => expect(spy.waiting).toHaveBeenCalledTimes(1));
    expect(takeNext).not.toHaveBeenCalled();
    expect(mocks.runSession).not.toHaveBeenCalled();

    enqueue(task("new"));
    waker.notify();
    await vi.waitFor(() => expect(complete).toHaveBeenCalledWith("new", undefined));

    controller.abort();
    await promise;
  });

  it("abort while waiting ends the loop", async () => {
    const { store, takeNext } = fakeStore([]);
    const controller = new AbortController();

    const promise = runExecutorLoop(
      buildConfig(),
      store,
      new Waker(),
      spy.reporter,
      summarizerSpy.summarizer,
      noopController(),
      buildGates(),
      controller.signal,
    );
    await vi.waitFor(() => expect(spy.waiting).toHaveBeenCalledTimes(1));
    expect(takeNext).not.toHaveBeenCalled();

    controller.abort();
    await promise;

    expect(mocks.runSession).not.toHaveBeenCalled();
    expect(spy.taskStarted).not.toHaveBeenCalled();
  });

  it("abort during a session leaves the task with an unchanged status and no result", async () => {
    const { store, complete, fail } = fakeStore([task("in-flight")]);
    const controller = new AbortController();
    mocks.runSession.mockImplementation(() => {
      controller.abort();
      return Promise.resolve({
        ok: false,
        durationMs: 5,
        error: "Session aborted",
      } satisfies SessionResult);
    });

    const promise = runExecutorLoop(
      buildConfig(),
      store,
      new Waker(),
      spy.reporter,
      summarizerSpy.summarizer,
      noopController(),
      buildGates(),
      controller.signal,
    );
    await promise;

    expect(complete).not.toHaveBeenCalled();
    expect(fail).not.toHaveBeenCalled();
    expect(spy.taskFinished).not.toHaveBeenCalled();
    expect(summarizerSpy.summarize).not.toHaveBeenCalled();
  });

  it("a transient error goes back to the queue and is retried until success", async () => {
    const { takeNext, peekNext } = scriptedTakes(
      [
        { ...task("flaky"), attempts: 1 },
        { ...task("flaky"), attempts: 2 },
      ],
      undefined,
    );
    const complete = vi.fn().mockResolvedValue(undefined);
    const fail = vi.fn().mockResolvedValue(undefined);
    const requeue = vi.fn().mockResolvedValue(undefined);
    const store = { takeNext, peekNext, complete, fail, requeue } as unknown as TaskStore;
    const controller = new AbortController();
    mocks.runSession.mockResolvedValueOnce(transientFailure()).mockResolvedValue(ok());

    const promise = runExecutorLoop(
      buildConfig(),
      store,
      new Waker(),
      spy.reporter,
      summarizerSpy.summarizer,
      noopController(),
      buildGates(),
      controller.signal,
    );
    await vi.waitFor(() => expect(complete).toHaveBeenCalledWith("flaky", undefined));

    expect(requeue).toHaveBeenCalledWith(
      "flaky",
      "Session ended with an error (is_error)",
      undefined,
    );
    expect(fail).not.toHaveBeenCalled();
    expect(spy.taskFinished).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        taskId: "flaky",
        ok: false,
        willRetry: true,
        attempt: 1,
        maxAttempts: 3,
      }),
    );
    expect(spy.taskFinished).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ taskId: "flaky", ok: true }),
    );

    controller.abort();
    await promise;
  });

  it("after attempts are exhausted a transient error marks the task as failed", async () => {
    const { store, fail, requeue } = fakeStore([{ ...task("stubborn"), attempts: 2 }]);
    const controller = new AbortController();
    mocks.runSession.mockResolvedValue(transientFailure());

    const promise = runExecutorLoop(
      buildConfig(),
      store,
      new Waker(),
      spy.reporter,
      summarizerSpy.summarizer,
      noopController(),
      buildGates(),
      controller.signal,
    );
    await vi.waitFor(() =>
      expect(fail).toHaveBeenCalledWith(
        "stubborn",
        "Session ended with an error (is_error)",
        undefined,
      ),
    );

    expect(requeue).not.toHaveBeenCalled();
    expect(spy.taskFinished).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: "stubborn", willRetry: false, attempt: 3 }),
    );

    controller.abort();
    await promise;
  });

  it("a permanent error is not retried", async () => {
    const { store, fail, requeue } = fakeStore([task("permanently-bad")]);
    const controller = new AbortController();
    mocks.runSession.mockResolvedValue({
      ok: false,
      durationMs: 10,
      error: "Process exited with code 2",
      failureReason: "exit",
    } satisfies SessionResult);

    const promise = runExecutorLoop(
      buildConfig(),
      store,
      new Waker(),
      spy.reporter,
      summarizerSpy.summarizer,
      noopController(),
      buildGates(),
      controller.signal,
    );
    await vi.waitFor(() =>
      expect(fail).toHaveBeenCalledWith(
        "permanently-bad",
        "Process exited with code 2",
        undefined,
      ),
    );

    expect(requeue).not.toHaveBeenCalled();

    controller.abort();
    await promise;
  });

  it("reports backoff before retrying and waits the given time", async () => {
    vi.useFakeTimers();
    const { takeNext, peekNext } = scriptedTakes(
      [{ ...task("flaky"), attempts: 1 }],
      undefined,
    );
    const requeue = vi.fn().mockResolvedValue(undefined);
    const store = {
      takeNext,
      peekNext,
      requeue,
      complete: vi.fn(),
      fail: vi.fn(),
    } as unknown as TaskStore;
    const controller = new AbortController();
    mocks.runSession.mockResolvedValue(transientFailure());
    const config = buildConfig();
    config.executor = { ...config.executor, retryDelayMs: 5_000 };

    const promise = runExecutorLoop(
      config,
      store,
      new Waker(),
      spy.reporter,
      summarizerSpy.summarizer,
      noopController(),
      buildGates(),
      controller.signal,
    );
    await vi.advanceTimersByTimeAsync(1);

    expect(spy.retryScheduled).toHaveBeenCalledWith(
      expect.objectContaining({ id: "flaky" }),
      expect.any(Date),
    );
    expect(takeNext).toHaveBeenCalledTimes(1);

    expect(spy.waiting).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5_000);
    expect(takeNext).toHaveBeenCalledTimes(1);
    expect(spy.waiting).toHaveBeenCalledTimes(1);

    controller.abort();
    await promise;
  });

  it("a launcher refusal returns the task without using an attempt and retries it after the backoff", async () => {
    vi.useFakeTimers();
    const { takeNext, peekNext } = scriptedTakes(
      [
        { ...task("unplaced"), attempts: 1 },
        { ...task("unplaced"), attempts: 1 },
      ],
      undefined,
    );
    const release = vi.fn().mockResolvedValue(undefined);
    const complete = vi.fn().mockResolvedValue(undefined);
    const fail = vi.fn().mockResolvedValue(undefined);
    const requeue = vi.fn().mockResolvedValue(undefined);
    const store = {
      takeNext,
      peekNext,
      release,
      complete,
      fail,
      requeue,
    } as unknown as TaskStore;
    const controller = new AbortController();
    mocks.runSession
      .mockResolvedValueOnce({
        ok: false,
        durationMs: 30_000,
        failureReason: "launcherRefused",
        error: "Session launcher refused the session (exit code 75)",
      } satisfies SessionResult)
      .mockResolvedValue(ok());

    const promise = runExecutorLoop(
      buildConfig(),
      store,
      new Waker(),
      spy.reporter,
      summarizerSpy.summarizer,
      noopController(),
      buildGates(),
      controller.signal,
    );
    await vi.advanceTimersByTimeAsync(1);

    expect(release).toHaveBeenCalledWith(
      "unplaced",
      "session launcher refused the session",
    );
    expect(fail).not.toHaveBeenCalled();
    expect(requeue).not.toHaveBeenCalled();
    expect(summarizerSpy.summarize).not.toHaveBeenCalled();
    expect(spy.taskFinished).toHaveBeenCalledWith({
      taskId: "unplaced",
      title: "Task unplaced",
      ok: false,
      durationMs: 30_000,
      error: "session launcher refused the session, task requeued",
      failureReason: "launcherRefused",
      willRetry: true,
    });
    const [, resumeAt] = spy.retryScheduled.mock.calls[0] as [Task, Date];
    expect(resumeAt.getTime() - Date.now()).toBeGreaterThan(29_000);

    await vi.advanceTimersByTimeAsync(29_000);
    expect(takeNext).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(takeNext).toHaveBeenCalledTimes(2);
    expect(complete).toHaveBeenCalledWith("unplaced", undefined);

    controller.abort();
    await promise;
  });

  it("a session killed by the pool memory limit is retried as a transient failure and says why", async () => {
    const { takeNext, peekNext } = scriptedTakes(
      [
        { ...task("hungry"), attempts: 1 },
        { ...task("hungry"), attempts: 2 },
      ],
      undefined,
    );
    const complete = vi.fn().mockResolvedValue(undefined);
    const fail = vi.fn().mockResolvedValue(undefined);
    const requeue = vi.fn().mockResolvedValue(undefined);
    const store = { takeNext, peekNext, complete, fail, requeue } as unknown as TaskStore;
    const controller = new AbortController();
    mocks.runSession
      .mockResolvedValueOnce({
        ok: false,
        durationMs: 10,
        sessionId: "sess-oom",
        failureReason: "poolMemoryLimit",
        error: "Session killed by the pool memory limit",
      } satisfies SessionResult)
      .mockResolvedValue(ok());

    const promise = runExecutorLoop(
      buildConfig(),
      store,
      new Waker(),
      spy.reporter,
      summarizerSpy.summarizer,
      noopController(),
      buildGates(),
      controller.signal,
    );
    await vi.waitFor(() => expect(complete).toHaveBeenCalledWith("hungry", undefined));

    expect(requeue).toHaveBeenCalledWith(
      "hungry",
      "Session killed by the pool memory limit",
      undefined,
    );
    expect(fail).not.toHaveBeenCalled();
    expect(spy.taskFinished).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        taskId: "hungry",
        ok: false,
        error: "Session killed by the pool memory limit",
        failureReason: "poolMemoryLimit",
        willRetry: true,
        attempt: 1,
        maxAttempts: 3,
        sessionId: "sess-oom",
      }),
    );
    expect(summarizerSpy.summarize).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ id: "hungry" }),
      expect.objectContaining({ failureReason: "poolMemoryLimit" }),
      expect.objectContaining({ willRetry: true }),
      expect.anything(),
    );

    controller.abort();
    await promise;
  });

  it("an auth failure releases the task, skips the summarizer and parks both agents until resume", async () => {
    vi.useFakeTimers();
    const { takeNext, peekNext } = scriptedTakes(
      [
        { ...task("locked"), attempts: 1 },
        { ...task("locked"), attempts: 1 },
      ],
      undefined,
    );
    const release = vi.fn().mockResolvedValue(undefined);
    const complete = vi.fn().mockResolvedValue(undefined);
    const fail = vi.fn().mockResolvedValue(undefined);
    const requeue = vi.fn().mockResolvedValue(undefined);
    const store = {
      takeNext,
      peekNext,
      release,
      complete,
      fail,
      requeue,
    } as unknown as TaskStore;
    const controller = new AbortController();
    const {
      gates,
      controller: executorControl,
      partner: monitorControl,
    } = authGateHarness();
    mocks.runSession
      .mockResolvedValueOnce(
        authFailureResult({
          resultText:
            "Failed to authenticate. API Error: 401 OAuth access token is invalid.",
          apiError: { status: 401, code: "authentication_failed" },
        }),
      )
      .mockResolvedValue(ok());

    const promise = runExecutorLoop(
      buildConfig(),
      store,
      new Waker(),
      spy.reporter,
      summarizerSpy.summarizer,
      executorControl,
      gates,
      controller.signal,
    );
    await vi.advanceTimersByTimeAsync(1);

    expect(release).toHaveBeenCalledWith("locked", "authentication failed");
    expect(fail).not.toHaveBeenCalled();
    expect(requeue).not.toHaveBeenCalled();
    expect(summarizerSpy.summarize).not.toHaveBeenCalled();
    expect(spy.taskFinished).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: "locked",
        ok: false,
        willRetry: true,
        error: "authentication failed — task requeued",
      }),
    );
    expect(spy.authBlocked).toHaveBeenCalledTimes(1);
    expect(spy.usageLimit).not.toHaveBeenCalled();
    expect(executorControl.state).toBe("paused");
    expect(monitorControl.state).toBe("pausing");
    expect(takeNext).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(takeNext).toHaveBeenCalledTimes(1);

    executorControl.resume();
    await vi.advanceTimersByTimeAsync(1);
    expect(gates.auth.blocked).toBeNull();
    expect(takeNext).toHaveBeenCalledTimes(2);
    expect(complete).toHaveBeenCalledWith("locked", undefined);

    controller.abort();
    await promise;
    vi.useRealTimers();
  });

  it("a usage-limit failure releases the task and parks the loop until the reset", async () => {
    vi.useFakeTimers();
    const { takeNext, peekNext } = scriptedTakes(
      [
        { ...task("limited"), attempts: 1 },
        { ...task("limited"), attempts: 1 },
      ],
      undefined,
    );
    const release = vi.fn().mockResolvedValue(undefined);
    const complete = vi.fn().mockResolvedValue(undefined);
    const fail = vi.fn().mockResolvedValue(undefined);
    const requeue = vi.fn().mockResolvedValue(undefined);
    const store = {
      takeNext,
      peekNext,
      release,
      complete,
      fail,
      requeue,
    } as unknown as TaskStore;
    const controller = new AbortController();
    const resetsAt = Math.floor(Date.now() / 1000) + 2;
    mocks.runSession
      .mockResolvedValueOnce({
        ok: false,
        durationMs: 10,
        failureReason: "isError",
        error: "Session ended with an error (is_error)",
        rateLimit: { status: "rejected", resetsAt, rateLimitType: "five_hour" },
      } satisfies SessionResult)
      .mockResolvedValue(ok());

    const promise = runExecutorLoop(
      buildConfig(),
      store,
      new Waker(),
      spy.reporter,
      summarizerSpy.summarizer,
      noopController(),
      buildGates(),
      controller.signal,
    );
    await vi.advanceTimersByTimeAsync(1);

    expect(release).toHaveBeenCalledWith("limited", "usage limit reached");
    expect(fail).not.toHaveBeenCalled();
    expect(requeue).not.toHaveBeenCalled();
    expect(summarizerSpy.summarize).not.toHaveBeenCalled();
    expect(spy.taskFinished).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: "limited",
        ok: false,
        willRetry: true,
        error: "usage limit reached — task requeued",
      }),
    );
    expect(spy.usageLimit).toHaveBeenCalledWith(expect.any(Date));
    expect(takeNext).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(takeNext).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(33_000);
    expect(complete).toHaveBeenCalledWith("limited", undefined);

    controller.abort();
    await promise;
  });

  it("a usage-limit failure suspends the task and resumes its session after the reset", async () => {
    vi.useFakeTimers({ now: new Date("2026-10-22T12:33:58.000Z") });
    const limitedAt = "2026-10-22T12:33:58.000Z";
    const resume = { sessionId: "sess-limited", limitedAt, costUsd: 0.0058314 };
    const { takeNext, peekNext } = scriptedTakes(
      [
        { ...task("limited"), attempts: 1 },
        { ...task("limited"), attempts: 1, resume },
      ],
      undefined,
    );
    const suspend = vi.fn().mockResolvedValue(undefined);
    const release = vi.fn().mockResolvedValue(undefined);
    const complete = vi.fn().mockResolvedValue(undefined);
    const store = {
      takeNext,
      peekNext,
      suspend,
      release,
      complete,
      fail: vi.fn(),
      requeue: vi.fn(),
    } as unknown as TaskStore;
    const controller = new AbortController();
    const resetsAt = Math.floor(Date.now() / 1000) + 2;
    mocks.runSession
      .mockResolvedValueOnce({
        ok: false,
        durationMs: 10,
        failureReason: "isError",
        error: "Session ended with an error (is_error)",
        sessionId: "sess-limited",
        costUsd: 0.0058314,
        numTurns: 3,
        rateLimit: { status: "rejected", resetsAt, rateLimitType: "five_hour" },
      } satisfies SessionResult)
      .mockResolvedValue({
        ...ok(),
        sessionId: "sess-limited",
        costUsd: 0.0095128,
        numTurns: 2,
      });

    const promise = runExecutorLoop(
      buildConfig(),
      store,
      new Waker(),
      spy.reporter,
      summarizerSpy.summarizer,
      noopController(),
      buildGates(),
      controller.signal,
    );
    await vi.advanceTimersByTimeAsync(1);

    expect(suspend).toHaveBeenCalledWith("limited", "usage limit reached", {
      sessionId: "sess-limited",
      limitedAt: expect.stringMatching(/^2026-10-22T12:33:58\.\d{3}Z$/) as unknown,
      costUsd: 0.0058314,
    });
    expect(release).not.toHaveBeenCalled();
    expect(summarizerSpy.summarize).not.toHaveBeenCalled();
    expect(spy.taskFinished).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: "limited",
        willRetry: true,
        error: "usage limit reached — session resumes after the reset",
        sessionId: "sess-limited",
        costUsd: 0.0058314,
        numTurns: 3,
      }),
    );

    await vi.advanceTimersByTimeAsync(63_000);
    expect(complete).toHaveBeenCalledWith("limited", undefined);

    const first = mocks.runSession.mock.calls[0]?.[0] as SessionSpec;
    const resumed = mocks.runSession.mock.calls[1]?.[0] as SessionSpec;
    expect(first.resume).toBeUndefined();
    expect(resumed.resume).toBe("sess-limited");
    expect(resumed.prompt).not.toContain("## Task to complete");
    expect(resumed.prompt).toContain(`stopped this session at ${limitedAt}`);
    expect(resumed.prompt).toContain("waited 1m 02s");
    expect(resumed.prompt).toContain(
      "the pull request, /tmp and other files outside the workspace may have changed during the wait",
    );
    expect(resumed.prompt).toContain("subagents the limit stopped did not finish");
    expect(resumed.prompt).toContain("Re-check the state your next step depends on");
    expect(resumed.prompt).toContain("Continue task limited where you left off.");
    const resumedOutcome = spy.taskFinished.mock.calls[1]?.[0] as {
      ok: boolean;
      costUsd: number;
      numTurns: number;
    };
    expect(resumedOutcome.ok).toBe(true);
    expect(resumedOutcome.costUsd).toBeCloseTo(0.0036814, 10);
    expect(resumedOutcome.numTurns).toBe(2);
    expect(spy.taskStarted).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: "limited", resume }),
    );
    expect(summarizerSpy.summarize).toHaveBeenCalledWith(
      expect.objectContaining({ id: "limited" }),
      expect.objectContaining({ ok: true, sessionId: "sess-limited" }),
      expect.anything(),
      expect.anything(),
    );

    controller.abort();
    await promise;
  });

  it("a usage-limit failure without a session id requeues the task for a fresh session", async () => {
    const { store, enqueue } = fakeStore([]);
    const release = vi.fn().mockResolvedValue(undefined);
    const suspend = vi.fn().mockResolvedValue(undefined);
    Object.assign(store, { release, suspend });
    enqueue(task("limited"));
    const controller = new AbortController();
    mocks.runSession.mockResolvedValueOnce({
      ok: false,
      durationMs: 10,
      failureReason: "isError",
      error: "Session ended with an error (is_error)",
      resultText: "Claude AI usage limit reached",
    } satisfies SessionResult);

    const promise = runExecutorLoop(
      buildConfig(),
      store,
      new Waker(),
      spy.reporter,
      summarizerSpy.summarizer,
      noopController(),
      buildGates(),
      controller.signal,
    );
    await vi.waitFor(() =>
      expect(release).toHaveBeenCalledWith("limited", "usage limit reached"),
    );
    controller.abort();
    await promise;

    expect(suspend).not.toHaveBeenCalled();
  });

  async function runResumeChain(
    runs: ChainRun[],
    harness: { controller: AgentController; gates: LoopGates } = {
      controller: noopController(),
      gates: buildGates({ limit: new OpenLimitGate() }),
    },
  ): Promise<ResumeChain> {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-22T12:00:00.000Z") });
    const dir = await createTempDir();
    mocks.readFile.mockImplementationOnce(() =>
      Promise.reject(Object.assign(new Error("ENOENT"), { code: "ENOENT" })),
    );
    const store = await TaskStore.open(join(dir, "tasks.json"));
    await store.addTasks([
      { id: "long", title: "Task long", description: "Description long" },
    ]);
    const script = [...runs];
    const resumes: (TaskResume | undefined)[] = [];
    let current: ChainRun | undefined;
    spy.taskStarted.mockImplementation(() => {
      current = script.shift();
      if (current?.startsAt !== undefined) vi.setSystemTime(new Date(current.startsAt));
    });
    mocks.runSession.mockImplementation((): Promise<SessionResult> => {
      resumes.push(store.list()[0]?.resume);
      if (current === undefined) throw new Error("no session left in the script");
      if (current.endsAt !== undefined) vi.setSystemTime(new Date(current.endsAt));
      return Promise.resolve(current.result);
    });
    const abort = new AbortController();

    const promise = runExecutorLoop(
      buildConfig(),
      store,
      new Waker(),
      spy.reporter,
      summarizerSpy.summarizer,
      harness.controller,
      harness.gates,
      abort.signal,
    );
    await vi.waitFor(() => expect(store.list()[0]?.status).toBe("done"));
    abort.abort();
    await promise;
    await removeTempDir(dir);

    return {
      store,
      specs: mocks.runSession.mock.calls.map(([spec]) => spec as SessionSpec),
      resumes,
      costs: spy.taskFinished.mock.calls.map(
        ([outcome]) => (outcome as { costUsd?: number }).costUsd,
      ),
    };
  }

  it("a resumed session that hits the limit again keeps its running total as the cost baseline", async () => {
    const { store, resumes, costs } = await runResumeChain([
      { result: limitHit({ costUsd: 32.37 }) },
      { result: limitHit({ costUsd: 40 }) },
      { result: { ...ok(), sessionId: "sess-long", costUsd: 41.5 } },
    ]);

    expect(resumes.map((resume) => resume?.costUsd)).toEqual([undefined, 32.37, 40]);
    expect(costs).toHaveLength(3);
    expect(costs[0]).toBe(32.37);
    expect(costs[1]).toBeCloseTo(7.63, 10);
    expect(costs[2]).toBeCloseTo(1.5, 10);
    expect(store.list()[0]).toEqual(
      expect.objectContaining({ status: "done", attempts: 1, resume: undefined }),
    );
  });

  it("an authentication failure of a resumed run moves the cost baseline to the run's running total", async () => {
    const harness = authGateHarness();
    spy.authBlocked.mockImplementation(() => {
      harness.controller.resume();
    });

    const { resumes, costs } = await runResumeChain(
      [
        { result: limitHit({ costUsd: 32.37 }) },
        { result: authFailureResult({ sessionId: "sess-long", costUsd: 36 }) },
        { result: { ...ok(), sessionId: "sess-long", costUsd: 41.5 } },
      ],
      {
        controller: harness.controller,
        gates: { ...harness.gates, limit: new OpenLimitGate() },
      },
    );

    expect(spy.authBlocked).toHaveBeenCalledTimes(1);
    expect(resumes.map((resume) => resume?.costUsd)).toEqual([undefined, 32.37, 36]);
    expect(resumes[2]).toEqual({ ...resumes[1], costUsd: 36 });
    expect(costs[0]).toBe(32.37);
    expect(costs[1]).toBeCloseTo(3.63, 10);
    expect(costs[2]).toBeCloseTo(5.5, 10);
  });

  it("a limit hit that reports no cost keeps the cost baseline of the earlier hit", async () => {
    const { resumes, costs } = await runResumeChain([
      { result: limitHit({ costUsd: 32.37 }) },
      { result: limitHit() },
      { result: { ...ok(), sessionId: "sess-long", costUsd: 41.5 } },
    ]);

    expect(resumes.map((resume) => resume?.costUsd)).toEqual([undefined, 32.37, 32.37]);
    expect(costs[0]).toBe(32.37);
    expect(costs[1]).toBeUndefined();
    expect(costs[2]).toBeCloseTo(9.13, 10);
  });

  it("a resumed run the limit stops again before it does any work keeps the original stop time", async () => {
    const { specs, resumes, costs } = await runResumeChain([
      { endsAt: "2026-10-22T12:00:00.000Z", result: limitHit({ costUsd: 32.37 }) },
      {
        startsAt: "2026-10-22T17:01:00.000Z",
        endsAt: "2026-10-22T17:01:05.000Z",
        result: limitHit({ costUsd: 32.37 }),
      },
      {
        startsAt: "2026-10-22T17:17:00.000Z",
        endsAt: "2026-10-22T19:00:00.000Z",
        result: limitHit({ costUsd: 40 }),
      },
      {
        startsAt: "2026-10-22T20:01:00.000Z",
        result: { ...ok(), sessionId: "sess-long", costUsd: 41.5 },
      },
    ]);

    expect(resumes.map((resume) => resume?.limitedAt)).toEqual([
      undefined,
      "2026-10-22T12:00:00.000Z",
      "2026-10-22T12:00:00.000Z",
      "2026-10-22T19:00:00.000Z",
    ]);
    expect(specs[2]?.prompt).toContain(
      "stopped this session at 2026-10-22T12:00:00.000Z. Kikimora waited 5h 17m",
    );
    expect(specs[3]?.prompt).toContain(
      "stopped this session at 2026-10-22T19:00:00.000Z. Kikimora waited 1h 01m",
    );
    expect(costs[1]).toBe(0);
    expect(costs[2]).toBeCloseTo(7.63, 10);
  });

  it("a re-hit right after a limit hit that reported no cost keeps the original stop time", async () => {
    const { specs, resumes } = await runResumeChain([
      { endsAt: "2026-10-22T12:00:00.000Z", result: limitHit() },
      {
        startsAt: "2026-10-22T17:01:00.000Z",
        endsAt: "2026-10-22T17:01:05.000Z",
        result: limitHit({ costUsd: 32.37 }),
      },
      {
        startsAt: "2026-10-22T17:17:00.000Z",
        result: { ...ok(), sessionId: "sess-long", costUsd: 41.5 },
      },
    ]);

    expect(resumes.map((resume) => resume?.limitedAt)).toEqual([
      undefined,
      "2026-10-22T12:00:00.000Z",
      "2026-10-22T12:00:00.000Z",
    ]);
    expect(specs[2]?.prompt).toContain(
      "stopped this session at 2026-10-22T12:00:00.000Z. Kikimora waited 5h 17m",
    );
  });

  it("a resumed run that called tools before the limit stopped it again names its own stop, even without a cost", async () => {
    const { specs, resumes } = await runResumeChain([
      { endsAt: "2026-10-22T12:00:00.000Z", result: limitHit({ costUsd: 32.37 }) },
      {
        startsAt: "2026-10-22T17:17:00.000Z",
        endsAt: "2026-10-22T18:30:00.000Z",
        result: limitHit({ toolUses: 14 }),
      },
      {
        startsAt: "2026-10-22T23:31:00.000Z",
        result: { ...ok(), sessionId: "sess-long", costUsd: 41.5 },
      },
    ]);

    expect(resumes.map((resume) => resume?.limitedAt)).toEqual([
      undefined,
      "2026-10-22T12:00:00.000Z",
      "2026-10-22T18:30:00.000Z",
    ]);
    expect(specs[2]?.prompt).toContain(
      "stopped this session at 2026-10-22T18:30:00.000Z. Kikimora waited 5h 01m",
    );
  });

  it("a launcher refusal of a resumed run reports the cost it moved into the baseline", async () => {
    const { resumes, costs } = await runResumeChain(
      [
        { result: limitHit({ costUsd: 32.37 }) },
        {
          result: {
            ok: false,
            durationMs: 1,
            failureReason: "launcherRefused",
            costUsd: 33,
          },
        },
        { result: { ...ok(), sessionId: "sess-long", costUsd: 41.5 } },
      ],
      {
        controller: new NoBackoffController(() => undefined),
        gates: buildGates({ limit: new OpenLimitGate() }),
      },
    );

    expect(resumes.map((resume) => resume?.costUsd)).toEqual([undefined, 32.37, 33]);
    expect(costs[0]).toBe(32.37);
    expect(costs[1]).toBeCloseTo(0.63, 10);
    expect(costs[2]).toBeCloseTo(8.5, 10);
  });

  it("a summary that fails after a session could not be resumed still leaves the task to a fresh session", async () => {
    summarizerSpy.summarize.mockRejectedValueOnce(new Error("summarizer crashed"));

    const { store, specs } = await runResumeChain([
      { result: limitHit({ costUsd: 32.37 }) },
      {
        result: {
          ok: false,
          durationMs: 5,
          error: "Session could not be resumed",
          failureReason: "resumeFailed",
          sessionId: "sess-long",
        },
      },
      { result: { ...ok(), sessionId: "fresh-long", costUsd: 5 } },
    ]);

    expect(specs.map((spec) => spec.resume)).toEqual([undefined, "sess-long", undefined]);
    expect(summarizerSpy.summarize).toHaveBeenCalledTimes(2);
    expect(store.list()[0]).toEqual(
      expect.objectContaining({ status: "done", attempts: 1, resume: undefined }),
    );
  });

  it("a session that cannot be resumed requeues the task for a fresh session on a new admission ticket", async () => {
    const dir = await createTempDir();
    mocks.readFile.mockImplementationOnce(() =>
      Promise.reject(Object.assign(new Error("ENOENT"), { code: "ENOENT" })),
    );
    const store = await TaskStore.open(join(dir, "tasks.json"));
    await store.addTasks([
      { id: "stuck", title: "Task stuck", description: "Description stuck" },
      { id: "other", title: "Task other", description: "Description other" },
    ]);
    await store.takeNext();
    await store.suspend("stuck", "usage limit reached", {
      sessionId: "sess-gone",
      limitedAt: "2026-10-22T12:33:58.000Z",
      costUsd: 32.37,
    });
    const admission = externalAdmission();
    spy.admissionWait.mockImplementation((wait: AdmissionWait) => {
      queueMicrotask(() => admission.gate.grant("executor", wait.ticket));
    });
    let interruptedRunSummarized = false;
    let finishSummary: () => void = () => undefined;
    summarizerSpy.summarize.mockReturnValueOnce(
      new Promise<void>((resolveSummary) => {
        finishSummary = () => {
          interruptedRunSummarized = true;
          resolveSummary();
        };
      }),
    );
    const freshSessionStarts: boolean[] = [];
    const placed = new Set<string>();
    mocks.runSession.mockImplementation((spec: SessionSpec): Promise<SessionResult> => {
      if (spec.meta.taskId === "stuck" && spec.resume === undefined) {
        freshSessionStarts.push(interruptedRunSummarized);
      }
      const placement = `${spec.meta.agent}/${spec.placement.lease.ticket ?? ""}`;
      if (placed.has(placement)) {
        return Promise.resolve({
          ok: false,
          durationMs: 1,
          failureReason: "launcherRefused",
        });
      }
      placed.add(placement);
      if (spec.resume === "sess-gone") {
        setTimeout(finishSummary, 50);
        return Promise.resolve({
          ok: false,
          durationMs: 5,
          error: "Session could not be resumed",
          failureReason: "resumeFailed",
          sessionId: "sess-gone",
        });
      }
      return Promise.resolve({ ...ok(), sessionId: `fresh-${spec.meta.taskId ?? ""}` });
    });
    const abort = new AbortController();

    const promise = runExecutorLoop(
      buildConfig(),
      store,
      new Waker(),
      spy.reporter,
      summarizerSpy.summarizer,
      noopController(),
      buildGates({ admission: admission.gate }),
      abort.signal,
    );
    await vi.waitFor(() =>
      expect(store.list().map((queued) => queued.status)).toEqual(["done", "done"]),
    );
    abort.abort();
    await promise;
    await removeTempDir(dir);

    const specs = mocks.runSession.mock.calls.map(([spec]) => spec as SessionSpec);
    expect(specs.map((spec) => [spec.meta.taskId, spec.resume])).toEqual([
      ["stuck", "sess-gone"],
      ["stuck", undefined],
      ["other", undefined],
    ]);
    const tickets = specs.map((spec) => spec.placement.lease.ticket);
    expect(new Set(tickets).size).toBe(3);
    expect(specs[1]?.prompt).toBe(
      composeTaskPrompt("identity\n", { ...task("stuck"), title: "Task stuck" }),
    );
    expect(store.list()).toEqual([
      expect.objectContaining({ id: "stuck", attempts: 1, resume: undefined }),
      expect.objectContaining({ id: "other", attempts: 1 }),
    ]);
    expect(spy.taskFinished.mock.calls.map(([outcome]) => outcome as unknown)).toEqual([
      expect.objectContaining({
        taskId: "stuck",
        ok: false,
        willRetry: true,
        failureReason: "resumeFailed",
        error: "session could not be resumed — task requeued for a fresh session",
        sessionId: "sess-gone",
      }),
      expect.objectContaining({ taskId: "stuck", ok: true, sessionId: "fresh-stuck" }),
      expect.objectContaining({ taskId: "other", ok: true, sessionId: "fresh-other" }),
    ]);
    expect(spy.retryScheduled).not.toHaveBeenCalled();
    expect(summarizerSpy.summarize).toHaveBeenCalledTimes(3);
    const [interruptedTask, interruptedRun, interruptedOutcome] = summarizerSpy.summarize
      .mock.calls[0] as [Task, SessionResult, TaskOutcomeContext];
    expect(interruptedTask).toEqual(
      expect.objectContaining({ id: "stuck", attempts: 1 }),
    );
    expect(interruptedRun).toEqual(
      expect.objectContaining({
        ok: false,
        sessionId: "sess-gone",
        error: "usage limit reached — session could not be resumed",
      }),
    );
    expect(interruptedOutcome.willRetry).toBe(true);
    expect(interruptedOutcome.lease.ticket).toBe(tickets[0]);
    expect(freshSessionStarts).toEqual([true]);
  });

  it("an ordinary failure of a resumed session takes the fresh-session retry", async () => {
    const resume = { sessionId: "sess-limited", limitedAt: "2026-10-22T12:33:58.000Z" };
    const { store, requeue } = fakeStore([{ ...task("r"), resume }]);
    const controller = new AbortController();
    mocks.runSession.mockResolvedValue({
      ...transientFailure(),
      sessionId: "sess-limited",
    });

    const promise = runExecutorLoop(
      buildConfig(),
      store,
      new Waker(),
      spy.reporter,
      summarizerSpy.summarizer,
      noopController(),
      buildGates(),
      controller.signal,
    );
    await vi.waitFor(() =>
      expect(requeue).toHaveBeenCalledWith("r", expect.any(String), undefined),
    );
    controller.abort();
    await promise;

    expect(mocks.runSession).toHaveBeenCalledTimes(1);
  });

  it("pause while idle parks the loop and resume picks up new tasks", async () => {
    const { takeNext, peekNext } = scriptedTakes(
      [undefined, task("after-resume")],
      undefined,
    );
    const complete = vi.fn().mockResolvedValue(undefined);
    const store = {
      takeNext,
      peekNext,
      complete,
      fail: vi.fn(),
      requeue: vi.fn(),
    } as unknown as TaskStore;
    const abort = new AbortController();
    const control = noopController();
    mocks.runSession.mockResolvedValue(ok());

    const promise = runExecutorLoop(
      buildConfig(),
      store,
      new Waker(),
      spy.reporter,
      summarizerSpy.summarizer,
      control,
      buildGates(),
      abort.signal,
    );
    await vi.waitFor(() => expect(spy.waiting).toHaveBeenCalled());

    control.pause();
    await vi.waitFor(() => expect(control.state).toBe("paused"));
    expect(takeNext).not.toHaveBeenCalled();

    control.resume();
    await vi.waitFor(() =>
      expect(complete).toHaveBeenCalledWith("after-resume", undefined),
    );
    expect(takeNext).toHaveBeenCalledTimes(1);

    abort.abort();
    await promise;
  });

  it("pause during a task lets it finish and does not take the next one", async () => {
    let finishSession: (result: SessionResult) => void = () => undefined;
    mocks.runSession.mockImplementation(
      () =>
        new Promise<SessionResult>((resolvePromise) => {
          finishSession = resolvePromise;
        }),
    );
    const { takeNext, peekNext } = scriptedTakes([task("current")], task("next"));
    const complete = vi.fn().mockResolvedValue(undefined);
    const store = {
      takeNext,
      peekNext,
      complete,
      fail: vi.fn(),
      requeue: vi.fn(),
    } as unknown as TaskStore;
    const abort = new AbortController();
    const control = noopController();

    const promise = runExecutorLoop(
      buildConfig(),
      store,
      new Waker(),
      spy.reporter,
      summarizerSpy.summarizer,
      control,
      buildGates(),
      abort.signal,
    );
    await vi.waitFor(() => expect(mocks.runSession).toHaveBeenCalledTimes(1));

    control.pause();
    expect(control.state).toBe("pausing");
    finishSession(ok());

    await vi.waitFor(() => expect(complete).toHaveBeenCalledWith("current", undefined));
    await vi.waitFor(() => expect(control.state).toBe("paused"));
    expect(takeNext).toHaveBeenCalledTimes(1);

    abort.abort();
    await promise;
  });

  describe("with external admission", () => {
    it("claims the task only after its ticket is granted and keeps the slot through the summary", async () => {
      const { store, takeNext, complete } = fakeStore([task("a")]);
      const admission = externalAdmission();
      const abort = new AbortController();
      const statesDuringSummary: string[] = [];
      const summaryLeases: unknown[] = [];
      const summarizer: TaskSummarizer = {
        summarize: (_task, _result, outcome) => {
          statesDuringSummary.push(admission.gate.status().executor.state);
          summaryLeases.push(outcome.lease);
          return Promise.resolve();
        },
      };
      mocks.runSession.mockResolvedValue(ok());

      const promise = runExecutorLoop(
        buildConfig(),
        store,
        new Waker(),
        spy.reporter,
        summarizer,
        noopController(),
        buildGates({ admission: admission.gate }),
        abort.signal,
      );
      await vi.waitFor(() => expect(spy.admissionWait).toHaveBeenCalledTimes(1));
      expect(spy.admissionWait).toHaveBeenCalledWith(
        expect.objectContaining({ ticket: heldTicket(admission.gate, "executor") }),
        expect.objectContaining({ id: "a" }),
      );
      expect(admission.gate.status().executor).toMatchObject({ taskId: "a" });
      expect(takeNext).not.toHaveBeenCalled();

      const ticket = heldTicket(admission.gate, "executor");
      admission.gate.grant("executor", ticket);
      await vi.waitFor(() => expect(spy.waiting).toHaveBeenCalled());

      expect(complete).toHaveBeenCalledWith("a", undefined);
      const spec = mocks.runSession.mock.calls[0]?.[0] as SessionSpec;
      expect(spec.placement.pool).toBe("executor");
      expect(spec.placement.lease.ticket).toBe(ticket);
      expect(summaryLeases).toEqual([spec.placement.lease]);
      expect(statesDuringSummary).toEqual(["holding"]);
      expect(admission.changes.map((change) => change.kind)).toEqual([
        "granted",
        "released",
      ]);

      abort.abort();
      await promise;
    });

    it("gives the slot back before the retry backoff", async () => {
      vi.useFakeTimers();
      const { takeNext, peekNext } = scriptedTakes(
        [{ ...task("flaky"), attempts: 1 }],
        undefined,
      );
      const store = {
        takeNext,
        peekNext,
        requeue: vi.fn().mockResolvedValue(undefined),
        complete: vi.fn(),
        fail: vi.fn(),
      } as unknown as TaskStore;
      const admission = externalAdmission();
      const abort = new AbortController();
      mocks.runSession.mockResolvedValue(transientFailure());
      const config = buildConfig();
      config.executor = { ...config.executor, retryDelayMs: 5_000 };

      const promise = runExecutorLoop(
        config,
        store,
        new Waker(),
        spy.reporter,
        summarizerSpy.summarizer,
        noopController(),
        buildGates({ admission: admission.gate }),
        abort.signal,
      );
      await vi.advanceTimersByTimeAsync(1);
      admission.gate.grant("executor", heldTicket(admission.gate, "executor"));
      await vi.advanceTimersByTimeAsync(1);

      expect(spy.retryScheduled).toHaveBeenCalledTimes(1);
      expect(admission.gate.status().executor.state).toBe("idle");
      expect(admission.changes.map((change) => change.kind)).toEqual([
        "granted",
        "released",
      ]);

      abort.abort();
      await promise;
    });

    it("gives the slot back before the launcher refusal backoff", async () => {
      vi.useFakeTimers();
      const { takeNext, peekNext } = scriptedTakes(
        [{ ...task("unplaced"), attempts: 1 }],
        undefined,
      );
      const store = {
        takeNext,
        peekNext,
        release: vi.fn().mockResolvedValue(undefined),
        complete: vi.fn(),
        fail: vi.fn(),
      } as unknown as TaskStore;
      const admission = externalAdmission();
      const abort = new AbortController();
      mocks.runSession.mockResolvedValue({
        ok: false,
        durationMs: 10,
        failureReason: "launcherRefused",
      } satisfies SessionResult);

      const promise = runExecutorLoop(
        buildConfig(),
        store,
        new Waker(),
        spy.reporter,
        summarizerSpy.summarizer,
        noopController(),
        buildGates({ admission: admission.gate }),
        abort.signal,
      );
      await vi.advanceTimersByTimeAsync(1);
      admission.gate.grant("executor", heldTicket(admission.gate, "executor"));
      await vi.advanceTimersByTimeAsync(1);

      expect(spy.retryScheduled).toHaveBeenCalledTimes(1);
      expect(admission.gate.status().executor.state).toBe("idle");
      expect(admission.changes.map((change) => change.kind)).toEqual([
        "granted",
        "released",
      ]);

      abort.abort();
      await promise;
    });

    it("a pause while waiting leaves the task in the queue", async () => {
      const { store, takeNext } = fakeStore([task("a")]);
      const admission = externalAdmission();
      const abort = new AbortController();
      const control = noopController();

      const promise = runExecutorLoop(
        buildConfig(),
        store,
        new Waker(),
        spy.reporter,
        summarizerSpy.summarizer,
        control,
        buildGates({ admission: admission.gate }),
        abort.signal,
      );
      await vi.waitFor(() => expect(spy.admissionWait).toHaveBeenCalledTimes(1));

      control.pause();
      await vi.waitFor(() => expect(control.state).toBe("paused"));

      expect(takeNext).not.toHaveBeenCalled();
      expect(admission.changes.map((change) => change.kind)).toEqual(["cancelled"]);
      expect(mocks.runSession).not.toHaveBeenCalled();

      abort.abort();
      await promise;
    });

    it("gives the slot back when the queue emptied while it waited", async () => {
      const { takeNext, peekNext } = scriptedTakes([undefined], undefined);
      const store = {
        takeNext,
        peekNext: vi.fn().mockReturnValueOnce(task("gone")).mockImplementation(peekNext),
      } as unknown as TaskStore;
      const admission = externalAdmission();
      const abort = new AbortController();

      const promise = runExecutorLoop(
        buildConfig(),
        store,
        new Waker(),
        spy.reporter,
        summarizerSpy.summarizer,
        noopController(),
        buildGates({ admission: admission.gate }),
        abort.signal,
      );
      await vi.waitFor(() => expect(spy.admissionWait).toHaveBeenCalledTimes(1));
      admission.gate.grant("executor", heldTicket(admission.gate, "executor"));
      await vi.waitFor(() => expect(spy.waiting).toHaveBeenCalled());

      expect(takeNext).toHaveBeenCalledTimes(1);
      expect(admission.changes.map((change) => change.kind)).toEqual([
        "granted",
        "released",
      ]);
      expect(mocks.runSession).not.toHaveBeenCalled();

      abort.abort();
      await promise;
    });

    it("an auth failure noticed while waiting gives the slot back unused", async () => {
      const { store, takeNext } = fakeStore([task("a")]);
      const admission = externalAdmission();
      const abort = new AbortController();
      const gates = buildGates({ admission: admission.gate });

      const promise = runExecutorLoop(
        buildConfig(),
        store,
        new Waker(),
        spy.reporter,
        summarizerSpy.summarizer,
        noopController(),
        gates,
        abort.signal,
      );
      await vi.waitFor(() => expect(spy.admissionWait).toHaveBeenCalledTimes(1));
      gates.auth.engage({ reason: "token revoked" });
      admission.gate.grant("executor", heldTicket(admission.gate, "executor"));
      await vi.waitFor(() => expect(admission.changes).toHaveLength(2));

      expect(takeNext).not.toHaveBeenCalled();
      expect(admission.changes.map((change) => change.kind)).toEqual([
        "granted",
        "released",
      ]);

      abort.abort();
      await promise;
    });
  });
});

describe("runExecutorLoop under a drain", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.readFile.mockResolvedValue("identity\n");
    mocks.writeMcpConfig.mockResolvedValue(join("data", "mcp", "executor.json"));
  });

  it("waits for the memory summary before the executor comes to rest and the worker exits", async () => {
    let finishSession: (result: SessionResult) => void = () => undefined;
    let finishSummary: () => void = () => undefined;
    mocks.runSession.mockImplementation(
      () =>
        new Promise<SessionResult>((resolvePromise) => {
          finishSession = resolvePromise;
        }),
    );
    const summarize = vi.fn(
      () =>
        new Promise<void>((resolvePromise) => {
          finishSummary = resolvePromise;
        }),
    );
    const { takeNext, peekNext } = scriptedTakes([task("current")], task("next"));
    const complete = vi.fn().mockResolvedValue(undefined);
    const store = {
      takeNext,
      peekNext,
      complete,
      fail: vi.fn(),
      requeue: vi.fn(),
    } as unknown as TaskStore;
    const shutdown = new AbortController();
    const executorControl = new AgentController(() => {
      drain.noteSettled();
    });
    const monitorControl = new AgentController(() => undefined, "paused");
    const drainFinished = vi.fn(() => {
      shutdown.abort();
    });
    const drain = new DrainController(
      { monitor: monitorControl, executor: executorControl },
      drainFinished,
    );

    const loop = runExecutorLoop(
      buildConfig(),
      store,
      new Waker(),
      createExecutorReporterSpy().reporter,
      { summarize },
      executorControl,
      buildGates(),
      shutdown.signal,
    );
    await vi.waitFor(() => expect(mocks.runSession).toHaveBeenCalledTimes(1));

    drain.request("drain", undefined);
    finishSession(ok());
    await vi.waitFor(() => expect(summarize).toHaveBeenCalledTimes(1));
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));

    expect(complete).toHaveBeenCalledWith("current", undefined);
    expect(executorControl.state).toBe("pausing");
    expect(drainFinished).not.toHaveBeenCalled();

    finishSummary();
    await loop;

    expect(executorControl.state).toBe("paused");
    expect(drainFinished).toHaveBeenCalledTimes(1);
    expect(drain.settled).toBe(true);
    expect(takeNext).toHaveBeenCalledTimes(1);
  });
});

describe("runExecutorLoop while a session is being prepared", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.readFile.mockResolvedValue("identity\n");
  });

  function pendingMcpWrite(): { finish: () => void } {
    const handle = { finish: (): void => undefined };
    mocks.writeMcpConfig.mockImplementationOnce(
      () =>
        new Promise<string>((resolvePromise) => {
          handle.finish = () => {
            resolvePromise(join("data", "mcp", "executor.json"));
          };
        }),
    );
    return handle;
  }

  function claimingStore() {
    const { takeNext, peekNext } = scriptedTakes(
      [{ ...task("claimed"), attempts: 1 }],
      undefined,
    );
    const release = vi.fn().mockResolvedValue(undefined);
    const fail = vi.fn().mockResolvedValue(undefined);
    const store = { takeNext, peekNext, release, fail } as unknown as TaskStore;
    return { store, takeNext, release, fail };
  }

  it("a drain returns the claimed task to the queue and starts no session", async () => {
    const write = pendingMcpWrite();
    const { store, takeNext, release, fail } = claimingStore();
    const reporter = createExecutorReporterSpy();
    const shutdown = new AbortController();
    const executorControl = new AgentController(() => {
      drain.noteSettled();
    });
    const monitorControl = new AgentController(() => undefined, "paused");
    const drainFinished = vi.fn(() => {
      shutdown.abort();
    });
    const drain = new DrainController(
      { monitor: monitorControl, executor: executorControl },
      drainFinished,
    );

    const loop = runExecutorLoop(
      buildConfig(),
      store,
      new Waker(),
      reporter.reporter,
      createTaskSummarizerSpy().summarizer,
      executorControl,
      buildGates(),
      shutdown.signal,
    );
    await vi.waitFor(() => expect(mocks.writeMcpConfig).toHaveBeenCalledTimes(1));

    drain.request("drain", undefined);
    write.finish();
    await loop;

    expect(release).toHaveBeenCalledWith("claimed");
    expect(fail).not.toHaveBeenCalled();
    expect(mocks.runSession).not.toHaveBeenCalled();
    expect(reporter.taskStarted).not.toHaveBeenCalled();
    expect(reporter.taskFinished).not.toHaveBeenCalled();
    expect(takeNext).toHaveBeenCalledTimes(1);
    expect(drainFinished).toHaveBeenCalledTimes(1);
    expect(drain.settled).toBe(true);
  });

  it("an abort leaves the claimed task alone and starts no session", async () => {
    const write = pendingMcpWrite();
    const { store, release, fail } = claimingStore();
    const reporter = createExecutorReporterSpy();
    const shutdown = new AbortController();

    const loop = runExecutorLoop(
      buildConfig(),
      store,
      new Waker(),
      reporter.reporter,
      createTaskSummarizerSpy().summarizer,
      noopController(),
      buildGates(),
      shutdown.signal,
    );
    await vi.waitFor(() => expect(mocks.writeMcpConfig).toHaveBeenCalledTimes(1));

    shutdown.abort();
    write.finish();
    await loop;

    expect(release).not.toHaveBeenCalled();
    expect(fail).not.toHaveBeenCalled();
    expect(mocks.runSession).not.toHaveBeenCalled();
    expect(reporter.taskStarted).not.toHaveBeenCalled();
  });

  it("a prompt that cannot be read still fails the started task", async () => {
    mocks.writeMcpConfig.mockResolvedValue(join("data", "mcp", "executor.json"));
    mocks.readFile.mockRejectedValueOnce(new Error("ENOENT: executor.prompt.md"));
    const { store, fail, release } = claimingStore();
    const reporter = createExecutorReporterSpy();
    const shutdown = new AbortController();

    const loop = runExecutorLoop(
      buildConfig(),
      store,
      new Waker(),
      reporter.reporter,
      createTaskSummarizerSpy().summarizer,
      noopController(),
      buildGates(),
      shutdown.signal,
    );
    await vi.waitFor(() =>
      expect(fail).toHaveBeenCalledWith(
        "claimed",
        "ENOENT: executor.prompt.md",
        undefined,
      ),
    );

    expect(reporter.taskStarted).toHaveBeenCalledWith(
      expect.objectContaining({ id: "claimed" }),
    );
    expect(reporter.taskFinished).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: "claimed",
        ok: false,
        error: "ENOENT: executor.prompt.md",
      }),
    );
    expect(release).not.toHaveBeenCalled();
    expect(mocks.runSession).not.toHaveBeenCalled();

    shutdown.abort();
    await loop;
  });
});

describe("isTransientFailure", () => {
  it.each(["timeout", "launcherRefused", "poolMemoryLimit"] as const)(
    "a session ended by %s is transient",
    (failureReason) => {
      expect(isTransientFailure({ ok: false, durationMs: 1, failureReason })).toBe(true);
    },
  );

  it("is_error with an API/connection error is transient", () => {
    for (const text of [
      "API Error: Connection closed mid-response.",
      "fetch failed: ECONNRESET",
      "socket hang up",
      "Overloaded, please retry",
      "429 rate limit exceeded",
    ]) {
      expect(
        isTransientFailure({
          ok: false,
          durationMs: 1,
          failureReason: "isError",
          resultText: text,
        }),
      ).toBe(true);
    }
  });

  it("is_error without a network error signature is not transient", () => {
    expect(
      isTransientFailure({
        ok: false,
        durationMs: 1,
        failureReason: "isError",
        resultText: "I cannot complete this task.",
      }),
    ).toBe(false);
  });

  it("other reasons (exit, spawn, abort) are not transient", () => {
    for (const failureReason of ["exit", "spawn", "abort"] as const) {
      expect(isTransientFailure({ ok: false, durationMs: 1, failureReason })).toBe(false);
    }
  });
});

describe("runExecutorLoop with a handoff to a human", () => {
  let spy: ExecutorReporterSpy;
  let summarizerSpy: TaskSummarizerSpy;
  let files: Map<string, string>;
  const config = buildConfig();
  const handoffFile = config.handoffFile;
  const markedAt = "2026-10-30T12:00:00.000Z";

  const mark = (taskId: string, reason: string): void => {
    files.set(handoffFile, JSON.stringify({ taskId, reason, markedAt }));
  };

  const enoent = (): Promise<never> =>
    Promise.reject(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));

  beforeEach(() => {
    vi.clearAllMocks();
    spy = createExecutorReporterSpy();
    summarizerSpy = createTaskSummarizerSpy();
    files = new Map();
    mocks.readFile.mockImplementation((path: string) => {
      if (path === handoffFile) {
        const content = files.get(path);
        return content === undefined ? enoent() : Promise.resolve(content);
      }
      if (path.endsWith("context.md")) return enoent();
      return Promise.resolve("identity\n");
    });
    mocks.rm.mockImplementation((path: string) => {
      files.delete(path);
      return Promise.resolve();
    });
    mocks.writeMcpConfig.mockImplementation((dataDir: string, input: { role: string }) =>
      Promise.resolve(join(dataDir, "mcp", `${input.role}.json`)),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const start = (store: TaskStore, signal: AbortSignal): Promise<void> =>
    runExecutorLoop(
      config,
      store,
      new Waker(),
      spy.reporter,
      summarizerSpy.summarizer,
      noopController(),
      buildGates(),
      signal,
    );

  it("carries the mark of a successful session into the store, task.finished and the summary, then removes it", async () => {
    const { store, complete } = fakeStore([task("handoff-1")]);
    const controller = new AbortController();
    let markSeenAtStart = true;
    mocks.runSession.mockImplementation(() => {
      markSeenAtStart = files.has(handoffFile);
      mark("handoff-1", "Needs the owner's approval of the budget");
      return Promise.resolve({ ...ok(), sessionId: "sess-1", costUsd: 0.5, numTurns: 4 });
    });

    const promise = start(store, controller.signal);
    await vi.waitFor(() => expect(summarizerSpy.summarize).toHaveBeenCalled());
    controller.abort();
    await promise;

    const handoff = { reason: "Needs the owner's approval of the budget", markedAt };
    expect(markSeenAtStart).toBe(false);
    expect(mocks.writeMcpConfig).toHaveBeenCalledWith(
      config.dataDir,
      expect.objectContaining({ handoff: { taskId: "handoff-1", file: handoffFile } }),
    );
    expect(complete).toHaveBeenCalledWith("handoff-1", handoff);
    expect(spy.taskFinished).toHaveBeenCalledWith({
      taskId: "handoff-1",
      title: "Task handoff-1",
      ok: true,
      durationMs: 0,
      costUsd: 0.5,
      numTurns: 4,
      sessionId: "sess-1",
      handedOff: true,
      handoffReason: handoff.reason,
    });
    expect(summarizerSpy.summarize).toHaveBeenCalledWith(
      expect.objectContaining({ id: "handoff-1" }),
      expect.anything(),
      expect.objectContaining({ willRetry: false, handoff }),
      expect.anything(),
    );
    expect(files.has(handoffFile)).toBe(false);
  });

  it("clears a stale mark before a fresh session, so an unmarked task looks as before", async () => {
    mark("stale-1", "stale");
    const { store, complete } = fakeStore([task("stale-1")]);
    const controller = new AbortController();
    mocks.runSession.mockResolvedValue({ ...ok(), sessionId: "sess-1" });

    const promise = start(store, controller.signal);
    await vi.waitFor(() => expect(summarizerSpy.summarize).toHaveBeenCalled());
    controller.abort();
    await promise;

    expect(complete).toHaveBeenCalledWith("stale-1", undefined);
    const outcome = spy.taskFinished.mock.calls[0]?.[0] as object;
    expect(outcome).not.toHaveProperty("handedOff");
    expect(outcome).not.toHaveProperty("handoffReason");
    expect(summarizerSpy.summarize).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ handoff: undefined }),
      expect.anything(),
    );
    expect(files.has(handoffFile)).toBe(false);
  });

  it("a failed session keeps its mark and its retry without one drops it", async () => {
    const { takeNext, peekNext } = scriptedTakes(
      [
        { ...task("handoff-3"), attempts: 1 },
        { ...task("handoff-3"), attempts: 2 },
      ],
      undefined,
    );
    const requeue = vi.fn().mockResolvedValue(undefined);
    const complete = vi.fn().mockResolvedValue(undefined);
    const store = {
      takeNext,
      peekNext,
      requeue,
      complete,
      fail: vi.fn(),
    } as unknown as TaskStore;
    const controller = new AbortController();
    mocks.runSession
      .mockImplementationOnce(() => {
        mark("handoff-3", "left for a human");
        return Promise.resolve(transientFailure());
      })
      .mockResolvedValue({ ...ok(), sessionId: "sess-2" });

    const promise = start(store, controller.signal);
    await vi.waitFor(() => expect(complete).toHaveBeenCalled());
    controller.abort();
    await promise;

    expect(requeue).toHaveBeenCalledWith(
      "handoff-3",
      "Session ended with an error (is_error)",
      { reason: "left for a human", markedAt },
    );
    expect(spy.taskFinished).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        ok: false,
        willRetry: true,
        failureReason: "isError",
        handedOff: true,
        handoffReason: "left for a human",
      }),
    );
    expect(complete).toHaveBeenCalledWith("handoff-3", undefined);
    expect(spy.taskFinished.mock.calls[1]?.[0]).not.toHaveProperty("handedOff");
    expect(files.has(handoffFile)).toBe(false);
  });

  it("an exception after a marked session fails the task with its mark", async () => {
    const { store, fail } = fakeStore([task("crash")]);
    const controller = new AbortController();
    mocks.runSession.mockImplementation(() => {
      mark("crash", "left for a human");
      return Promise.resolve({ ...ok(), sessionId: "sess-1" });
    });
    (store as unknown as { complete: ReturnType<typeof vi.fn> }).complete = vi
      .fn()
      .mockRejectedValue(new Error("disk full"));

    const promise = start(store, controller.signal);
    await vi.waitFor(() => expect(fail).toHaveBeenCalled());
    controller.abort();
    await promise;

    expect(fail).toHaveBeenCalledWith("crash", "disk full", {
      reason: "left for a human",
      markedAt,
    });
    expect(spy.taskFinished).toHaveBeenCalledWith(
      expect.objectContaining({ ok: false, error: "disk full", handedOff: true }),
    );
    expect(files.has(handoffFile)).toBe(false);
  });

  it("a mark made before a usage limit survives the wait and travels with the resumed result", async () => {
    vi.useFakeTimers({ now: new Date("2026-10-22T12:33:58.000Z") });
    const resume = { sessionId: "sess-limited", limitedAt: "2026-10-22T12:33:58.000Z" };
    const { takeNext, peekNext } = scriptedTakes(
      [
        { ...task("limited"), attempts: 1 },
        { ...task("limited"), attempts: 1, resume },
      ],
      undefined,
    );
    const suspend = vi.fn().mockResolvedValue(undefined);
    const complete = vi.fn().mockResolvedValue(undefined);
    const store = {
      takeNext,
      peekNext,
      suspend,
      complete,
      release: vi.fn(),
      fail: vi.fn(),
      requeue: vi.fn(),
    } as unknown as TaskStore;
    const controller = new AbortController();
    let markSeenOnResume = false;
    mocks.runSession
      .mockImplementationOnce(() => {
        mark("limited", "Needs the owner's approval of the budget");
        return Promise.resolve(
          limitHit({
            sessionId: "sess-limited",
            rateLimit: {
              status: "rejected",
              resetsAt: Math.floor(Date.now() / 1000) + 2,
              rateLimitType: "five_hour",
            },
          }),
        );
      })
      .mockImplementation(() => {
        markSeenOnResume = files.has(handoffFile);
        return Promise.resolve({ ...ok(), sessionId: "sess-limited" });
      });

    const promise = start(store, controller.signal);
    await vi.advanceTimersByTimeAsync(1);

    expect(suspend).toHaveBeenCalled();
    expect(spy.taskFinished).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ ok: false, willRetry: true, handedOff: true }),
    );
    expect(files.has(handoffFile)).toBe(true);

    await vi.advanceTimersByTimeAsync(63_000);
    expect(complete).toHaveBeenCalledWith("limited", {
      reason: "Needs the owner's approval of the budget",
      markedAt,
    });
    expect(markSeenOnResume).toBe(true);
    expect(spy.taskFinished).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        ok: true,
        handedOff: true,
        handoffReason: "Needs the owner's approval of the budget",
      }),
    );
    expect(files.has(handoffFile)).toBe(false);

    controller.abort();
    await promise;
  });
});
