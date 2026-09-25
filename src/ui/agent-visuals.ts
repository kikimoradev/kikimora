import type { AgentControlState } from "../control.js";
import type {
  AgentPanelStatus,
  ExecutorPhase,
  ExecutorTaskOutcome,
  MonitorCycleOutcome,
  MonitorPhase,
  TailLine,
} from "../status.js";
import {
  detectStall,
  formatExecutorOutcome,
  formatExecutorPhase,
  formatMonitorOutcome,
  formatMonitorPhase,
  withControl,
  withStall,
  type OutcomeLine,
  type StatusLine,
} from "./format.js";

export interface AgentPanelModel {
  status: StatusLine;
  tail: readonly TailLine[];
  outcome: OutcomeLine | undefined;
  recentOutcomes: readonly OutcomeLine[];
  emptyHint: string;
}

interface PanelSource<Outcome> {
  control: AgentControlState;
  tail: readonly TailLine[];
  lastEventAt?: number | undefined;
  lastOutcome?: Outcome | undefined;
  recentOutcomes: readonly Outcome[];
}

function buildModel<Outcome>(
  panel: PanelSource<Outcome>,
  phase: { kind: string; startedAt?: number },
  base: StatusLine,
  now: number,
  formatOutcome: (outcome: Outcome) => OutcomeLine,
  idleHint: string,
): AgentPanelModel {
  const running = phase.kind === "session" || phase.kind === "summary";
  const stall =
    running && phase.startedAt !== undefined
      ? detectStall(phase.startedAt, panel.lastEventAt, now)
      : undefined;
  const status = withControl(panel.control, phase.kind, withStall(base, stall));
  return {
    status,
    tail: panel.tail,
    outcome:
      panel.lastOutcome === undefined ? undefined : formatOutcome(panel.lastOutcome),
    recentOutcomes: panel.recentOutcomes.map(formatOutcome),
    emptyHint: panel.control === "running" ? idleHint : "paused — run /start to begin",
  };
}

export function monitorPanelModel(
  panel: AgentPanelStatus<MonitorPhase, MonitorCycleOutcome>,
  now: number,
): AgentPanelModel {
  return buildModel(
    panel,
    panel.phase,
    formatMonitorPhase(panel.phase, now),
    now,
    formatMonitorOutcome,
    "no activity yet — the first cycle starts shortly",
  );
}

export function executorPanelModel(
  panel: AgentPanelStatus<ExecutorPhase, ExecutorTaskOutcome>,
  now: number,
): AgentPanelModel {
  return buildModel(
    panel,
    panel.phase,
    formatExecutorPhase(panel.phase, now),
    now,
    formatExecutorOutcome,
    "no activity yet — tasks from the monitor land here",
  );
}
