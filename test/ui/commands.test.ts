import { describe, expect, it, vi } from "vitest";
import { AgentController } from "../../src/control.js";
import { DrainController } from "../../src/drain.js";
import type { TaskSummaryRecord } from "../../src/memory/store.js";
import {
  argumentGhost,
  buildManualTask,
  COMMAND_GROUPS,
  commandMenu,
  COMMANDS,
  dispatchCommand,
  parseCommand,
  suggestions,
  type CommandContext,
  type View,
} from "../../src/ui/commands.js";

function buildRecord(id: number): TaskSummaryRecord {
  return {
    id,
    taskId: `t-${id}`,
    attempt: 1,
    ok: true,
    title: `Title ${id}`,
    headline: `Headline ${id}`,
    summary: `Summary ${id}`,
    error: undefined,
    sessionId: undefined,
    createdAt: "2026-07-01T10:00:00.000Z",
  };
}

function fakeSettings() {
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

function fakePrompts() {
  return { read: vi.fn().mockResolvedValue("prompt content") };
}

function fakeContextFile() {
  return { read: vi.fn().mockResolvedValue("context content") };
}

interface FakeContext {
  ctx: CommandContext;
  views: View[];
  notices: { text: string; tone: string }[];
  monitorControl: AgentController;
  executorControl: AgentController;
  drain: DrainController;
  drainFinished: ReturnType<typeof vi.fn>;
  retry: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
  addTasks: ReturnType<typeof vi.fn>;
  recent: ReturnType<typeof vi.fn>;
  search: ReturnType<typeof vi.fn>;
  settings: ReturnType<typeof fakeSettings>;
  prompts: ReturnType<typeof fakePrompts>;
  contextFile: ReturnType<typeof fakeContextFile>;
  notify: ReturnType<typeof vi.fn>;
  requestExit: ReturnType<typeof vi.fn>;
}

function fakeContext(): FakeContext {
  const views: View[] = [];
  const notices: { text: string; tone: string }[] = [];
  const monitorControl = new AgentController(() => undefined);
  const executorControl = new AgentController(() => undefined);
  const drainFinished = vi.fn();
  const drain = new DrainController(
    { monitor: monitorControl, executor: executorControl },
    drainFinished,
  );
  const retry = vi.fn().mockResolvedValue(true);
  const cancel = vi.fn().mockResolvedValue(true);
  const addTasks = vi
    .fn()
    .mockImplementation((tasks: unknown[]) => Promise.resolve(tasks));
  const recent = vi.fn().mockReturnValue([buildRecord(2), buildRecord(1)]);
  const search = vi.fn().mockReturnValue([buildRecord(3)]);
  const settings = fakeSettings();
  const prompts = fakePrompts();
  const contextFile = fakeContextFile();
  const notify = vi.fn();
  const requestExit = vi.fn();
  return {
    views,
    notices,
    monitorControl,
    executorControl,
    drain,
    drainFinished,
    retry,
    cancel,
    addTasks,
    recent,
    search,
    settings,
    prompts,
    contextFile,
    notify,
    requestExit,
    ctx: {
      setView: (view) => views.push(view),
      monitorControl,
      executorControl,
      drain,
      tasks: { list: vi.fn().mockReturnValue([]), retry, cancel, addTasks },
      memory: { recent, search },
      settings,
      prompts,
      context: contextFile,
      waker: { notify },
      requestExit,
      notice: (text, tone = "info") => notices.push({ text, tone }),
    },
  };
}

describe("parseCommand", () => {
  it("splits the name and arguments, lowercases the name", () => {
    expect(parseCommand("/PAUSE  monitor ")).toEqual({
      name: "pause",
      args: "monitor",
    });
    expect(parseCommand("/help")).toEqual({ name: "help", args: "" });
  });

  it("rejects non-command lines", () => {
    expect(parseCommand("hello")).toBeNull();
    expect(parseCommand("/")).toBeNull();
    expect(parseCommand("")).toBeNull();
  });
});

describe("suggestions", () => {
  it("lists every command matching the typed prefix, in registry order", () => {
    expect(suggestions("/m").map((item) => item.name)).toEqual([
      "monitor",
      "memory",
      "model",
    ]);
    expect(suggestions("/da").map((item) => item.name)).toEqual(["dashboard", "days"]);
  });

  it("lists all commands for a bare slash", () => {
    expect(suggestions("/")).toHaveLength(COMMANDS.length);
    expect(suggestions("/")[0]).toEqual({
      name: COMMANDS[0]?.name,
      args: COMMANDS[0]?.args,
      summary: COMMANDS[0]?.summary,
    });
  });

  it("keeps an exact name in the list so it can still be run", () => {
    expect(suggestions("/task").map((item) => item.name)).toEqual(["tasks", "task"]);
  });

  it("returns nothing for unknown prefixes, arguments or plain text", () => {
    expect(suggestions("/zzz")).toEqual([]);
    expect(suggestions("/pause mon")).toEqual([]);
    expect(suggestions("plain text")).toEqual([]);
  });
});

describe("dispatchCommand", () => {
  it("switches views for the view commands", async () => {
    const { ctx, views } = fakeContext();
    const lines = ["/dashboard", "/monitor", "/executor", "/tasks", "/config", "/help"];
    for (const line of lines) {
      await dispatchCommand(line, ctx);
    }
    expect(views.map((view) => view.kind)).toEqual([
      "dashboard",
      "monitor",
      "executor",
      "tasks",
      "config",
      "help",
    ]);
  });

  it("reports unknown commands as an error notice", async () => {
    const { ctx, notices } = fakeContext();
    await dispatchCommand("/nope", ctx);
    expect(notices).toEqual([
      { text: "unknown command /nope — try /help", tone: "error" },
    ]);
  });

  it("/memory without a query shows recent entries", async () => {
    const { ctx, views, recent } = fakeContext();
    await dispatchCommand("/memory", ctx);
    expect(recent).toHaveBeenCalledWith(20);
    expect(views[0]).toMatchObject({ kind: "memory", query: undefined });
    if (views[0]?.kind === "memory") expect(views[0].entries).toHaveLength(2);
  });

  it("/memory with a query searches the store", async () => {
    const { ctx, views, search } = fakeContext();
    await dispatchCommand("/memory deploy errors", ctx);
    expect(search).toHaveBeenCalledWith("deploy errors", 20);
    expect(views[0]).toMatchObject({ kind: "memory", query: "deploy errors" });
  });

  it("/pause without arguments pauses both agents", async () => {
    const { ctx, notices, monitorControl, executorControl } = fakeContext();
    await dispatchCommand("/pause", ctx);
    expect(monitorControl.state).toBe("pausing");
    expect(executorControl.state).toBe("pausing");
    expect(notices[0]?.text).toBe("pausing monitor and executor");
  });

  it("/pause of an already paused agent reports it", async () => {
    const { ctx, notices, monitorControl } = fakeContext();
    monitorControl.pause();
    await dispatchCommand("/pause", ctx);
    expect(notices[0]?.text).toBe("pausing executor · monitor already paused");
  });

  it("/pause validates the agent name", async () => {
    const { ctx, notices, monitorControl } = fakeContext();
    await dispatchCommand("/pause everything", ctx);
    expect(monitorControl.state).toBe("running");
    expect(notices[0]).toEqual({
      text: 'unknown agent "everything" — use monitor or executor',
      tone: "error",
    });
  });

  it("/start starts a single agent and reports running ones", async () => {
    const { ctx, notices, monitorControl, executorControl } = fakeContext();
    monitorControl.pause();
    await dispatchCommand("/start monitor", ctx);
    expect(monitorControl.state).toBe("running");
    expect(notices[0]?.text).toBe("started monitor");

    await dispatchCommand("/start executor", ctx);
    expect(executorControl.state).toBe("running");
    expect(notices[1]?.text).toBe("executor already running");
  });

  it("/start without arguments starts both paused agents", async () => {
    const { ctx, notices, monitorControl, executorControl } = fakeContext();
    monitorControl.pause();
    executorControl.pause();
    await dispatchCommand("/start", ctx);
    expect(monitorControl.state).toBe("running");
    expect(executorControl.state).toBe("running");
    expect(notices[0]?.text).toBe("started monitor and executor");
  });

  it("/drain pauses both agents until they finish, and says so once", async () => {
    const { ctx, notices, monitorControl, executorControl, drain, drainFinished } =
      fakeContext();

    await dispatchCommand("/drain", ctx);
    await dispatchCommand("/drain", ctx);

    expect(drain.snapshot).toMatchObject({ reason: "drain", until: undefined });
    expect(monitorControl.state).toBe("pausing");
    expect(executorControl.state).toBe("pausing");
    expect(drainFinished).not.toHaveBeenCalled();
    expect(notices).toEqual([
      { text: "draining — kikimora exits after the current session", tone: "warn" },
      {
        text: "already draining — kikimora exits after the current session",
        tone: "warn",
      },
    ]);
    drain.dispose();
  });

  it("/start refuses to wake agents while draining", async () => {
    const { ctx, notices, monitorControl, executorControl, drain } = fakeContext();
    await dispatchCommand("/drain", ctx);

    await dispatchCommand("/start", ctx);

    expect(monitorControl.state).toBe("pausing");
    expect(executorControl.state).toBe("pausing");
    expect(notices[1]).toEqual({
      text: "draining — kikimora exits after the current session",
      tone: "error",
    });
    drain.dispose();
  });

  it("/retry requeues a failed task and wakes the executor", async () => {
    const { ctx, notices, retry, notify } = fakeContext();
    await dispatchCommand("/retry t-1", ctx);
    expect(retry).toHaveBeenCalledWith("t-1");
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notices[0]?.text).toBe("task t-1 requeued");
  });

  it("/retry reports a missing task and requires an id", async () => {
    const { ctx, notices, retry, notify } = fakeContext();
    retry.mockResolvedValue(false);
    await dispatchCommand("/retry ghost", ctx);
    await dispatchCommand("/retry", ctx);
    expect(notify).not.toHaveBeenCalled();
    expect(notices).toEqual([
      { text: 'no failed task "ghost"', tone: "error" },
      { text: "usage: /retry <task-id>", tone: "error" },
    ]);
  });

  it("/cancel cancels a pending task and reports non-cancellable ones", async () => {
    const { ctx, notices, cancel } = fakeContext();
    await dispatchCommand("/cancel t-1", ctx);
    cancel.mockResolvedValue(false);
    await dispatchCommand("/cancel t-2", ctx);
    expect(notices).toEqual([
      { text: "task t-1 cancelled", tone: "ok" },
      {
        text: 'no pending task "t-2" — only pending tasks can be cancelled',
        tone: "error",
      },
    ]);
  });

  it("/task adds a manual task and wakes the executor", async () => {
    const { ctx, notices, addTasks, notify } = fakeContext();
    await dispatchCommand("/task Check the failing deploy pipeline", ctx);
    const candidate = addTasks.mock.calls[0]?.[0] as
      { id: string; title: string; description: string }[] | undefined;
    expect(candidate?.[0]?.id).toMatch(/^manual-/);
    expect(candidate?.[0]?.title).toBe("Check the failing deploy pipeline");
    expect(candidate?.[0]?.description).toBe("Check the failing deploy pipeline");
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notices[0]?.text).toMatch(/^task manual-.* added$/);
  });

  it("/task requires a description and reports duplicates", async () => {
    const { ctx, notices, addTasks, notify } = fakeContext();
    await dispatchCommand("/task", ctx);
    addTasks.mockResolvedValue([]);
    await dispatchCommand("/task something", ctx);
    expect(notify).not.toHaveBeenCalled();
    expect(notices[0]).toEqual({ text: "usage: /task <description>", tone: "error" });
    expect(notices[1]?.text).toMatch(/already exists$/);
    expect(notices[1]?.tone).toBe("error");
  });

  it("/exit requests a graceful shutdown", async () => {
    const { ctx, requestExit } = fakeContext();
    await dispatchCommand("/exit", ctx);
    expect(requestExit).toHaveBeenCalledTimes(1);
  });

  it("turns handler exceptions into an error notice", async () => {
    const { ctx, notices, retry } = fakeContext();
    retry.mockRejectedValue(new Error("store unavailable"));
    await dispatchCommand("/retry t-1", ctx);
    expect(notices[0]).toEqual({ text: "store unavailable", tone: "error" });
  });

  it("/model sets the model of a single agent", async () => {
    const { ctx, notices, settings } = fakeContext();
    await dispatchCommand("/model executor sonnet", ctx);
    expect(settings.setModel).toHaveBeenCalledWith("executor", "sonnet");
    expect(notices[0]).toEqual({
      text: "executor model set to sonnet — applies from the next session",
      tone: "ok",
    });
  });

  it("/model validates the argument count and the agent name", async () => {
    const { ctx, notices, settings } = fakeContext();
    await dispatchCommand("/model executor", ctx);
    await dispatchCommand("/model everything opus", ctx);
    expect(settings.setModel).not.toHaveBeenCalled();
    expect(notices[0]).toEqual({
      text: "usage: /model <monitor|executor|summarizer> <haiku|sonnet|opus|fable>",
      tone: "error",
    });
    expect(notices[1]).toEqual({
      text: 'unknown agent "everything" — use monitor, executor, summarizer',
      tone: "error",
    });
  });

  it("/model surfaces controller rejections as error notices", async () => {
    const { ctx, notices, settings } = fakeContext();
    settings.setModel.mockRejectedValue(new Error('unknown model "gpt"'));
    await dispatchCommand("/model monitor gpt", ctx);
    expect(notices[0]).toEqual({ text: 'unknown model "gpt"', tone: "error" });
  });

  it("/effort sets the effort of a single agent", async () => {
    const { ctx, notices, settings } = fakeContext();
    await dispatchCommand("/effort monitor high", ctx);
    expect(settings.setEffort).toHaveBeenCalledWith("monitor", "high");
    expect(notices[0]).toEqual({
      text: "monitor effort set to high — applies from the next session",
      tone: "ok",
    });
  });

  it("/effort requires an agent and a level", async () => {
    const { ctx, notices, settings } = fakeContext();
    await dispatchCommand("/effort high", ctx);
    expect(settings.setEffort).not.toHaveBeenCalled();
    expect(notices[0]).toEqual({
      text: "usage: /effort <monitor|executor|summarizer> <low|medium|high|xhigh|max>",
      tone: "error",
    });
  });

  it("/interval sets the monitor interval and accepts a decimal comma", async () => {
    const { ctx, notices, settings } = fakeContext();
    await dispatchCommand("/interval 2,5", ctx);
    expect(settings.setIntervalMinutes).toHaveBeenCalledWith(2.5);
    expect(notices[0]).toEqual({
      text: "monitor interval set to 2 min 30 s — applies after the current cycle",
      tone: "ok",
    });
  });

  it("/interval rejects non-positive or missing values", async () => {
    const { ctx, notices, settings } = fakeContext();
    await dispatchCommand("/interval", ctx);
    await dispatchCommand("/interval zero", ctx);
    await dispatchCommand("/interval -5", ctx);
    expect(settings.setIntervalMinutes).not.toHaveBeenCalled();
    for (const notice of notices) {
      expect(notice).toEqual({ text: "usage: /interval <minutes>", tone: "error" });
    }
  });

  it("/hours sets and clears the monitor working hours", async () => {
    const { ctx, notices, settings } = fakeContext();
    await dispatchCommand("/hours 08:00-18:00", ctx);
    await dispatchCommand("/hours off", ctx);
    expect(settings.setActiveHours).toHaveBeenNthCalledWith(1, "08:00-18:00");
    expect(settings.setActiveHours).toHaveBeenNthCalledWith(2, null);
    expect(notices.map((notice) => notice.text)).toEqual([
      "monitor hours set to 08:00-18:00",
      "monitor hours cleared — running 24/7",
    ]);
  });

  it("/hours without arguments shows usage", async () => {
    const { ctx, notices, settings } = fakeContext();
    await dispatchCommand("/hours", ctx);
    expect(settings.setActiveHours).not.toHaveBeenCalled();
    expect(notices[0]).toEqual({
      text: "usage: /hours <HH:MM-HH:MM|off> — current values in /config",
      tone: "error",
    });
  });

  it("/days sets and clears the monitor working days", async () => {
    const { ctx, notices, settings } = fakeContext();
    await dispatchCommand("/days mon-fri", ctx);
    await dispatchCommand("/days off", ctx);
    expect(settings.setActiveDays).toHaveBeenNthCalledWith(1, "mon-fri");
    expect(settings.setActiveDays).toHaveBeenNthCalledWith(2, null);
    expect(notices.map((notice) => notice.text)).toEqual([
      "monitor days set to mon-fri",
      "monitor days cleared — running daily",
    ]);
  });

  it("/days without arguments shows usage", async () => {
    const { ctx, notices, settings } = fakeContext();
    await dispatchCommand("/days", ctx);
    expect(settings.setActiveDays).not.toHaveBeenCalled();
    expect(notices[0]).toEqual({
      text: "usage: /days <days|off> (e.g. mon-fri,sun) — current values in /config",
      tone: "error",
    });
  });

  it("/prompt opens the editor view with the file content", async () => {
    const { ctx, views, prompts } = fakeContext();
    await dispatchCommand("/prompt monitor", ctx);
    expect(prompts.read).toHaveBeenCalledWith("monitor");
    expect(views[0]).toEqual({
      kind: "prompt",
      agent: "monitor",
      content: "prompt content",
    });
  });

  it("/prompt validates the agent name", async () => {
    const { ctx, notices, prompts } = fakeContext();
    await dispatchCommand("/prompt", ctx);
    await dispatchCommand("/prompt summarizer", ctx);
    expect(prompts.read).not.toHaveBeenCalled();
    for (const notice of notices) {
      expect(notice).toEqual({
        text: "usage: /prompt <monitor|executor>",
        tone: "error",
      });
    }
  });

  it("/prompt surfaces read failures as error notices", async () => {
    const { ctx, notices, prompts } = fakeContext();
    prompts.read.mockRejectedValue(new Error("ENOENT: prompt file missing"));
    await dispatchCommand("/prompt executor", ctx);
    expect(notices[0]).toEqual({
      text: "ENOENT: prompt file missing",
      tone: "error",
    });
  });

  it("/context opens the editor view with the context file content", async () => {
    const { ctx, views, contextFile } = fakeContext();
    await dispatchCommand("/context", ctx);
    expect(contextFile.read).toHaveBeenCalled();
    expect(views[0]).toEqual({ kind: "context", content: "context content" });
  });

  it("/context opens on an empty context too", async () => {
    const { ctx, views, contextFile } = fakeContext();
    contextFile.read.mockResolvedValue("");
    await dispatchCommand("/context", ctx);
    expect(views[0]).toEqual({ kind: "context", content: "" });
  });

  it("/context surfaces read failures as error notices", async () => {
    const { ctx, notices, contextFile } = fakeContext();
    contextFile.read.mockRejectedValue(new Error("EACCES: context file unreadable"));
    await dispatchCommand("/context", ctx);
    expect(notices[0]).toEqual({
      text: "EACCES: context file unreadable",
      tone: "error",
    });
  });
});

describe("buildManualTask", () => {
  it("truncates a long first line to the title and keeps the full description", () => {
    const longLine = "x".repeat(80);
    const description = `${longLine}\nsecond line`;
    const task = buildManualTask(description);
    expect(task.title).toHaveLength(60);
    expect(task.title.endsWith("…")).toBe(true);
    expect(task.description).toBe(description);
  });

  it("generates unique ids", () => {
    const first = buildManualTask("a");
    const second = buildManualTask("a");
    expect(first.id).not.toBe(second.id);
  });
});

describe("commandMenu", () => {
  it("lists commands with their argument syntax while the name is typed", () => {
    const menu = commandMenu("/mo");
    expect(menu.argument).toBe(false);
    expect(menu.matchLength).toBe(3);
    expect(menu.items).toEqual([
      {
        key: "monitor",
        label: "/monitor",
        args: undefined,
        summary: "show the monitor agent in full detail",
        apply: "/monitor",
      },
      {
        key: "model",
        label: "/model",
        args: "<agent> <model>",
        summary: "set the model for monitor, executor, or summarizer",
        apply: "/model",
      },
    ]);
  });

  it("offers the values of the argument under the cursor", () => {
    const agents = commandMenu("/model ");
    expect(agents.argument).toBe(true);
    expect(agents.items.map((item) => item.label)).toEqual([
      "monitor",
      "executor",
      "summarizer",
    ]);
    expect(agents.items[0]?.apply).toBe("/model monitor ");

    const models = commandMenu("/model executor so");
    expect(models.matchLength).toBe(2);
    expect(models.items).toEqual([
      { key: "sonnet", label: "sonnet", apply: "/model executor sonnet" },
    ]);
  });

  it("offers nothing once the argument is complete or has no values", () => {
    expect(commandMenu("/pause monitor").items).toEqual([]);
    expect(commandMenu("/task fix").items).toEqual([]);
    expect(commandMenu("/model executor sonnet ").items).toEqual([]);
    expect(commandMenu("/nope x").items).toEqual([]);
    expect(commandMenu("/model  x").items).toEqual([]);
  });

  it("completes the case-insensitive command name", () => {
    expect(commandMenu("/PAUSE ex").items.map((item) => item.apply)).toEqual([
      "/PAUSE executor",
    ]);
  });
});

describe("argumentGhost", () => {
  it("shows the whole syntax after an exact command name", () => {
    expect(argumentGhost("/model")).toBe(" <agent> <model>");
  });

  it("shows the placeholders still missing", () => {
    expect(argumentGhost("/model ")).toBe("<agent> <model>");
    expect(argumentGhost("/model exec")).toBe(" <model>");
    expect(argumentGhost("/model executor ")).toBe("<model>");
    expect(argumentGhost("/task ")).toBe("<description>");
  });

  it("shows nothing when every argument is there or the command takes none", () => {
    expect(argumentGhost("/model executor sonnet")).toBeUndefined();
    expect(argumentGhost("/task fix the deploy")).toBeUndefined();
    expect(argumentGhost("/dashboard")).toBeUndefined();
    expect(argumentGhost("/nope ")).toBeUndefined();
    expect(argumentGhost("/model  x")).toBeUndefined();
    expect(argumentGhost("plain")).toBeUndefined();
  });
});

describe("COMMANDS", () => {
  it("assigns every command to a known group, in group order", () => {
    const order = COMMANDS.map((command) => COMMAND_GROUPS.indexOf(command.group));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("has unique names and summaries for /help", () => {
    const names = COMMANDS.map((command) => command.name);
    expect(new Set(names).size).toBe(names.length);
    for (const command of COMMANDS) expect(command.summary).not.toBe("");
  });
});
