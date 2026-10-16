import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LOCAL_LEASE } from "../src/admission.js";
import { AgentController } from "../src/control.js";
import { DrainController } from "../src/drain.js";
import type { TaskSummarizer } from "../src/memory/summarizer.js";
import type { SessionSpec } from "../src/runner.js";
import type { TaskStore } from "../src/tasks.js";
import type { SessionResult, Task } from "../src/types.js";
import { Waker } from "../src/waker.js";
import {
  authFailureResult,
  authGateHarness,
  buildConfig,
  buildGates,
  createExecutorReporterSpy,
  createTaskSummarizerSpy,
  externalAdmission,
  heldTicket,
  noopController,
  type ExecutorReporterSpy,
  type TaskSummarizerSpy,
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

const { runExecutorLoop, composeTaskPrompt, isTransientFailure } =
  await import("../src/executor.js");

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

    expect(complete).toHaveBeenNthCalledWith(1, "a");
    expect(complete).toHaveBeenNthCalledWith(2, "b");
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

    expect(complete).toHaveBeenCalledWith("a");
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

    expect(complete).toHaveBeenNthCalledWith(1, "a");
    expect(complete).toHaveBeenNthCalledWith(2, "b");
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
      expect(fail).toHaveBeenCalledWith("bad", "Process exited with code 2"),
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
    await vi.waitFor(() => expect(complete).toHaveBeenCalledWith("good"));

    expect(fail).toHaveBeenCalledWith("crash", "boom");
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
    await vi.waitFor(() => expect(complete).toHaveBeenCalledWith("new"));

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
    await vi.waitFor(() => expect(complete).toHaveBeenCalledWith("flaky"));

    expect(requeue).toHaveBeenCalledWith(
      "flaky",
      "Session ended with an error (is_error)",
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
      expect(fail).toHaveBeenCalledWith("permanently-bad", "Process exited with code 2"),
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
    expect(complete).toHaveBeenCalledWith("unplaced");

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
    await vi.waitFor(() => expect(complete).toHaveBeenCalledWith("hungry"));

    expect(requeue).toHaveBeenCalledWith(
      "hungry",
      "Session killed by the pool memory limit",
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
    expect(complete).toHaveBeenCalledWith("locked");

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
    expect(complete).toHaveBeenCalledWith("limited");

    controller.abort();
    await promise;
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
    await vi.waitFor(() => expect(complete).toHaveBeenCalledWith("after-resume"));
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

    await vi.waitFor(() => expect(complete).toHaveBeenCalledWith("current"));
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

      expect(complete).toHaveBeenCalledWith("a");
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

    expect(complete).toHaveBeenCalledWith("current");
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
      expect(fail).toHaveBeenCalledWith("claimed", "ENOENT: executor.prompt.md"),
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
