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
import { formatDuration } from "../timing.js";
import type { Task, TaskStatus } from "../types.js";

const STALL_THRESHOLD_MS = 120_000;

function pad2(value: number): string {
  return value.toString().padStart(2, "0");
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

function formatLimitWait(resumeAt: number, now: number): string {
  return `⛔ usage limit reached · resume ${formatResume(new Date(resumeAt))} (in ${formatCountdown(resumeAt - now)})`;
}

function formatAuthBlocked(reason: string): string {
  return `⛔ authentication failed · ${reason} · fix credentials, then /start`;
}

export function formatMonitorPhase(phase: MonitorPhase, now: number): string {
  switch (phase.kind) {
    case "starting":
      return "starting…";
    case "offHours":
      return `⏸ outside working hours · resume ${formatResume(new Date(phase.resumeAt))} (in ${formatCountdown(phase.resumeAt - now)})`;
    case "limitWait":
      return formatLimitWait(phase.resumeAt, now);
    case "authBlocked":
      return formatAuthBlocked(phase.reason);
    case "session":
      return `▶ cycle #${phase.cycle} · running ${formatDuration(now - phase.startedAt)}`;
    case "sleeping":
      return `⏳ next cycle in ${formatCountdown(phase.nextCycleAt - now)}`;
  }
}

export function formatExecutorPhase(phase: ExecutorPhase, now: number): string {
  switch (phase.kind) {
    case "waiting":
      return "⏳ waiting for tasks";
    case "limitWait":
      return formatLimitWait(phase.resumeAt, now);
    case "authBlocked":
      return formatAuthBlocked(phase.reason);
    case "session":
      return `▶ ${phase.task.id}: ${phase.task.title} · running ${formatDuration(now - phase.startedAt)}`;
    case "summary":
      return `✎ summarizing ${phase.task.id} to memory · running ${formatDuration(now - phase.startedAt)}`;
    case "backoff":
      return `↻ retrying ${phase.task.id} in ${formatCountdown(phase.resumeAt - now)}`;
  }
}

export function detectStall(
  startedAt: number,
  lastEventAt: number | undefined,
  now: number,
): string | undefined {
  const idleMs = now - (lastEventAt ?? startedAt);
  if (idleMs < STALL_THRESHOLD_MS) return undefined;
  return `⚠ no output for ${formatInterval(idleMs)}`;
}

export function formatControlLabel(
  control: AgentControlState,
  phaseKind: string,
  phaseLabel: string,
): string | undefined {
  if (control === "running" || phaseKind === "authBlocked") return undefined;
  if (control === "paused") return "⏸ paused";
  return phaseKind === "session" || phaseKind === "summary"
    ? `⏸ finishing · ${phaseLabel}`
    : "⏸ pausing…";
}

export function formatDrainNotice(drain: DrainSnapshot, now: number): string {
  const deadline =
    drain.until === undefined
      ? ""
      : ` · stops in ${formatCountdown(drain.until - now)} at the latest`;
  return `⏏ draining — exits after the current session${deadline}`;
}

export function formatHeaderStats(
  stats: WorkerStats,
  tasks: readonly Task[],
  uptimeMs: number,
): string {
  const count = (status: TaskStatus): number =>
    tasks.filter((task) => task.status === status).length;
  return (
    `↑ ${formatInterval(uptimeMs)} · $${stats.totalCostUsd.toFixed(2)}` +
    ` · ${stats.cycles} cycles` +
    ` · tasks ${count("pending")} pending / ${count("in_progress")} running` +
    ` / ${count("done")} done / ${count("failed")} failed`
  );
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

function formatCost(costUsd: number | undefined): string {
  return costUsd != null ? ` · $${costUsd.toFixed(4)}` : "";
}

function plural(count: number, singular: string, pluralForm: string): string {
  return count === 1 ? singular : pluralForm;
}

export function formatMonitorOutcome(outcome: MonitorCycleOutcome): string {
  const base = `cycle #${outcome.cycle} · ${formatDuration(outcome.durationMs)}${formatCost(outcome.costUsd)}`;
  if (!outcome.ok) return `✖ ${base} · ${outcome.error ?? "unknown error"}`;
  const added =
    outcome.addedTasks > 0
      ? `+${outcome.addedTasks} ${plural(outcome.addedTasks, "task", "tasks")}`
      : "no new tasks";
  const duplicates =
    outcome.skippedDuplicates > 0
      ? ` · ${outcome.skippedDuplicates} ${plural(outcome.skippedDuplicates, "duplicate", "duplicates")} skipped`
      : "";
  return `✔ ${base} · ${added}${duplicates}`;
}

export function formatExecutorOutcome(outcome: ExecutorTaskOutcome): string {
  const base = `${outcome.taskId} · ${formatDuration(outcome.durationMs)}${formatCost(outcome.costUsd)}`;
  if (outcome.willRetry) {
    const attempts =
      outcome.attempt != null && outcome.maxAttempts != null
        ? ` · retry ${outcome.attempt}/${outcome.maxAttempts}`
        : " · retry";
    return `↻ ${base} · ${outcome.error ?? "unknown error"}${attempts}`;
  }
  if (!outcome.ok) return `✖ ${base} · ${outcome.error ?? "unknown error"}`;
  const turns =
    outcome.numTurns != null
      ? ` · ${outcome.numTurns} ${plural(outcome.numTurns, "turn", "turns")}`
      : "";
  return `✔ ${base}${turns}`;
}
