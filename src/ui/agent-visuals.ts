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
  formatControlLabel,
  formatExecutorOutcome,
  formatExecutorPhase,
  formatMonitorOutcome,
  formatMonitorPhase,
} from "./format.js";
import { theme } from "./theme.js";

export interface AgentPanelModel {
  phaseLabel: string;
  phaseColor: string;
  tail: readonly TailLine[];
  outcomeLabel: string | undefined;
  outcomeColor: string;
  recentOutcomeLabels: readonly string[];
}

function stallFor(
  phase: { kind: string; startedAt?: number },
  lastEventAt: number | undefined,
  now: number,
): string | undefined {
  if (phase.startedAt === undefined) return undefined;
  return detectStall(phase.startedAt, lastEventAt, now);
}

function buildModel(
  panel: {
    control: AgentControlState;
    tail: readonly TailLine[];
    lastEventAt?: number | undefined;
  },
  phase: { kind: string; startedAt?: number },
  phaseText: string,
  now: number,
  outcomeLabel: string | undefined,
  outcomeColor: string,
  recentOutcomeLabels: readonly string[],
): AgentPanelModel {
  const stall =
    phase.kind === "session" || phase.kind === "summary"
      ? stallFor(phase, panel.lastEventAt, now)
      : undefined;
  const stalledLabel = stall === undefined ? phaseText : `${phaseText} · ${stall}`;
  const controlLabel = formatControlLabel(panel.control, phase.kind, stalledLabel);
  return {
    phaseLabel: controlLabel ?? stalledLabel,
    phaseColor:
      controlLabel !== undefined || stall !== undefined
        ? theme.warn
        : phaseColor(phase.kind),
    tail: panel.tail,
    outcomeLabel,
    outcomeColor,
    recentOutcomeLabels,
  };
}

export function phaseColor(kind: string): string {
  switch (kind) {
    case "session":
    case "summary":
      return theme.info;
    case "backoff":
    case "limitWait":
      return theme.warn;
    case "authBlocked":
      return theme.error;
    default:
      return theme.muted;
  }
}

export function outcomeColor(ok: boolean | undefined): string {
  return ok === false ? theme.error : theme.ok;
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
    panel.lastOutcome && formatMonitorOutcome(panel.lastOutcome),
    outcomeColor(panel.lastOutcome?.ok),
    panel.recentOutcomes.map(formatMonitorOutcome),
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
    panel.lastOutcome && formatExecutorOutcome(panel.lastOutcome),
    panel.lastOutcome?.willRetry ? theme.warn : outcomeColor(panel.lastOutcome?.ok),
    panel.recentOutcomes.map(formatExecutorOutcome),
  );
}
