import { z } from "zod";
import type { Settings } from "./config.js";
import type { AgentControlState } from "./control.js";
import { DRAIN_TIMEOUT_MAX_MS, type DrainReason, type DrainSnapshot } from "./drain.js";
import type { TaskSummaryRecord } from "./memory/store.js";
import { PROMPT_AGENTS, type PromptAgent } from "./prompt-files.js";
import {
  SESSION_AGENTS,
  SESSIONS_LIMIT_DEFAULT,
  SESSIONS_LIMIT_MAX,
  type SessionRecord,
} from "./sessions/index.js";
import type { JsonValue } from "./settings-file.js";
import type {
  ExecutorPhase,
  ExecutorTaskOutcome,
  MonitorCycleOutcome,
  MonitorPhase,
  WorkerStats,
  WorkerStatus,
} from "./status.js";
import { TASK_STATUSES, type Task, type TaskStatus } from "./types.js";

export const CONTROL_TARGETS = ["monitor", "executor", "all"] as const;

export type ControlTarget = (typeof CONTROL_TARGETS)[number];

export const MEMORY_LIMIT_DEFAULT = 10;
export const MEMORY_LIMIT_MAX = 100;
export const UNRECOGNIZED_REQUEST = "Unrecognized control request.";

const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

export const settingsPatchSchema = z.record(z.string(), jsonValueSchema);

const limitSchema = z
  .number()
  .int()
  .min(1)
  .max(MEMORY_LIMIT_MAX)
  .default(MEMORY_LIMIT_DEFAULT);
const sessionLimitSchema = z
  .number()
  .int()
  .min(1)
  .max(SESSIONS_LIMIT_MAX)
  .default(SESSIONS_LIMIT_DEFAULT);
const nonBlank = z.string().refine((value) => value.trim() !== "", "must not be blank");
const targetSchema = z.enum(CONTROL_TARGETS);
const promptAgentSchema = z.enum(PROMPT_AGENTS);
const sessionAgentSchema = z.enum(SESSION_AGENTS);

export const controlRequestSchema = z.discriminatedUnion("cmd", [
  z.object({ cmd: z.literal("status") }).strict(),
  z.object({ cmd: z.literal("version") }).strict(),
  z.object({ cmd: z.literal("pause"), agent: targetSchema }).strict(),
  z.object({ cmd: z.literal("resume"), agent: targetSchema }).strict(),
  z
    .object({
      cmd: z.literal("drain"),
      timeoutMs: z.number().int().positive().max(DRAIN_TIMEOUT_MAX_MS).optional(),
    })
    .strict(),
  z.object({ cmd: z.literal("settings.get") }).strict(),
  z.object({ cmd: z.literal("settings.patch"), patch: settingsPatchSchema }).strict(),
  z
    .object({ cmd: z.literal("tasks.list"), status: z.enum(TASK_STATUSES).optional() })
    .strict(),
  z
    .object({
      cmd: z.literal("tasks.add"),
      description: nonBlank,
      id: nonBlank.optional(),
      title: nonBlank.optional(),
    })
    .strict(),
  z.object({ cmd: z.literal("tasks.retry"), id: nonBlank }).strict(),
  z.object({ cmd: z.literal("tasks.cancel"), id: nonBlank }).strict(),
  z
    .object({ cmd: z.literal("memory.search"), query: nonBlank, limit: limitSchema })
    .strict(),
  z.object({ cmd: z.literal("memory.recent"), limit: limitSchema }).strict(),
  z.object({ cmd: z.literal("prompt.get"), agent: promptAgentSchema }).strict(),
  z
    .object({ cmd: z.literal("prompt.set"), agent: promptAgentSchema, content: nonBlank })
    .strict(),
  z.object({ cmd: z.literal("context.get") }).strict(),
  z
    .object({ cmd: z.literal("context.set"), content: z.string().max(1_000_000) })
    .strict(),
  z
    .object({
      cmd: z.literal("sessions.list"),
      agent: sessionAgentSchema.optional(),
      taskId: nonBlank.optional(),
      before: z.iso.datetime().optional(),
      limit: sessionLimitSchema,
    })
    .strict(),
  z.object({ cmd: z.literal("sessions.get"), sessionId: nonBlank }).strict(),
]);

export type ControlRequest = z.infer<typeof controlRequestSchema>;
export type ControlRequestInput = z.input<typeof controlRequestSchema>;
export type ControlCommand = ControlRequest["cmd"];

export const CONTROL_COMMANDS: readonly ControlCommand[] =
  controlRequestSchema.options.map((option) => option.shape.cmd.value);

export interface PromptContent {
  agent: PromptAgent;
  content: string;
}

export interface ContextContent {
  content: string;
}

export interface DrainAck {
  state: "draining";
  since: string;
  until: string | undefined;
}

export interface ControlResponseData {
  status: ControlStatus;
  version: WorkerIdentity;
  pause: undefined;
  resume: undefined;
  drain: DrainAck;
  "settings.get": Settings;
  "settings.patch": Settings;
  "tasks.list": Task[];
  "tasks.add": Task;
  "tasks.retry": boolean;
  "tasks.cancel": boolean;
  "memory.search": TaskSummaryRecord[];
  "memory.recent": TaskSummaryRecord[];
  "prompt.get": PromptContent;
  "prompt.set": undefined;
  "context.get": ContextContent;
  "context.set": undefined;
  "sessions.list": SessionRecord[];
  "sessions.get": SessionRecord;
}

export interface ControlSuccess<C extends ControlCommand> {
  ok: true;
  data: ControlResponseData[C];
}

export interface ControlFailure {
  ok: false;
  error: string;
}

export type ControlResponse<C extends ControlCommand = ControlCommand> =
  ControlSuccess<C> | ControlFailure;

export type ParsedControlRequest =
  { ok: true; request: ControlRequest } | { ok: false; error: string };

function isKnownCommand(value: unknown): value is ControlCommand {
  return (
    typeof value === "string" && (CONTROL_COMMANDS as readonly string[]).includes(value)
  );
}

export function parseControlRequest(line: string): ParsedControlRequest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { ok: false, error: UNRECOGNIZED_REQUEST };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: UNRECOGNIZED_REQUEST };
  }
  const { cmd } = parsed as Record<string, unknown>;
  if (!isKnownCommand(cmd)) return { ok: false, error: UNRECOGNIZED_REQUEST };
  const result = controlRequestSchema.safeParse(parsed);
  if (result.success) return { ok: true, request: result.data };
  const issue = result.error.issues[0];
  const path = issue?.path.map(String).join(".") ?? "";
  const message = issue?.message ?? "invalid payload";
  return {
    ok: false,
    error: `Invalid ${cmd} request: ${path === "" ? "(root)" : path}: ${message}`,
  };
}

export interface ControlPhase {
  kind: string;
  since?: string | undefined;
  until?: string | undefined;
  cycle?: number | undefined;
  taskId?: string | undefined;
  title?: string | undefined;
  reason?: string | undefined;
}

export interface ControlAgentStatus<Outcome> {
  phase: ControlPhase;
  control: AgentControlState;
  recentOutcomes: Outcome[];
}

export type AuthKind = "oauth" | "apiKey" | "claude.ai" | "unknown";

export interface WorkerIdentity {
  version: string;
  claudeVersion?: string | undefined;
  nodeVersion: string;
  pid: number;
  startedAt: string;
  projectDir: string;
  authKind: AuthKind;
}

export interface ControlDrainStatus {
  since: string;
  until?: string | undefined;
  reason: DrainReason;
}

export interface ControlStatus extends WorkerIdentity {
  headless: boolean;
  agents: {
    monitor: ControlAgentStatus<MonitorCycleOutcome>;
    executor: ControlAgentStatus<ExecutorTaskOutcome>;
  };
  stats: WorkerStats;
  taskCounts: Record<TaskStatus, number>;
  drain?: ControlDrainStatus | undefined;
}

function iso(epochMs: number): string {
  return new Date(epochMs).toISOString();
}

function isoOrUndefined(epochMs: number | undefined): string | undefined {
  return epochMs === undefined ? undefined : iso(epochMs);
}

export function buildDrainAck(snapshot: DrainSnapshot): DrainAck {
  return {
    state: "draining",
    since: iso(snapshot.since),
    until: isoOrUndefined(snapshot.until),
  };
}

function serializeDrain(snapshot: DrainSnapshot): ControlDrainStatus {
  return {
    since: iso(snapshot.since),
    until: isoOrUndefined(snapshot.until),
    reason: snapshot.reason,
  };
}

function serializeMonitorPhase(phase: MonitorPhase): ControlPhase {
  switch (phase.kind) {
    case "starting":
      return { kind: phase.kind };
    case "offHours":
    case "limitWait":
      return { kind: phase.kind, until: iso(phase.resumeAt) };
    case "authBlocked":
      return { kind: phase.kind, since: iso(phase.since), reason: phase.reason };
    case "session":
      return { kind: phase.kind, since: iso(phase.startedAt), cycle: phase.cycle };
    case "sleeping":
      return { kind: phase.kind, until: iso(phase.nextCycleAt) };
  }
}

function serializeExecutorPhase(phase: ExecutorPhase): ControlPhase {
  switch (phase.kind) {
    case "waiting":
      return { kind: phase.kind };
    case "limitWait":
      return { kind: phase.kind, until: iso(phase.resumeAt) };
    case "authBlocked":
      return { kind: phase.kind, since: iso(phase.since), reason: phase.reason };
    case "session":
    case "summary":
      return {
        kind: phase.kind,
        since: iso(phase.startedAt),
        taskId: phase.task.id,
        title: phase.task.title,
      };
    case "backoff":
      return {
        kind: phase.kind,
        until: iso(phase.resumeAt),
        taskId: phase.task.id,
        title: phase.task.title,
      };
  }
}

const RECENT_OUTCOMES_IN_STATUS = 5;

export interface ControlStatusContext {
  snapshot: WorkerStatus;
  identity: WorkerIdentity;
  headless: boolean;
}

export function buildControlStatus(context: ControlStatusContext): ControlStatus {
  const { snapshot } = context;
  const taskCounts: Record<TaskStatus, number> = {
    pending: 0,
    in_progress: 0,
    done: 0,
    failed: 0,
    cancelled: 0,
  };
  for (const task of snapshot.tasks) taskCounts[task.status] += 1;
  return {
    ...context.identity,
    headless: context.headless,
    agents: {
      monitor: {
        phase: serializeMonitorPhase(snapshot.monitor.phase),
        control: snapshot.monitor.control,
        recentOutcomes: snapshot.monitor.recentOutcomes.slice(
          0,
          RECENT_OUTCOMES_IN_STATUS,
        ),
      },
      executor: {
        phase: serializeExecutorPhase(snapshot.executor.phase),
        control: snapshot.executor.control,
        recentOutcomes: snapshot.executor.recentOutcomes.slice(
          0,
          RECENT_OUTCOMES_IN_STATUS,
        ),
      },
    },
    stats: snapshot.stats,
    taskCounts,
    drain: snapshot.drain === undefined ? undefined : serializeDrain(snapshot.drain),
  };
}
