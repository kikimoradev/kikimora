import { formatResume } from "../active-hours.js";
import type { AgentControlState } from "../control.js";
import type { DrainSnapshot } from "../drain.js";
import type {
  ExecutorPhase,
  ExecutorTaskOutcome,
  MonitorCycleOutcome,
  MonitorPhase,
  WorkerStats,
} from "../status.js";
import type { Task, TaskStatus } from "../types.js";
import { formatCost, formatElapsed, formatUptime } from "../units.js";
import { glyphs, type Tone } from "./theme.js";

export { formatCost, formatElapsed, formatUptime } from "../units.js";

const STALL_THRESHOLD_MS = 120_000;
const DAY_MS = 86_400_000;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

export interface StatusLine {
  glyph: string;
  tone: Tone;
  text: string;
  aside?: string | undefined;
  busy: boolean;
}

export interface OutcomeLine {
  glyph: string;
  tone: Tone;
  text: string;
  meta: string;
}

function pad2(value: number): string {
  return value.toString().padStart(2, "0");
}

export function plural(count: number, singular: string, pluralForm: string): string {
  return count === 1 ? singular : pluralForm;
}

export function countLabel(count: number, singular: string, pluralForm: string): string {
  return `${String(count)} ${plural(count, singular, pluralForm)}`;
}

export function formatCountdown(msLeft: number): string {
  const total = Math.max(0, Math.ceil(msLeft / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${pad2(m)}:${pad2(s)}` : `${pad2(m)}:${pad2(s)}`;
}

export function formatInterval(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const parts: string[] = [];
  if (h > 0) parts.push(`${h} h`);
  if (m > 0) parts.push(`${m} min`);
  if (s > 0 || parts.length === 0) parts.push(`${s} s`);
  return parts.join(" ");
}

function startOfDay(timestamp: number): number {
  const date = new Date(timestamp);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

export function formatWhen(at: number, now: number): string {
  const date = new Date(at);
  const time = `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
  const days = Math.round((startOfDay(at) - startOfDay(now)) / DAY_MS);
  if (days === 0) return time;
  if (days === 1) return `tomorrow ${time}`;
  if (days > 1 && days < 7) return `${WEEKDAYS[date.getDay()] ?? ""} ${time}`;
  return formatResume(date);
}

function resumeAside(resumeAt: number, now: number): string {
  return `resumes ${formatWhen(resumeAt, now)} · in ${formatCountdown(resumeAt - now)}`;
}

function limitWait(resumeAt: number, now: number): StatusLine {
  return {
    glyph: glyphs.warn,
    tone: "warn",
    text: "usage limit reached",
    aside: resumeAside(resumeAt, now),
    busy: false,
  };
}

function authBlocked(reason: string): StatusLine {
  return {
    glyph: glyphs.error,
    tone: "error",
    text: `authentication failed · ${reason} · fix credentials, then /start`,
    busy: false,
  };
}

export function formatMonitorPhase(phase: MonitorPhase, now: number): StatusLine {
  switch (phase.kind) {
    case "starting":
      return { glyph: glyphs.active, tone: "info", text: "starting…", busy: true };
    case "offHours":
      return {
        glyph: glyphs.paused,
        tone: "muted",
        text: "outside working hours",
        aside: resumeAside(phase.resumeAt, now),
        busy: false,
      };
    case "limitWait":
      return limitWait(phase.resumeAt, now);
    case "authBlocked":
      return authBlocked(phase.reason);
    case "session":
      return {
        glyph: glyphs.active,
        tone: "info",
        text: `cycle #${phase.cycle}`,
        aside: formatElapsed(now - phase.startedAt),
        busy: true,
      };
    case "sleeping":
      return {
        glyph: glyphs.idle,
        tone: "muted",
        text: "next cycle",
        aside: `in ${formatCountdown(phase.nextCycleAt - now)}`,
        busy: false,
      };
  }
}

export function formatExecutorPhase(phase: ExecutorPhase, now: number): StatusLine {
  switch (phase.kind) {
    case "waiting":
      return {
        glyph: glyphs.idle,
        tone: "muted",
        text: "waiting for tasks",
        busy: false,
      };
    case "limitWait":
      return limitWait(phase.resumeAt, now);
    case "authBlocked":
      return authBlocked(phase.reason);
    case "session":
      return {
        glyph: glyphs.active,
        tone: "info",
        text: `${phase.task.id} · ${phase.task.title}`,
        aside: formatElapsed(now - phase.startedAt),
        busy: true,
      };
    case "summary":
      return {
        glyph: glyphs.summary,
        tone: "info",
        text: `summarizing ${phase.task.id} to memory`,
        aside: formatElapsed(now - phase.startedAt),
        busy: true,
      };
    case "backoff":
      return {
        glyph: glyphs.retry,
        tone: "warn",
        text: `retrying ${phase.task.id}`,
        aside: `in ${formatCountdown(phase.resumeAt - now)}`,
        busy: false,
      };
  }
}

export function detectStall(
  startedAt: number,
  lastEventAt: number | undefined,
  now: number,
): string | undefined {
  const idleMs = now - (lastEventAt ?? startedAt);
  if (idleMs < STALL_THRESHOLD_MS) return undefined;
  return `no output for ${formatInterval(idleMs)}`;
}

export function withStall(line: StatusLine, stall: string | undefined): StatusLine {
  if (stall === undefined) return line;
  return {
    ...line,
    glyph: glyphs.warn,
    tone: "warn",
    text: `${line.text} · ${stall}`,
    busy: false,
  };
}

export function withControl(
  control: AgentControlState,
  phaseKind: string,
  line: StatusLine,
): StatusLine {
  if (control === "running" || phaseKind === "authBlocked") return line;
  if (control === "paused") {
    return { glyph: glyphs.paused, tone: "warn", text: "paused", busy: false };
  }
  if (phaseKind === "session" || phaseKind === "summary") {
    return { ...line, tone: "warn", text: `finishing · ${line.text}` };
  }
  return { glyph: glyphs.paused, tone: "warn", text: "pausing…", busy: false };
}

export function formatDrainNotice(drain: DrainSnapshot, now: number): string {
  const deadline =
    drain.until === undefined
      ? ""
      : ` · stops in ${formatCountdown(drain.until - now)} at the latest`;
  return `draining — exits after the current session${deadline}`;
}

export function formatHeaderStats(stats: WorkerStats, uptimeMs: number): string {
  return [
    `${glyphs.uptime} ${formatUptime(uptimeMs)}`,
    formatCost(stats.totalCostUsd),
    countLabel(stats.cycles, "cycle", "cycles"),
  ].join(" · ");
}

export function countTasks(tasks: readonly Task[]): Record<TaskStatus, number> {
  const counts: Record<TaskStatus, number> = {
    pending: 0,
    in_progress: 0,
    done: 0,
    failed: 0,
    cancelled: 0,
  };
  for (const task of tasks) counts[task.status] += 1;
  return counts;
}

export function formatAge(isoDate: string, now: number): string {
  const timestamp = Date.parse(isoDate);
  if (Number.isNaN(timestamp)) return "";
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function outcomeMeta(durationMs: number, costUsd: number | undefined): string {
  const duration = formatElapsed(durationMs);
  return costUsd == null ? duration : `${duration} · ${formatCost(costUsd)}`;
}

export function formatMonitorOutcome(outcome: MonitorCycleOutcome): OutcomeLine {
  const meta = outcomeMeta(outcome.durationMs, outcome.costUsd);
  const cycle = `cycle #${outcome.cycle}`;
  if (!outcome.ok) {
    return {
      glyph: glyphs.error,
      tone: "error",
      text: `${cycle} · ${outcome.error ?? "unknown error"}`,
      meta,
    };
  }
  const parts = [
    cycle,
    outcome.addedTasks > 0
      ? `+${countLabel(outcome.addedTasks, "task", "tasks")}`
      : "no new tasks",
  ];
  if (outcome.skippedDuplicates > 0) {
    parts.push(
      `${countLabel(outcome.skippedDuplicates, "duplicate", "duplicates")} skipped`,
    );
  }
  return { glyph: glyphs.ok, tone: "ok", text: parts.join(" · "), meta };
}

export function formatExecutorOutcome(outcome: ExecutorTaskOutcome): OutcomeLine {
  const meta = outcomeMeta(outcome.durationMs, outcome.costUsd);
  const error = outcome.error ?? "unknown error";
  if (outcome.willRetry) {
    const attempts =
      outcome.attempt != null && outcome.maxAttempts != null
        ? `retry ${outcome.attempt}/${outcome.maxAttempts}`
        : "retry";
    return {
      glyph: glyphs.retry,
      tone: "warn",
      text: `${outcome.taskId} · ${error} · ${attempts}`,
      meta,
    };
  }
  if (!outcome.ok) {
    return {
      glyph: glyphs.error,
      tone: "error",
      text: `${outcome.taskId} · ${error}`,
      meta,
    };
  }
  const text =
    outcome.numTurns != null
      ? `${outcome.taskId} · ${countLabel(outcome.numTurns, "turn", "turns")}`
      : outcome.taskId;
  return { glyph: glyphs.ok, tone: "ok", text, meta };
}
