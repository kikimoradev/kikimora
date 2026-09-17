import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { render } from "ink-testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentController } from "../../src/control.js";
import { DrainController } from "../../src/drain.js";
import type { TaskSummaryRecord } from "../../src/memory/store.js";
import { createSettingsController } from "../../src/settings-controller.js";
import { WorkerStatusStore } from "../../src/status.js";
import type { Task } from "../../src/types.js";
import { App, type AppProps } from "../../src/ui/app.js";
import {
  buildConfig,
  createTempDir,
  eventually,
  inputReady,
  makeStdinLossless,
  removeTempDir,
} from "../helpers.js";

const PAGE_UP = "\u001B[5~";
const PAGE_DOWN = "\u001B[6~";
const ARROW_UP = "\u001B[A";
const ARROW_DOWN = "\u001B[B";
const ARROW_LEFT = "\u001B[D";
const ESCAPE = "\u001B";
const BACKSPACE = "\u007F";
const CTRL_C = "\u0003";
const CTRL_D = "\u0004";
const ENTER = "\r";

async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

async function flushed(store: WorkerStatusStore): Promise<void> {
  store.flush();
  await tick();
}

function buildTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "t-1",
    title: "Clean up repo",
    description: "Description",
    status: "pending",
    attempts: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function buildRecord(overrides: Partial<TaskSummaryRecord> = {}): TaskSummaryRecord {
  return {
    id: 1,
    taskId: "t-1",
    attempt: 1,
    ok: true,
    title: "Clean up repo",
    headline: "Cleaned the repository",
    summary: "Removed stale branches.",
    error: undefined,
    sessionId: undefined,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function fakeSettingsController() {
  return {
    current: vi.fn().mockResolvedValue({}),
    patch: vi.fn().mockResolvedValue({}),
    setModel: vi.fn().mockResolvedValue(undefined),
    setEffort: vi.fn().mockResolvedValue(undefined),
    setIntervalMinutes: vi.fn().mockResolvedValue(undefined),
    setActiveHours: vi.fn().mockResolvedValue(undefined),
    setActiveDays: vi.fn().mockResolvedValue(undefined),
  };
}

function fakePromptAccess() {
  return {
    read: vi.fn().mockResolvedValue("watch the pipelines"),
    write: vi.fn().mockResolvedValue(undefined),
  };
}

function fakeContextAccess() {
  return {
    read: vi.fn().mockResolvedValue("the acme-shop workspace"),
    write: vi.fn().mockResolvedValue(undefined),
  };
}

interface Harness {
  store: WorkerStatusStore;
  props: AppProps;
  monitorControl: AgentController;
  executorControl: AgentController;
  drain: DrainController;
  retry: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
  addTasks: ReturnType<typeof vi.fn>;
  recent: ReturnType<typeof vi.fn>;
  search: ReturnType<typeof vi.fn>;
  settings: ReturnType<typeof fakeSettingsController>;
  prompts: ReturnType<typeof fakePromptAccess>;
  context: ReturnType<typeof fakeContextAccess>;
  notify: ReturnType<typeof vi.fn>;
  requestExit: ReturnType<typeof vi.fn>;
}

function buildHarness(initialControlState: "running" | "paused" = "running"): Harness {
  const store = new WorkerStatusStore({ notifyDelayMs: 0 });
  const monitorControl = new AgentController((state) => {
    store.setControl("monitor", state);
  }, initialControlState);
  const executorControl = new AgentController((state) => {
    store.setControl("executor", state);
  }, initialControlState);
  store.setControl("monitor", initialControlState);
  store.setControl("executor", initialControlState);
  store.flush();
  const drain = new DrainController(
    { monitor: monitorControl, executor: executorControl },
    () => undefined,
    (snapshot) => {
      store.drainRequested(snapshot);
    },
  );
  const retry = vi.fn().mockResolvedValue(true);
  const cancel = vi.fn().mockResolvedValue(true);
  const addTasks = vi
    .fn()
    .mockImplementation((tasks: unknown[]) => Promise.resolve(tasks));
  const list = vi.fn().mockReturnValue([]);
  const recent = vi.fn().mockReturnValue([buildRecord()]);
  const search = vi.fn().mockReturnValue([buildRecord({ id: 2, taskId: "t-2" })]);
  const settings = fakeSettingsController();
  const prompts = fakePromptAccess();
  const context = fakeContextAccess();
  const notify = vi.fn();
  const requestExit = vi.fn();
  return {
    store,
    monitorControl,
    executorControl,
    drain,
    retry,
    cancel,
    addTasks,
    recent,
    search,
    settings,
    prompts,
    context,
    notify,
    requestExit,
    props: {
      store,
      config: buildConfig({ cwd: "/tmp/ws" }),
      version: "1.2.3",
      controls: { monitor: monitorControl, executor: executorControl },
      drain,
      tasks: { list, retry, cancel, addTasks },
      memory: { recent, search },
      settings,
      prompts,
      context,
      waker: { notify },
      requestExit,
    },
  };
}

async function renderApp(props: AppProps) {
  const rendered = render(<App {...props} />);
  makeStdinLossless(rendered.stdin);
  await inputReady(rendered.stdin);
  return rendered;
}

async function type(
  stdin: { write: (data: string) => void },
  text: string,
): Promise<void> {
  stdin.write(text);
  await tick();
}

async function submit(
  stdin: { write: (data: string) => void },
  line: string,
): Promise<void> {
  await type(stdin, line);
  await type(stdin, ENTER);
}

async function openEditor(
  rendered: Awaited<ReturnType<typeof renderApp>>,
  props: AppProps,
  command: string,
  titleFragment: string,
): Promise<void> {
  await submit(rendered.stdin, command);
  await eventually(() => {
    expect(rendered.lastFrame()).toContain(titleFragment);
  });
  rendered.rerender(<App {...props} />);
  await tick();
}

describe("App", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows the brand, version, cwd and agent parameters in the header", async () => {
    const { store, props } = buildHarness();
    const { lastFrame, unmount } = await renderApp(props);

    const frame = lastFrame() ?? "";
    expect(frame).toContain("🧌 Brownie v1.2.3");
    expect(frame).toContain("/tmp/ws");
    expect(frame).toContain("monitor");
    expect(frame).toContain("haiku · medium · every 5 min");
    expect(frame).toContain("executor");
    expect(frame).toContain("opus · high");

    unmount();
    store.dispose();
  });

  it("shows the header stats line with task counts", async () => {
    const { store, props } = buildHarness();
    const { lastFrame, unmount } = await renderApp(props);

    store.monitor.cycleFinished({
      cycle: 1,
      ok: true,
      durationMs: 100,
      costUsd: 0.5,
      addedTasks: 0,
      skippedDuplicates: 0,
    });
    store.executor.taskFinished({
      taskId: "t-1",
      title: "Title",
      ok: true,
      durationMs: 100,
      costUsd: 0.25,
    });
    store.setTasks([buildTask(), buildTask({ id: "t-2", status: "done" })]);
    await flushed(store);

    await eventually(() => {
      expect(lastFrame()).toContain("$0.75");
    });
    const frame = lastFrame() ?? "";
    expect(frame).toContain("↑");
    expect(frame).toContain("1 cycles");
    expect(frame).toContain("tasks 1 pending / 0 running / 1 done / 0 failed");

    unmount();
    store.dispose();
  });

  it("shows the phases: monitor starting and executor waiting", async () => {
    const { store, props } = buildHarness();
    const { lastFrame, unmount } = await renderApp(props);

    const frame = lastFrame() ?? "";
    expect(frame).toContain("starting…");
    expect(frame).toContain("waiting for tasks");

    unmount();
    store.dispose();
  });

  it("shows the auth block with its reason instead of the pause label", async () => {
    const { store, props } = buildHarness();
    const { lastFrame, unmount } = await renderApp(props);

    store.executor.authBlocked({ reason: "Not logged in · Please run /login" });
    store.setControl("executor", "paused");
    await flushed(store);

    const frame = lastFrame() ?? "";
    expect(frame).toContain("authentication failed");
    expect(frame).toContain("Not logged in");
    expect(frame).not.toContain("⏸ paused");

    unmount();
    store.dispose();
  });

  it("after reporter events shows the cycle, session tail and outcome", async () => {
    const { store, props } = buildHarness();
    const { lastFrame, unmount } = await renderApp(props);

    store.monitor.cycleStarted(2);
    store.monitor.session({
      type: "init",
      model: "sonnet",
      sessionId: "s-1",
      toolCount: 4,
    });
    store.monitor.session({ type: "text", text: "Checking backlog" });
    store.monitor.session({ type: "toolUse", name: "Bash", input: "git log" });
    store.monitor.session({
      type: "toolResult",
      isError: false,
      lines: ["3 commits", "abc123 fix", "def456 feat"],
      dropped: 0,
    });
    store.monitor.session({
      type: "toolResult",
      isError: true,
      lines: ["boom"],
      dropped: 0,
    });
    store.monitor.session({ type: "killing", reason: "timeout" });
    store.monitor.cycleFinished({
      cycle: 2,
      ok: true,
      durationMs: 1_200,
      addedTasks: 1,
      skippedDuplicates: 0,
    });
    await flushed(store);

    await eventually(() => {
      expect(lastFrame()).toContain("cycle #2");
    });
    const frame = lastFrame() ?? "";
    expect(frame).toContain("model sonnet · 4 tools · s-1");
    expect(frame).toContain("⏺ Checking backlog");
    expect(frame).toContain("⏺ Bash(git log)");
    expect(frame).toContain("⎿ 3 commits … +2 lines");
    expect(frame).toContain("⎿ error: boom");
    expect(frame).toContain("⏹ stopping session (timeout)…");
    expect(frame).toContain("+1 task");

    unmount();
    store.dispose();
  });

  it("shows the task table with counters and the failed task error", async () => {
    const { store, props } = buildHarness();
    const { lastFrame, stdin, unmount } = await renderApp(props);

    store.setTasks([
      buildTask(),
      buildTask({ id: "t-2", title: "Deploy changes", status: "in_progress" }),
      buildTask({ id: "t-3", title: "Build report", status: "done" }),
      buildTask({ id: "t-4", title: "Fix tests", status: "failed", error: "timeout" }),
      buildTask({ id: "t-5", title: "Old idea", status: "cancelled" }),
    ]);
    await flushed(store);
    await submit(stdin, "/tasks");

    await eventually(() => {
      const frame = lastFrame() ?? "";
      expect(frame).toContain("pending: 1");
      expect(frame).toContain("in progress: 1");
      expect(frame).toContain("done: 1");
      expect(frame).toContain("failed: 1");
      expect(frame).toContain("t-2 · Deploy changes");
      expect(frame).toContain("t-4 · Fix tests — timeout");
      expect(frame).toContain("t-5 · Old idea");
      expect(frame).toContain("cancelled");
    });

    unmount();
    store.dispose();
  });

  it("shows the shutdown message after a signal", async () => {
    const { store, props } = buildHarness();
    const { lastFrame, unmount } = await renderApp(props);

    store.shutdownRequested("SIGINT");
    await flushed(store);

    await eventually(() => {
      expect(lastFrame()).toContain("Received SIGINT — shutting down…");
    });

    unmount();
    store.dispose();
  });

  it("/drain pauses both agents and notes the drain in the header", async () => {
    const { store, props, monitorControl, executorControl, drain } = buildHarness();
    const { lastFrame, stdin, unmount } = await renderApp(props);

    await submit(stdin, "/drain");

    await eventually(() => {
      expect(lastFrame()).toContain("⏏ draining — exits after the current session");
    });
    expect(lastFrame()).not.toContain("at the latest");
    expect(monitorControl.state).toBe("pausing");
    expect(executorControl.state).toBe("pausing");

    unmount();
    drain.dispose();
    store.dispose();
  });

  it("counts down to the drain deadline in the header", async () => {
    vi.useFakeTimers();
    const { store, props } = buildHarness();
    const { lastFrame, unmount } = render(<App {...props} />);

    store.drainRequested({
      since: Date.now(),
      until: Date.now() + 90_000,
      reason: "SIGTERM",
    });
    store.flush();
    await vi.advanceTimersByTimeAsync(100);
    expect(lastFrame()).toContain(
      "⏏ draining — exits after the current session · stops in 01:30 at the latest",
    );

    unmount();
    store.dispose();
  });

  it("counts down to the next cycle every second", async () => {
    vi.useFakeTimers();
    const { store, props } = buildHarness();
    const { lastFrame, unmount } = render(<App {...props} />);

    store.monitor.sleepUntil(new Date(Date.now() + 90_000));
    store.flush();
    await vi.advanceTimersByTimeAsync(100);
    expect(lastFrame()).toContain("next cycle in 01:30");

    await vi.advanceTimersByTimeAsync(10_000);
    expect(lastFrame()).toContain("next cycle in 01:2");

    unmount();
    store.dispose();
  });

  it("warns when a session produces no output for a long time", async () => {
    vi.useFakeTimers();
    const { store, props } = buildHarness();
    const { lastFrame, unmount } = render(<App {...props} />);

    store.monitor.cycleStarted(1);
    store.flush();
    await vi.advanceTimersByTimeAsync(180_000);

    expect(lastFrame()).toContain("⚠ no output");

    unmount();
    store.dispose();
  });

  it("shows backoff with a scheduled retry after a transient error", async () => {
    const { store, props } = buildHarness();
    const { lastFrame, unmount } = await renderApp(props);

    store.executor.taskFinished({
      taskId: "t-1",
      title: "Clean up repo",
      ok: false,
      durationMs: 300,
      error: "Session ended with an error (is_error)",
      willRetry: true,
      attempt: 1,
      maxAttempts: 3,
    });
    store.executor.retryScheduled(buildTask(), new Date(Date.now() + 30_000));
    await flushed(store);

    await eventually(() => {
      expect(lastFrame()).toContain("↻ retrying t-1 in");
    });
    expect(lastFrame()).toContain("↻ t-1 · 0.3s");

    unmount();
    store.dispose();
  });

  it("scrolls the focused panel with page-up and returns to follow mode on escape", async () => {
    const { store, props } = buildHarness();
    const { lastFrame, stdin, unmount } = await renderApp(props);

    for (let i = 1; i <= 60; i += 1) {
      store.monitor.session({ type: "text", text: `line ${i}` });
    }
    await flushed(store);
    await eventually(() => {
      expect(lastFrame()).toContain("line 60");
    });

    await type(stdin, PAGE_UP);
    await eventually(() => {
      expect(lastFrame()).toContain("newer lines");
    });
    expect(lastFrame()).not.toContain("line 60");

    await type(stdin, ESCAPE);
    await eventually(() => {
      expect(lastFrame()).toContain("line 60");
    });
    expect(lastFrame()).not.toContain("newer lines");

    unmount();
    store.dispose();
  });

  it("caps a long tool result and ctrl+o expands it in place", async () => {
    const { store, props } = buildHarness();
    const { lastFrame, stdin, unmount } = await renderApp(props);

    store.monitor.session({
      type: "toolResult",
      isError: false,
      lines: [`${"a".repeat(160)} TAIL_MARKER`, "SECOND_LINE_MARKER"],
      dropped: 1,
    });
    await flushed(store);

    await eventually(() => {
      expect(lastFrame()).toContain(" …");
    });
    const frame = lastFrame() ?? "";
    expect(frame).toContain("⎿");
    expect(frame).not.toContain("TAIL_MARKER");
    expect(frame).not.toContain("SECOND_LINE_MARKER");
    expect(frame).not.toContain("expanded output (ctrl+o)");

    await type(stdin, "\u000F");
    await eventually(() => {
      expect(lastFrame()).toContain("TAIL_MARKER");
    });
    expect(lastFrame()).toContain("SECOND_LINE_MARKER");
    expect(lastFrame()).toContain("+1 line");
    expect(lastFrame()).toContain("expanded output (ctrl+o)");

    await type(stdin, "\u000F");
    await eventually(() => {
      expect(lastFrame()).not.toContain("TAIL_MARKER");
    });

    unmount();
    store.dispose();
  });

  it("wraps a long agent message instead of truncating it", async () => {
    const { store, props } = buildHarness();
    const { lastFrame, unmount } = await renderApp(props);

    store.monitor.session({
      type: "text",
      text: "Connection to Redmine works fine — the query returned status 200 and I am logged in as dawid END_OF_MESSAGE",
    });
    await flushed(store);

    await eventually(() => {
      expect(lastFrame()).toContain("END_OF_MESSAGE");
    });

    unmount();
    store.dispose();
  });

  it("tab with an empty input moves the scroll focus to the executor panel", async () => {
    const { store, props } = buildHarness();
    const { lastFrame, stdin, unmount } = await renderApp(props);

    for (let i = 1; i <= 60; i += 1) {
      store.executor.session({ type: "text", text: `exec ${i}` });
    }
    await flushed(store);
    await eventually(() => {
      expect(lastFrame()).toContain("exec 60");
    });

    await type(stdin, "\t");
    await type(stdin, PAGE_UP);

    await eventually(() => {
      expect(lastFrame()).toContain("newer lines");
    });
    expect(lastFrame()).not.toContain("exec 60");

    await type(stdin, PAGE_DOWN);
    await eventually(() => {
      expect(lastFrame()).toContain("exec 60");
    });

    unmount();
    store.dispose();
  });

  it("ctrl+c triggers the SIGINT shutdown path", async () => {
    const killSpy = vi.spyOn(process, "kill").mockReturnValue(true);
    const { store, props } = buildHarness();
    const { stdin, unmount } = await renderApp(props);

    await type(stdin, CTRL_C);
    await eventually(() => {
      expect(killSpy).toHaveBeenCalledWith(process.pid, "SIGINT");
    });

    unmount();
    store.dispose();
    killSpy.mockRestore();
  });

  it("edits the command line: typing, backspace, cursor moves", async () => {
    const { store, props } = buildHarness();
    const { lastFrame, stdin, unmount } = await renderApp(props);

    await type(stdin, "/mo");
    await eventually(() => {
      expect(lastFrame()).toContain("> /mo");
    });
    expect(lastFrame()).toContain("/monitor");

    await type(stdin, BACKSPACE);
    await eventually(() => {
      expect(lastFrame()).not.toContain("> /mo");
    });
    expect(lastFrame()).toContain("> /m");

    await type(stdin, ARROW_LEFT);
    await type(stdin, "x");
    await eventually(() => {
      expect(lastFrame()).toContain("> /xm");
    });

    await type(stdin, ESCAPE);
    await eventually(() => {
      expect(lastFrame()).not.toContain("> /xm");
    });

    unmount();
    store.dispose();
  });

  it("shows the slash-command menu with summaries and navigates it with the arrows", async () => {
    const { store, props } = buildHarness();
    const { lastFrame, stdin, unmount } = await renderApp(props);

    await type(stdin, "/");
    await eventually(() => {
      expect(lastFrame()).toContain("/dashboard");
    });
    expect(lastFrame()).toContain("show the combined monitor + executor + tasks view");
    expect(lastFrame()).toContain("/executor");

    await type(stdin, "m");
    await eventually(() => {
      expect(lastFrame()).not.toContain("/dashboard");
    });
    expect(lastFrame()).toContain("/monitor");
    expect(lastFrame()).toContain("/memory");

    await type(stdin, ARROW_DOWN);
    await type(stdin, "\t");
    await eventually(() => {
      expect(lastFrame()).toContain("> /memory");
    });

    unmount();
    store.dispose();
  });

  it("tab completes the highlighted command prefix", async () => {
    const { store, props } = buildHarness();
    const { lastFrame, stdin, unmount } = await renderApp(props);

    await type(stdin, "/da");
    await type(stdin, "\t");
    await eventually(() => {
      expect(lastFrame()).toContain("> /dashboard");
    });

    unmount();
    store.dispose();
  });

  it("enter runs the highlighted command even from a shorter prefix", async () => {
    const { store, props } = buildHarness();
    const { lastFrame, stdin, unmount } = await renderApp(props);

    await type(stdin, "/exe");
    await type(stdin, ENTER);
    await eventually(() => {
      expect(lastFrame()).toContain("executor · /help");
    });

    unmount();
    store.dispose();
  });

  it("enter runs the exact command typed, not the first suggestion sharing its prefix", async () => {
    const { store, props } = buildHarness();
    const { lastFrame, stdin, unmount } = await renderApp(props);

    await type(stdin, "/task");
    await type(stdin, ENTER);
    await eventually(() => {
      expect(lastFrame()).toContain("usage: /task <description>");
    });
    expect(lastFrame()).not.toContain("tasks · /help");

    unmount();
    store.dispose();
  });

  it("switches views with slash commands and shows the view name in the hint line", async () => {
    const { store, props } = buildHarness();
    const { lastFrame, stdin, unmount } = await renderApp(props);

    expect(lastFrame()).toContain("dashboard · /help");

    await submit(stdin, "/tasks");
    await eventually(() => {
      expect(lastFrame()).toContain("tasks · /help");
    });
    expect(lastFrame()).toContain("Tasks");
    expect(lastFrame()).not.toContain("Executor");

    await submit(stdin, "/monitor");
    await eventually(() => {
      expect(lastFrame()).toContain("Recent outcomes");
    });
    expect(lastFrame()).toContain("nothing finished yet");

    await submit(stdin, "/help");
    await eventually(() => {
      expect(lastFrame()).toContain("Commands");
    });
    expect(lastFrame()).toContain("/pause [monitor|executor]");
    expect(lastFrame()).toContain("Keys");
    expect(lastFrame()).toContain("expand or collapse tool output");

    await submit(stdin, "/dashboard");
    await eventually(() => {
      expect(lastFrame()).toContain("Executor");
    });

    unmount();
    store.dispose();
  });

  it("recalls history with the arrow keys", async () => {
    const { store, props } = buildHarness();
    const { lastFrame, stdin, unmount } = await renderApp(props);

    await submit(stdin, "/tasks");
    await submit(stdin, "/help");
    await eventually(() => {
      expect(lastFrame()).not.toContain("> /help");
    });

    await type(stdin, ARROW_UP);
    await eventually(() => {
      expect(lastFrame()).toContain("> /help");
    });
    await type(stdin, ARROW_UP);
    await eventually(() => {
      expect(lastFrame()).toContain("> /tasks");
    });
    await type(stdin, ARROW_DOWN);
    await eventually(() => {
      expect(lastFrame()).toContain("> /help");
    });

    unmount();
    store.dispose();
  });

  it("/memory shows recent entries and /memory <query> searches", async () => {
    const { store, props, recent, search } = buildHarness();
    const { lastFrame, stdin, unmount } = await renderApp(props);

    await submit(stdin, "/memory");
    await eventually(() => {
      expect(recent).toHaveBeenCalledWith(20);
    });
    await eventually(() => {
      expect(lastFrame()).toContain("Memory · recent entries");
    });
    expect(lastFrame()).toContain("t-1 · Cleaned the repository");

    await submit(stdin, "/memory deploy");
    await eventually(() => {
      expect(search).toHaveBeenCalledWith("deploy", 20);
    });
    await eventually(() => {
      expect(lastFrame()).toContain('Memory · search "deploy" · 1 results');
    });

    unmount();
    store.dispose();
  });

  it("/pause shows a notice and the pausing state in the header", async () => {
    const { store, props, monitorControl, executorControl } = buildHarness();
    const { lastFrame, stdin, unmount } = await renderApp(props);

    await submit(stdin, "/pause");
    await flushed(store);

    await eventually(() => {
      expect(monitorControl.state).toBe("pausing");
      expect(executorControl.state).toBe("pausing");
    });
    await eventually(() => {
      expect(lastFrame()).toContain("pausing monitor and executor");
    });
    expect(lastFrame()).toContain("⏸ pausing…");

    await submit(stdin, "/start monitor");
    await flushed(store);
    await eventually(() => {
      expect(monitorControl.state).toBe("running");
    });
    await eventually(() => {
      expect(lastFrame()).toContain("started monitor");
    });

    unmount();
    store.dispose();
  });

  it("boots paused: shows the hint notice and /start wakes both agents", async () => {
    const { store, props, monitorControl, executorControl } = buildHarness("paused");
    const { lastFrame, stdin, unmount } = await renderApp(props);

    const frame = lastFrame() ?? "";
    expect(frame).toContain("agents are paused — run /start to wake them");
    expect(frame).toContain("⏸ paused");

    await submit(stdin, "/start");
    await flushed(store);

    await eventually(() => {
      expect(monitorControl.state).toBe("running");
      expect(executorControl.state).toBe("running");
    });
    await eventually(() => {
      expect(lastFrame()).toContain("started monitor and executor");
    });
    expect(lastFrame()).not.toContain("⏸ paused");

    unmount();
    store.dispose();
  });

  it("/task adds a manual task and wakes the executor", async () => {
    const { store, props, addTasks, notify } = buildHarness();
    const { lastFrame, stdin, unmount } = await renderApp(props);

    await submit(stdin, "/task Fix the deploy pipeline");

    await eventually(() => {
      const candidates = addTasks.mock.calls[0]?.[0] as { title: string }[] | undefined;
      expect(candidates?.[0]?.title).toBe("Fix the deploy pipeline");
    });
    await eventually(() => {
      expect(notify).toHaveBeenCalledTimes(1);
    });
    await eventually(() => {
      expect(lastFrame()).toContain("added");
    });

    unmount();
    store.dispose();
  });

  it("unknown commands produce an error notice and plain text is ignored", async () => {
    const { store, props } = buildHarness();
    const { lastFrame, stdin, unmount } = await renderApp(props);

    await submit(stdin, "/nope");
    await eventually(() => {
      expect(lastFrame()).toContain("unknown command /nope — try /help");
    });

    await submit(stdin, "hello");
    await eventually(() => {
      expect(lastFrame()).toContain("> hello");
    });

    unmount();
    store.dispose();
  });

  it("the notice disappears after the configured timeout", async () => {
    const { store, props } = buildHarness();
    const { lastFrame, stdin, unmount } = await renderApp({
      ...props,
      noticeTimeoutMs: 40,
    });

    await submit(stdin, "/nope");
    await eventually(() => {
      expect(lastFrame()).toContain("unknown command");
    });

    await eventually(() => {
      expect(lastFrame()).not.toContain("unknown command");
    });

    unmount();
    store.dispose();
  });

  it("/exit requests a graceful shutdown", async () => {
    const { store, props, requestExit } = buildHarness();
    const { stdin, unmount } = await renderApp(props);

    await submit(stdin, "/exit");
    await eventually(() => {
      expect(requestExit).toHaveBeenCalledTimes(1);
    });

    unmount();
    store.dispose();
  });

  it("/config shows the current configuration", async () => {
    const { store, props } = buildHarness();
    const { lastFrame, stdin, unmount } = await renderApp(props);

    await submit(stdin, "/config");

    await eventually(() => {
      expect(lastFrame()).toContain("Summarizer");
    });
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Monitor");
    expect(frame).toContain("Executor");
    expect(frame).toContain("every 5 min");
    expect(frame).toContain("max attempts");
    expect(frame).toContain("change with /model /effort /interval /hours /days");

    unmount();
    store.dispose();
  });

  it("/model applies a live change so the header refreshes", async () => {
    const dir = await createTempDir();
    const settingsFile = join(dir, "settings.json");
    await writeFile(settingsFile, '{"monitor":{"intervalMinutes":5}}\n', "utf8");
    const { store, props } = buildHarness();
    const settings = createSettingsController({ config: props.config, settingsFile });
    const { lastFrame, stdin, unmount } = await renderApp({ ...props, settings });

    expect(lastFrame()).toContain("opus · high");

    await submit(stdin, "/model executor sonnet");

    await eventually(() => {
      expect(lastFrame()).toContain("sonnet · high");
    });
    await eventually(() => {
      expect(lastFrame()).toContain("executor model set to sonnet");
    });
    expect(JSON.parse(await readFile(settingsFile, "utf8"))).toMatchObject({
      executor: { model: "sonnet" },
    });

    unmount();
    store.dispose();
    await removeTempDir(dir);
  });

  it("/interval applies a live change to the monitor interval", async () => {
    const dir = await createTempDir();
    const settingsFile = join(dir, "settings.json");
    await writeFile(settingsFile, "{}\n", "utf8");
    const { store, props } = buildHarness();
    const settings = createSettingsController({ config: props.config, settingsFile });
    const { lastFrame, stdin, unmount } = await renderApp({ ...props, settings });

    await submit(stdin, "/interval 2");

    await eventually(() => {
      expect(lastFrame()).toContain("every 2 min");
    });
    await eventually(() => {
      expect(lastFrame()).toContain("monitor interval set to 2 min");
    });

    unmount();
    store.dispose();
    await removeTempDir(dir);
  });

  it("/prompt opens the editor and Ctrl+D saves the file", async () => {
    const { store, props, prompts } = buildHarness();
    const rendered = await renderApp(props);
    const { lastFrame, stdin, unmount } = rendered;

    await openEditor(
      rendered,
      props,
      "/prompt monitor",
      "monitor prompt (.brownie/prompts/monitor.prompt.md)",
    );

    const frame = lastFrame() ?? "";
    expect(frame).toContain("watch the pipelines");
    expect(frame).toContain("Ctrl+D: save");
    expect(frame).not.toContain("> ");

    await type(stdin, " and CI");
    await type(stdin, CTRL_D);

    await eventually(() => {
      expect(prompts.write).toHaveBeenCalledWith("monitor", "watch the pipelines and CI");
    });
    await eventually(() => {
      expect(lastFrame()).toContain(
        "monitor prompt saved — applies from the next session",
      );
    });
    expect(lastFrame()).toContain("> ");

    unmount();
    store.dispose();
  });

  it("/prompt closed with Esc writes nothing", async () => {
    const { store, props, prompts } = buildHarness();
    const { lastFrame, stdin, unmount } = await renderApp(props);

    await submit(stdin, "/prompt executor");
    await type(stdin, "scratch edits");
    await type(stdin, ESCAPE);

    await eventually(() => {
      expect(lastFrame()).toContain("> ");
    });
    expect(prompts.write).not.toHaveBeenCalled();

    unmount();
    store.dispose();
  });

  it("/prompt save failures surface as an error notice", async () => {
    const { store, props, prompts } = buildHarness();
    prompts.write.mockRejectedValue(new Error("disk full"));
    const rendered = await renderApp(props);
    const { lastFrame, stdin, unmount } = rendered;

    await openEditor(
      rendered,
      props,
      "/prompt monitor",
      "monitor prompt (.brownie/prompts/monitor.prompt.md)",
    );
    await type(stdin, CTRL_D);

    await eventually(() => {
      expect(lastFrame()).toContain("disk full");
    });

    unmount();
    store.dispose();
  });

  it("/context opens the same editor and Ctrl+D saves the context file", async () => {
    const { store, props, context } = buildHarness();
    const rendered = await renderApp(props);
    const { lastFrame, stdin, unmount } = rendered;

    await openEditor(
      rendered,
      props,
      "/context",
      "context file (.brownie/prompts/context.md, optional)",
    );

    const frame = lastFrame() ?? "";
    expect(frame).toContain("the acme-shop workspace");
    expect(frame).toContain("Ctrl+D: save");
    expect(frame).not.toContain("> ");

    await type(stdin, " and its CI");
    await type(stdin, CTRL_D);

    await eventually(() => {
      expect(context.write).toHaveBeenCalledWith("the acme-shop workspace and its CI");
    });
    await eventually(() => {
      expect(lastFrame()).toContain("context saved — applies from the next session");
    });
    expect(lastFrame()).toContain("> ");

    unmount();
    store.dispose();
  });

  it("/context closed with Esc writes nothing", async () => {
    const { store, props, context } = buildHarness();
    const { lastFrame, stdin, unmount } = await renderApp(props);

    await submit(stdin, "/context");
    await type(stdin, "scratch edits");
    await type(stdin, ESCAPE);

    await eventually(() => {
      expect(lastFrame()).toContain("> ");
    });
    expect(context.write).not.toHaveBeenCalled();

    unmount();
    store.dispose();
  });
});
