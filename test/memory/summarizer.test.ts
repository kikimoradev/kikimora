import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LOCAL_LEASE } from "../../src/admission.js";
import type { LoopGates } from "../../src/gates.js";
import type { SessionSpec } from "../../src/runner.js";
import { NO_LAUNCHER } from "../../src/session-launcher.js";
import type { SessionResult, Task } from "../../src/types.js";
import {
  authFailureResult,
  buildGates,
  buildSummarizerConfig,
  createExecutorReporterSpy,
  createTempDir,
  removeTempDir,
  type ExecutorReporterSpy,
} from "../helpers.js";

const mocks = vi.hoisted(() => ({
  runSession: vi.fn(),
  readFile: vi.fn(),
}));

vi.mock("../../src/runner.js", () => ({ runSession: mocks.runSession }));
vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs/promises")>()),
  readFile: mocks.readFile,
}));

const { SessionSummarizer } = await import("../../src/memory/summarizer.js");
const { MemoryStore } = await import("../../src/memory/store.js");
type MemoryStoreType = import("../../src/memory/store.js").MemoryStore;

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "redmine-1",
    title: "Fix export",
    description: "CSV export returns 500.",
    status: "in_progress",
    attempts: 1,
    createdAt: "2026-07-02T10:00:00.000Z",
    updatedAt: "2026-07-02T10:05:00.000Z",
    ...overrides,
  };
}

function executorResult(overrides: Partial<SessionResult> = {}): SessionResult {
  return {
    ok: true,
    durationMs: 5000,
    sessionId: "executor-session",
    ...overrides,
  };
}

function summarySessionResult(overrides: Partial<SessionResult> = {}): SessionResult {
  return {
    ok: true,
    durationMs: 700,
    costUsd: 0.01,
    sessionId: "summary-session",
    resultText: '```json\n{"headline": "Headline", "summary": "Details."}\n```',
    ...overrides,
  };
}

describe("SessionSummarizer", () => {
  let dir: string;
  let store: MemoryStoreType;
  let spy: ExecutorReporterSpy;
  const logPath = "/logs/executor/2026-07-02/10-00-00-executor-session.log";
  const resolveLogPath = vi.fn();
  let gates: LoopGates;

  function buildSummarizer() {
    return new SessionSummarizer({
      command: "claude",
      launcher: NO_LAUNCHER,
      summarizer: buildSummarizerConfig({ sessionTimeoutMs: 60_000 }),
      streamPartial: false,
      cwd: "/workspace",
      dataDir: dir,
      playwrightOutputDir: join(dir, "playwright"),
      store,
      resolveLogPath,
      reporter: spy.reporter,
      gates,
    });
  }

  beforeEach(async () => {
    dir = await createTempDir();
    store = MemoryStore.open(join(dir, "memory.db"));
    spy = createExecutorReporterSpy();
    gates = buildGates();
    resolveLogPath.mockReset().mockResolvedValue(logPath);
    mocks.readFile.mockReset().mockResolvedValue("summarizer system\n");
    mocks.runSession.mockReset().mockResolvedValue(summarySessionResult());
  });

  afterEach(async () => {
    store.close();
    await removeTempDir(dir);
  });

  it("runs the summarizer session and saves a record to memory", async () => {
    await buildSummarizer().summarize(
      task(),
      executorResult(),
      { willRetry: false, lease: LOCAL_LEASE },
      new AbortController().signal,
    );

    expect(spy.summaryStarted).toHaveBeenCalledOnce();
    expect(resolveLogPath).toHaveBeenCalledWith("executor-session");

    const spec = mocks.runSession.mock.calls[0]?.[0] as SessionSpec;
    expect(spec.launcher).toBe(NO_LAUNCHER);
    expect(spec.placement).toEqual({ pool: "executor", lease: LOCAL_LEASE });
    expect(spec.meta.agent).toBe("summarizer");
    expect(spec.model).toBe("haiku");
    expect(spec.effort).toBe("low");
    expect(spec.systemPrompt).toBe("summarizer system\n");
    expect(spec.prompt).toContain("ID: redmine-1");
    expect(spec.prompt).toContain(logPath);
    expect(spec.sessionTimeoutMs).toBe(60_000);
    expect(spec.mcpConfigPath).toBe(join(dir, "mcp", "summarizer.json"));
    expect(JSON.parse(readFileSync(spec.mcpConfigPath, "utf8"))).toEqual({
      mcpServers: {},
    });
    expect(spec.jsonSchema).toContain('"headline"');
    expect(spec.events).toBe(spy.reporter.session);

    const records = store.get("redmine-1");
    expect(records).toHaveLength(1);
    expect(records[0]?.headline).toBe("Headline");
    expect(records[0]?.summary).toBe("Details.");
    expect(records[0]?.ok).toBe(true);
    expect(records[0]?.sessionId).toBe("executor-session");

    expect(spy.summaryFinished).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: "redmine-1", ok: true, costUsd: 0.01 }),
    );
  });

  it("saves the task failure along with its error", async () => {
    await buildSummarizer().summarize(
      task({ attempts: 2 }),
      executorResult({ ok: false, error: "session timeout" }),
      { willRetry: true, lease: LOCAL_LEASE },
      new AbortController().signal,
    );

    const records = store.get("redmine-1");
    expect(records[0]?.ok).toBe(false);
    expect(records[0]?.error).toBe("session timeout");
    expect(records[0]?.attempt).toBe(2);

    const spec = mocks.runSession.mock.calls[0]?.[0] as { prompt: string };
    expect(spec.prompt).toContain("Retry scheduled: yes");
  });

  it("skips the summary when the executor session has no id", async () => {
    await buildSummarizer().summarize(
      task(),
      executorResult({ sessionId: undefined }),
      { willRetry: false, lease: LOCAL_LEASE },
      new AbortController().signal,
    );

    expect(mocks.runSession).not.toHaveBeenCalled();
    expect(store.get("redmine-1")).toHaveLength(0);
    expect(spy.summaryFinished).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: false,
        error: expect.stringContaining("no log") as unknown,
      }),
    );
  });

  it("skips the summary when the log path cannot be resolved", async () => {
    resolveLogPath.mockResolvedValue(undefined);

    await buildSummarizer().summarize(
      task(),
      executorResult(),
      { willRetry: false, lease: LOCAL_LEASE },
      new AbortController().signal,
    );

    expect(mocks.runSession).not.toHaveBeenCalled();
    expect(spy.summaryFinished).toHaveBeenCalledWith(
      expect.objectContaining({ ok: false }),
    );
  });

  it("reports an error on a broken report and saves nothing", async () => {
    mocks.runSession.mockResolvedValue(
      summarySessionResult({ resultText: "this is not json" }),
    );

    await buildSummarizer().summarize(
      task(),
      executorResult(),
      { willRetry: false, lease: LOCAL_LEASE },
      new AbortController().signal,
    );

    expect(store.get("redmine-1")).toHaveLength(0);
    expect(spy.summaryFinished).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: false,
        error: "invalid summary report",
      }),
    );
  });

  it("reports the error of a failed summarizer session", async () => {
    mocks.runSession.mockResolvedValue(
      summarySessionResult({ ok: false, error: "API Error", resultText: undefined }),
    );

    await buildSummarizer().summarize(
      task(),
      executorResult(),
      { willRetry: false, lease: LOCAL_LEASE },
      new AbortController().signal,
    );

    expect(store.get("redmine-1")).toHaveLength(0);
    expect(spy.summaryFinished).toHaveBeenCalledWith(
      expect.objectContaining({ ok: false, error: "API Error" }),
    );
  });

  it("reports why the summarizer session failed", async () => {
    mocks.runSession.mockResolvedValue(
      summarySessionResult({
        ok: false,
        error: "Session launcher refused the session (exit code 75)",
        resultText: undefined,
        sessionId: undefined,
        failureReason: "launcherRefused",
      }),
    );

    await buildSummarizer().summarize(
      task(),
      executorResult(),
      { willRetry: false, lease: LOCAL_LEASE },
      new AbortController().signal,
    );

    expect(spy.summaryFinished).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: false,
        error: "Session launcher refused the session (exit code 75)",
        failureReason: "launcherRefused",
      }),
    );
    expect(gates.auth.blocked).toBeNull();
  });

  it("a usage-limit failure engages the shared limit gate", async () => {
    mocks.runSession.mockResolvedValue(
      summarySessionResult({
        ok: false,
        error: "Session ended with an error (is_error)",
        resultText: undefined,
        failureReason: "isError",
        rateLimit: { status: "rejected", resetsAt: Math.floor(Date.now() / 1000) + 60 },
      }),
    );

    await buildSummarizer().summarize(
      task(),
      executorResult(),
      { willRetry: false, lease: LOCAL_LEASE },
      new AbortController().signal,
    );

    expect(gates.limit.msRemaining(Date.now())).toBeGreaterThan(0);
    expect(spy.summaryFinished).toHaveBeenCalledWith(
      expect.objectContaining({ ok: false, error: "usage limit reached" }),
    );
  });

  it("an auth failure engages the shared auth gate and saves nothing", async () => {
    mocks.runSession.mockResolvedValue(authFailureResult());

    await buildSummarizer().summarize(
      task(),
      executorResult(),
      { willRetry: false, lease: LOCAL_LEASE },
      new AbortController().signal,
    );

    expect(gates.auth.blocked).toEqual({ reason: "Not logged in · Please run /login" });
    expect(gates.limit.msRemaining(Date.now())).toBe(0);
    expect(spy.summaryFinished).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: false,
        error: "authentication failed — Not logged in · Please run /login",
      }),
    );
    expect(store.get("redmine-1")).toHaveLength(0);
  });

  it("does not propagate exceptions — reports them via the reporter", async () => {
    mocks.runSession.mockRejectedValue(new Error("failure"));

    await expect(
      buildSummarizer().summarize(
        task(),
        executorResult(),
        { willRetry: false, lease: LOCAL_LEASE },
        new AbortController().signal,
      ),
    ).resolves.toBeUndefined();

    expect(spy.summaryFinished).toHaveBeenCalledWith(
      expect.objectContaining({ ok: false, error: "failure" }),
    );
  });

  it("after an abort saves no result and does not report", async () => {
    const controller = new AbortController();
    mocks.runSession.mockImplementation(() => {
      controller.abort();
      return Promise.resolve(summarySessionResult());
    });

    await buildSummarizer().summarize(
      task(),
      executorResult(),
      { willRetry: false, lease: LOCAL_LEASE },
      controller.signal,
    );

    expect(store.get("redmine-1")).toHaveLength(0);
    expect(spy.summaryFinished).not.toHaveBeenCalled();
  });

  it("does nothing with an already aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();

    await buildSummarizer().summarize(
      task(),
      executorResult(),
      { willRetry: false, lease: LOCAL_LEASE },
      controller.signal,
    );

    expect(spy.summaryStarted).not.toHaveBeenCalled();
    expect(mocks.runSession).not.toHaveBeenCalled();
  });
});
