import type { ContextFileAccess } from "../context-file.js";
import type { AgentController } from "../control.js";
import type { DrainController } from "../drain.js";
import type { TaskSummaryRecord } from "../memory/store.js";
import {
  PROMPT_AGENTS,
  type PromptAgent,
  type PromptFileAccess,
} from "../prompt-files.js";
import {
  CONFIG_AGENTS,
  parseConfigAgent,
  type SettingsController,
} from "../settings-controller.js";
import { buildManualTask } from "../tasks.js";
import { EFFORT_LEVELS, MODELS } from "../types.js";
import type { Waker } from "../waker.js";
import type { MemoryReader, TaskControls } from "../worker-controls.js";
import { formatInterval } from "./format.js";

export { buildManualTask } from "../tasks.js";
export type { MemoryReader, TaskControls } from "../worker-controls.js";

export type View =
  | { kind: "dashboard" }
  | { kind: "monitor" }
  | { kind: "executor" }
  | { kind: "tasks" }
  | { kind: "help" }
  | { kind: "config" }
  | { kind: "prompt"; agent: PromptAgent; content: string }
  | { kind: "context"; content: string }
  | {
      kind: "memory";
      query?: string | undefined;
      entries: readonly TaskSummaryRecord[];
    };

export type NoticeTone = "ok" | "info" | "warn" | "error";

export type AgentControls = Pick<AgentController, "pause" | "resume" | "state">;

export type DrainControls = Pick<DrainController, "request" | "snapshot">;

export interface CommandContext {
  setView(view: View): void;
  monitorControl: AgentControls;
  executorControl: AgentControls;
  drain: DrainControls;
  tasks: TaskControls;
  memory: MemoryReader;
  settings: SettingsController;
  prompts: Pick<PromptFileAccess, "read">;
  context: Pick<ContextFileAccess, "read">;
  waker: Pick<Waker, "notify">;
  requestExit(): void;
  notice(text: string, tone?: NoticeTone): void;
}

export const COMMAND_GROUPS = [
  "Views",
  "Agents",
  "Tasks",
  "Settings",
  "Files",
  "Session",
] as const;

export type CommandGroup = (typeof COMMAND_GROUPS)[number];

export interface CommandSpec {
  name: string;
  group: CommandGroup;
  args?: string | undefined;
  summary: string;
  complete?: ((argIndex: number) => readonly string[]) | undefined;
  run(args: string, ctx: CommandContext): void | Promise<void>;
}

const MEMORY_VIEW_LIMIT = 20;

const AGENT_NAMES = ["monitor", "executor"] as const;
const OFF = ["off"] as const;
type AgentName = (typeof AGENT_NAMES)[number];

function resolveAgents(args: string): AgentName[] | null {
  const trimmed = args.trim();
  if (trimmed === "") return [...AGENT_NAMES];
  const match = AGENT_NAMES.find((name) => name === trimmed);
  return match === undefined ? null : [match];
}

function agentControl(ctx: CommandContext, agent: AgentName): AgentControls {
  return agent === "monitor" ? ctx.monitorControl : ctx.executorControl;
}

function splitArgs(args: string): string[] {
  const trimmed = args.trim();
  return trimmed === "" ? [] : trimmed.split(/\s+/);
}

function joinNames(agents: readonly AgentName[]): string {
  return agents.join(" and ");
}

export const COMMANDS: readonly CommandSpec[] = [
  {
    name: "dashboard",
    group: "Views",
    summary: "show the combined monitor + executor + tasks view",
    run: (_args, ctx) => {
      ctx.setView({ kind: "dashboard" });
    },
  },
  {
    name: "monitor",
    group: "Views",
    summary: "show the monitor agent in full detail",
    run: (_args, ctx) => {
      ctx.setView({ kind: "monitor" });
    },
  },
  {
    name: "executor",
    group: "Views",
    summary: "show the executor agent in full detail",
    run: (_args, ctx) => {
      ctx.setView({ kind: "executor" });
    },
  },
  {
    name: "tasks",
    group: "Views",
    summary: "show the full task list",
    run: (_args, ctx) => {
      ctx.setView({ kind: "tasks" });
    },
  },
  {
    name: "memory",
    group: "Views",
    args: "[query]",
    summary: "browse long-term memory, optionally filtered by a search query",
    run: (args, ctx) => {
      const query = args.trim();
      ctx.setView(
        query === ""
          ? {
              kind: "memory",
              query: undefined,
              entries: ctx.memory.recent(MEMORY_VIEW_LIMIT),
            }
          : {
              kind: "memory",
              query,
              entries: ctx.memory.search(query, MEMORY_VIEW_LIMIT),
            },
      );
    },
  },
  {
    name: "config",
    group: "Views",
    summary: "show the current configuration",
    run: (_args, ctx) => {
      ctx.setView({ kind: "config" });
    },
  },
  {
    name: "help",
    group: "Views",
    summary: "list all commands",
    run: (_args, ctx) => {
      ctx.setView({ kind: "help" });
    },
  },
  {
    name: "pause",
    group: "Agents",
    args: "[monitor|executor]",
    complete: (index) => (index === 0 ? AGENT_NAMES : []),
    summary: "gracefully pause agents — the current session finishes first",
    run: (args, ctx) => {
      const agents = resolveAgents(args);
      if (agents === null) {
        ctx.notice(`unknown agent "${args.trim()}" — use monitor or executor`, "error");
        return;
      }
      const paused = agents.filter((agent) => agentControl(ctx, agent).pause());
      const skipped = agents.filter((agent) => !paused.includes(agent));
      const parts: string[] = [];
      if (paused.length > 0) parts.push(`pausing ${joinNames(paused)}`);
      if (skipped.length > 0) parts.push(`${joinNames(skipped)} already paused`);
      ctx.notice(parts.join(" · "));
    },
  },
  {
    name: "start",
    group: "Agents",
    args: "[monitor|executor]",
    complete: (index) => (index === 0 ? AGENT_NAMES : []),
    summary: "start paused agents — they boot paused until you start them",
    run: (args, ctx) => {
      const agents = resolveAgents(args);
      if (agents === null) {
        ctx.notice(`unknown agent "${args.trim()}" — use monitor or executor`, "error");
        return;
      }
      if (ctx.drain.snapshot !== undefined) {
        ctx.notice("draining — kikimora exits after the current session", "error");
        return;
      }
      const started = agents.filter((agent) => agentControl(ctx, agent).resume());
      const skipped = agents.filter((agent) => !started.includes(agent));
      const parts: string[] = [];
      if (started.length > 0) parts.push(`started ${joinNames(started)}`);
      if (skipped.length > 0) parts.push(`${joinNames(skipped)} already running`);
      ctx.notice(parts.join(" · "), started.length > 0 ? "ok" : "info");
    },
  },
  {
    name: "task",
    group: "Tasks",
    args: "<description>",
    summary: "add a task for the executor by hand",
    run: async (args, ctx) => {
      const description = args.trim();
      if (description === "") {
        ctx.notice("usage: /task <description>", "error");
        return;
      }
      const candidate = buildManualTask(description);
      const added = await ctx.tasks.addTasks([candidate]);
      if (added.length === 0) {
        ctx.notice(`task ${candidate.id} already exists`, "error");
        return;
      }
      ctx.waker.notify();
      ctx.notice(`task ${candidate.id} added`, "ok");
    },
  },
  {
    name: "retry",
    group: "Tasks",
    args: "<task-id>",
    summary: "requeue a failed task",
    run: async (args, ctx) => {
      const id = args.trim();
      if (id === "") {
        ctx.notice("usage: /retry <task-id>", "error");
        return;
      }
      if (await ctx.tasks.retry(id)) {
        ctx.waker.notify();
        ctx.notice(`task ${id} requeued`, "ok");
      } else {
        ctx.notice(`no failed task "${id}"`, "error");
      }
    },
  },
  {
    name: "cancel",
    group: "Tasks",
    args: "<task-id>",
    summary: "cancel a pending task",
    run: async (args, ctx) => {
      const id = args.trim();
      if (id === "") {
        ctx.notice("usage: /cancel <task-id>", "error");
        return;
      }
      if (await ctx.tasks.cancel(id)) {
        ctx.notice(`task ${id} cancelled`, "ok");
      } else {
        ctx.notice(
          `no pending task "${id}" — only pending tasks can be cancelled`,
          "error",
        );
      }
    },
  },
  {
    name: "model",
    group: "Settings",
    args: "<agent> <model>",
    complete: (index) => [CONFIG_AGENTS, MODELS][index] ?? [],
    summary: "set the model for monitor, executor, or summarizer",
    run: async (args, ctx) => {
      const tokens = splitArgs(args);
      const [agentRaw = "", model = ""] = tokens;
      if (tokens.length !== 2) {
        ctx.notice(
          `usage: /model <${CONFIG_AGENTS.join("|")}> <${MODELS.join("|")}>`,
          "error",
        );
        return;
      }
      const agent = parseConfigAgent(agentRaw);
      await ctx.settings.setModel(agent, model);
      ctx.notice(`${agent} model set to ${model} — applies from the next session`, "ok");
    },
  },
  {
    name: "effort",
    group: "Settings",
    args: "<agent> <level>",
    complete: (index) => [CONFIG_AGENTS, EFFORT_LEVELS][index] ?? [],
    summary: "set the reasoning effort for monitor, executor, or summarizer",
    run: async (args, ctx) => {
      const tokens = splitArgs(args);
      const [agentRaw = "", effort = ""] = tokens;
      if (tokens.length !== 2) {
        ctx.notice(
          `usage: /effort <${CONFIG_AGENTS.join("|")}> <${EFFORT_LEVELS.join("|")}>`,
          "error",
        );
        return;
      }
      const agent = parseConfigAgent(agentRaw);
      await ctx.settings.setEffort(agent, effort);
      ctx.notice(
        `${agent} effort set to ${effort} — applies from the next session`,
        "ok",
      );
    },
  },
  {
    name: "interval",
    group: "Settings",
    args: "<minutes>",
    summary: "set how often the monitor looks for new tasks",
    run: async (args, ctx) => {
      const token = args.trim();
      const minutes = Number(token.replace(",", "."));
      if (token === "" || !Number.isFinite(minutes) || minutes <= 0) {
        ctx.notice("usage: /interval <minutes>", "error");
        return;
      }
      await ctx.settings.setIntervalMinutes(minutes);
      ctx.notice(
        `monitor interval set to ${formatInterval(minutes * 60_000)} — applies after the current cycle`,
        "ok",
      );
    },
  },
  {
    name: "hours",
    group: "Settings",
    args: "<HH:MM-HH:MM|off>",
    complete: (index) => (index === 0 ? OFF : []),
    summary: "set the monitor working hours, or off to run 24/7",
    run: async (args, ctx) => {
      const spec = args.trim();
      if (spec === "") {
        ctx.notice(
          "usage: /hours <HH:MM-HH:MM|off> — current values in /config",
          "error",
        );
        return;
      }
      if (spec.toLowerCase() === "off") {
        await ctx.settings.setActiveHours(null);
        ctx.notice("monitor hours cleared — running 24/7", "ok");
        return;
      }
      await ctx.settings.setActiveHours(spec);
      ctx.notice(`monitor hours set to ${spec}`, "ok");
    },
  },
  {
    name: "days",
    group: "Settings",
    args: "<days|off>",
    complete: (index) => (index === 0 ? OFF : []),
    summary: "set the monitor working days (e.g. mon-fri), or off to run daily",
    run: async (args, ctx) => {
      const spec = args.trim();
      if (spec === "") {
        ctx.notice(
          "usage: /days <days|off> (e.g. mon-fri,sun) — current values in /config",
          "error",
        );
        return;
      }
      if (spec.toLowerCase() === "off") {
        await ctx.settings.setActiveDays(null);
        ctx.notice("monitor days cleared — running daily", "ok");
        return;
      }
      await ctx.settings.setActiveDays(spec);
      ctx.notice(`monitor days set to ${spec}`, "ok");
    },
  },
  {
    name: "prompt",
    group: "Files",
    args: "<monitor|executor>",
    complete: (index) => (index === 0 ? PROMPT_AGENTS : []),
    summary: "view and edit an agent prompt — Ctrl+D saves, Esc closes",
    run: async (args, ctx) => {
      const raw = args.trim();
      const agent = PROMPT_AGENTS.find((name) => name === raw);
      if (agent === undefined) {
        ctx.notice("usage: /prompt <monitor|executor>", "error");
        return;
      }
      const content = await ctx.prompts.read(agent);
      ctx.setView({ kind: "prompt", agent, content });
    },
  },
  {
    name: "context",
    group: "Files",
    summary: "view and edit the workspace context — Ctrl+D saves, Esc closes",
    run: async (_args, ctx) => {
      ctx.setView({ kind: "context", content: await ctx.context.read() });
    },
  },
  {
    name: "drain",
    group: "Session",
    summary: "let the current sessions finish, then shut down kikimora",
    run: (_args, ctx) => {
      const alreadyDraining = ctx.drain.snapshot !== undefined;
      ctx.drain.request("drain", undefined);
      ctx.notice(
        alreadyDraining
          ? "already draining — kikimora exits after the current session"
          : "draining — kikimora exits after the current session",
        "warn",
      );
    },
  },
  {
    name: "exit",
    group: "Session",
    summary: "shut down kikimora gracefully",
    run: (_args, ctx) => {
      ctx.requestExit();
    },
  },
];

export function parseCommand(line: string): { name: string; args: string } | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("/")) return null;
  const body = trimmed.slice(1);
  if (body === "") return null;
  const spaceIndex = body.indexOf(" ");
  if (spaceIndex === -1) return { name: body.toLowerCase(), args: "" };
  return {
    name: body.slice(0, spaceIndex).toLowerCase(),
    args: body.slice(spaceIndex + 1).trim(),
  };
}

export interface CommandSuggestion {
  name: string;
  args?: string | undefined;
  summary: string;
}

export function suggestions(value: string): CommandSuggestion[] {
  if (!value.startsWith("/") || value.includes(" ")) return [];
  const prefix = value.slice(1).toLowerCase();
  return COMMANDS.filter((command) => command.name.startsWith(prefix)).map((command) => ({
    name: command.name,
    args: command.args,
    summary: command.summary,
  }));
}

export interface MenuItem {
  key: string;
  label: string;
  args?: string | undefined;
  summary?: string | undefined;
  apply: string;
}

export interface Menu {
  items: readonly MenuItem[];
  matchLength: number;
  argument: boolean;
}

interface ArgumentContext {
  spec: CommandSpec;
  head: string;
  prefix: string;
  index: number;
}

function argumentContext(value: string): ArgumentContext | undefined {
  const match = /^\/(\S+) (.*)$/s.exec(value);
  if (match === null) return undefined;
  const [, name = "", rest = ""] = match;
  const spec = COMMANDS.find((command) => command.name === name.toLowerCase());
  if (spec === undefined) return undefined;
  const tokens = rest.split(" ");
  const prefix = tokens.pop() ?? "";
  if (tokens.some((token) => token === "")) return undefined;
  return {
    spec,
    head: value.slice(0, value.length - prefix.length),
    prefix,
    index: tokens.length,
  };
}

function argumentItems(context: ArgumentContext): MenuItem[] {
  const { spec, head, prefix, index } = context;
  const values = spec.complete?.(index) ?? [];
  const hasNext = (spec.complete?.(index + 1) ?? []).length > 0;
  const lowered = prefix.toLowerCase();
  return values
    .filter((candidate) => candidate.startsWith(lowered) && candidate !== lowered)
    .map((candidate) => ({
      key: candidate,
      label: candidate,
      apply: `${head}${candidate}${hasNext ? " " : ""}`,
    }));
}

export function commandMenu(value: string): Menu {
  const context = argumentContext(value);
  if (context !== undefined) {
    return {
      items: argumentItems(context),
      matchLength: context.prefix.length,
      argument: true,
    };
  }
  return {
    items: suggestions(value).map((item) => ({
      key: item.name,
      label: `/${item.name}`,
      args: item.args,
      summary: item.summary,
      apply: `/${item.name}`,
    })),
    matchLength: value.length,
    argument: false,
  };
}

export function argumentGhost(value: string): string | undefined {
  const exact = /^\/(\S+)$/.exec(value);
  const name = exact?.[1] ?? /^\/(\S+) /.exec(value)?.[1];
  if (name === undefined) return undefined;
  const spec = COMMANDS.find((command) => command.name === name.toLowerCase());
  if (spec?.args === undefined) return undefined;
  const placeholders = spec.args.split(" ");
  if (exact !== null) return ` ${spec.args}`;
  const context = argumentContext(value);
  if (context === undefined) return undefined;
  const remaining = placeholders.slice(context.index + (context.prefix === "" ? 0 : 1));
  if (remaining.length === 0) return undefined;
  return `${context.prefix === "" ? "" : " "}${remaining.join(" ")}`;
}

export async function dispatchCommand(line: string, ctx: CommandContext): Promise<void> {
  const parsed = parseCommand(line);
  if (parsed === null) return;
  const spec = COMMANDS.find((command) => command.name === parsed.name);
  if (spec === undefined) {
    ctx.notice(`unknown command /${parsed.name} — try /help`, "error");
    return;
  }
  try {
    await spec.run(parsed.args, ctx);
  } catch (err) {
    ctx.notice(err instanceof Error ? err.message : String(err), "error");
  }
}
