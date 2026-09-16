import type { AuthFailure } from "./auth-gate.js";
import type { AgentControlState } from "./control.js";
import type { DrainSnapshot } from "./drain.js";
import {
  describeToolUse,
  formatToolCount,
  type SessionEvent,
  type SessionEventSink,
} from "./session-events.js";
import { formatDuration } from "./timing.js";
import type { Task } from "./types.js";

export type TailTone = "ok" | "warn" | "error";

export interface TailLine {
  kind: "message" | "tool" | "result" | "meta" | "notice";
  text: string;
  tool?: string | undefined;
  cont?: boolean | undefined;
  tone?: TailTone | undefined;
  extra?: string[] | undefined;
  dropped?: number | undefined;
}

export interface AuthBlockedPhase {
  kind: "authBlocked";
  reason: string;
  since: number;
}

export type MonitorPhase =
  | { kind: "starting" }
  | { kind: "offHours"; resumeAt: number }
  | { kind: "limitWait"; resumeAt: number }
  | AuthBlockedPhase
  | { kind: "session"; cycle: number; startedAt: number }
  | { kind: "sleeping"; nextCycleAt: number };

export type ExecutorPhase =
  | { kind: "waiting" }
  | { kind: "limitWait"; resumeAt: number }
  | AuthBlockedPhase
  | { kind: "session"; task: Task; startedAt: number }
  | { kind: "summary"; task: Task; startedAt: number }
  | { kind: "backoff"; task: Task; resumeAt: number };

export interface MonitorCycleOutcome {
  cycle: number;
  ok: boolean;
  durationMs: number;
  costUsd?: number | undefined;
  addedTasks: number;
  skippedDuplicates: number;
  error?: string | undefined;
  sessionId?: string | undefined;
  finishedAt: number;
}

export interface ExecutorTaskOutcome {
  taskId: string;
  title: string;
  ok: boolean;
  durationMs: number;
  costUsd?: number | undefined;
  numTurns?: number | undefined;
  error?: string | undefined;
  willRetry?: boolean | undefined;
  attempt?: number | undefined;
  maxAttempts?: number | undefined;
  sessionId?: string | undefined;
  finishedAt: number;
}

export interface SummaryOutcome {
  taskId: string;
  ok: boolean;
  durationMs: number;
  costUsd?: number | undefined;
  error?: string | undefined;
  sessionId?: string | undefined;
  finishedAt: number;
}

export interface AgentPanelStatus<Phase, Outcome> {
  phase: Phase;
  control: AgentControlState;
  tail: readonly TailLine[];
  recentOutcomes: readonly Outcome[];
  sessionId?: string | undefined;
  lastOutcome?: Outcome | undefined;
  lastEventAt?: number | undefined;
}

export interface WorkerStats {
  cycles: number;
  tasksSucceeded: number;
  tasksFailed: number;
  totalCostUsd: number;
}

export interface UpdateStatus {
  state: "available" | "installed";
  from: string;
  to: string;
  installError?: string | undefined;
}

export interface WorkerStatus {
  startedAt: number;
  shutdownSignal?: string | undefined;
  drain?: DrainSnapshot | undefined;
  monitor: AgentPanelStatus<MonitorPhase, MonitorCycleOutcome>;
  executor: AgentPanelStatus<ExecutorPhase, ExecutorTaskOutcome>;
  tasks: readonly Task[];
  stats: WorkerStats;
  update?: UpdateStatus | undefined;
}

export interface MonitorReporter {
  offHours(resumeAt: Date): void;
  usageLimit(resumeAt: Date): void;
  authBlocked(failure: AuthFailure): void;
  cycleStarted(cycle: number): void;
  cycleFinished(outcome: Omit<MonitorCycleOutcome, "finishedAt">): void;
  sleepUntil(nextCycleAt: Date): void;
  session: SessionEventSink;
}

export interface ExecutorReporter {
  taskStarted(task: Task): void;
  taskFinished(outcome: Omit<ExecutorTaskOutcome, "finishedAt">): void;
  retryScheduled(task: Task, resumeAt: Date): void;
  usageLimit(resumeAt: Date): void;
  authBlocked(failure: AuthFailure): void;
  waiting(): void;
  summaryStarted(task: Task): void;
  summaryFinished(outcome: Omit<SummaryOutcome, "finishedAt">): void;
  session: SessionEventSink;
}

function summaryTailLine(outcome: SummaryOutcome): TailLine {
  if (!outcome.ok) {
    return {
      kind: "notice",
      tone: "error",
      text: `✖ memory summary failed (${outcome.taskId}) · ${outcome.error ?? "unknown error"}`,
    };
  }
  const cost = outcome.costUsd != null ? ` · $${outcome.costUsd.toFixed(4)}` : "";
  return {
    kind: "notice",
    tone: "ok",
    text: `✔ memory saved (${outcome.taskId}) · ${formatDuration(outcome.durationMs)}${cost}`,
  };
}

function authBlockedPhase(failure: AuthFailure): AuthBlockedPhase {
  return { kind: "authBlocked", reason: failure.reason, since: Date.now() };
}

const TAIL_LINE_MAX = 600;

function clipLine(line: string): string {
  return line.length > TAIL_LINE_MAX ? `${line.slice(0, TAIL_LINE_MAX)}…` : line;
}

interface AgentState<Phase, Outcome> {
  phase: Phase;
  control: AgentControlState;
  tail: TailLine[];
  recentOutcomes: Outcome[];
  openPartial: string;
  partialSeen: boolean;
  sessionId: string | undefined;
  lastOutcome: Outcome | undefined;
  lastEventAt: number | undefined;
}

const RECENT_OUTCOMES_LIMIT = 20;

export interface WorkerStatusStoreOptions {
  tailLimit?: number;
  notifyDelayMs?: number;
}

export class WorkerStatusStore {
  private readonly tailLimit: number;
  private readonly notifyDelayMs: number;
  private readonly startedAt = Date.now();
  private readonly listeners = new Set<() => void>();
  private notifyTimer: NodeJS.Timeout | null = null;
  private shutdownSignal: string | undefined;
  private drain: DrainSnapshot | undefined;
  private updateStatus: UpdateStatus | undefined;
  private tasks: readonly Task[] = [];
  private snapshot: WorkerStatus;

  private readonly stats: WorkerStats = {
    cycles: 0,
    tasksSucceeded: 0,
    tasksFailed: 0,
    totalCostUsd: 0,
  };

  private readonly monitorState: AgentState<MonitorPhase, MonitorCycleOutcome> = {
    phase: { kind: "starting" },
    control: "running",
    tail: [],
    recentOutcomes: [],
    openPartial: "",
    partialSeen: false,
    sessionId: undefined,
    lastOutcome: undefined,
    lastEventAt: undefined,
  };

  private readonly executorState: AgentState<ExecutorPhase, ExecutorTaskOutcome> = {
    phase: { kind: "waiting" },
    control: "running",
    tail: [],
    recentOutcomes: [],
    openPartial: "",
    partialSeen: false,
    sessionId: undefined,
    lastOutcome: undefined,
    lastEventAt: undefined,
  };

  readonly monitor: MonitorReporter = {
    offHours: (resumeAt) => {
      this.monitorState.phase = { kind: "offHours", resumeAt: resumeAt.getTime() };
      this.markDirty();
    },
    usageLimit: (resumeAt) => {
      this.monitorState.phase = { kind: "limitWait", resumeAt: resumeAt.getTime() };
      this.markDirty();
    },
    authBlocked: (failure) => {
      this.monitorState.phase = authBlockedPhase(failure);
      this.noteAuthBlocked(this.monitorState, failure);
    },
    cycleStarted: (cycle) => {
      this.resetForSession(this.monitorState, {
        kind: "session",
        cycle,
        startedAt: Date.now(),
      });
    },
    cycleFinished: (outcome) => {
      const finished = { ...outcome, finishedAt: Date.now() };
      this.monitorState.lastOutcome = finished;
      this.pushOutcome(this.monitorState, finished);
      this.stats.cycles += 1;
      this.stats.totalCostUsd += outcome.costUsd ?? 0;
      this.markDirty();
    },
    sleepUntil: (nextCycleAt) => {
      this.monitorState.phase = {
        kind: "sleeping",
        nextCycleAt: nextCycleAt.getTime(),
      };
      this.markDirty();
    },
    session: (event) => this.handleSessionEvent(this.monitorState, event),
  };

  readonly executor: ExecutorReporter = {
    taskStarted: (task) => {
      this.resetForSession(this.executorState, {
        kind: "session",
        task,
        startedAt: Date.now(),
      });
    },
    taskFinished: (outcome) => {
      const finished = { ...outcome, finishedAt: Date.now() };
      this.executorState.lastOutcome = finished;
      this.pushOutcome(this.executorState, finished);
      this.stats.totalCostUsd += outcome.costUsd ?? 0;
      if (outcome.ok) this.stats.tasksSucceeded += 1;
      else if (outcome.willRetry !== true) this.stats.tasksFailed += 1;
      this.markDirty();
    },
    retryScheduled: (task, resumeAt) => {
      this.executorState.phase = {
        kind: "backoff",
        task,
        resumeAt: resumeAt.getTime(),
      };
      this.markDirty();
    },
    usageLimit: (resumeAt) => {
      this.executorState.phase = { kind: "limitWait", resumeAt: resumeAt.getTime() };
      this.markDirty();
    },
    authBlocked: (failure) => {
      this.executorState.phase = authBlockedPhase(failure);
      this.noteAuthBlocked(this.executorState, failure);
    },
    waiting: () => {
      this.executorState.phase = { kind: "waiting" };
      this.markDirty();
    },
    summaryStarted: (task) => {
      this.executorState.phase = {
        kind: "summary",
        task,
        startedAt: Date.now(),
      };
      this.markDirty();
    },
    summaryFinished: (outcome) => {
      this.stats.totalCostUsd += outcome.costUsd ?? 0;
      this.pushTail(
        this.executorState,
        summaryTailLine({ ...outcome, finishedAt: Date.now() }),
      );
      this.markDirty();
    },
    session: (event) => this.handleSessionEvent(this.executorState, event),
  };

  constructor(options: WorkerStatusStoreOptions = {}) {
    this.tailLimit = options.tailLimit ?? 100;
    this.notifyDelayMs = options.notifyDelayMs ?? 50;
    this.snapshot = this.buildSnapshot();
  }

  setTasks(tasks: readonly Task[]): void {
    this.tasks = tasks.map((task) => ({ ...task }));
    this.markDirty();
  }

  setControl(agent: "monitor" | "executor", state: AgentControlState): void {
    const target = agent === "monitor" ? this.monitorState : this.executorState;
    target.control = state;
    this.markDirty();
  }

  shutdownRequested(signalName: string): void {
    this.shutdownSignal = signalName;
    this.markDirty();
  }

  drainRequested(snapshot: DrainSnapshot): void {
    this.drain = snapshot;
    this.markDirty();
  }

  setUpdateStatus(info: UpdateStatus): void {
    this.updateStatus = info;
    this.markDirty();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): WorkerStatus => this.snapshot;

  flush(): void {
    if (this.notifyTimer) {
      clearTimeout(this.notifyTimer);
      this.notifyTimer = null;
    }
    this.notify();
  }

  dispose(): void {
    if (this.notifyTimer) {
      clearTimeout(this.notifyTimer);
      this.notifyTimer = null;
    }
    this.listeners.clear();
  }

  private noteAuthBlocked<Phase, Outcome>(
    state: AgentState<Phase, Outcome>,
    failure: AuthFailure,
  ): void {
    this.pushTail(state, {
      kind: "notice",
      tone: "error",
      text: `⛔ authentication failed · ${failure.reason}`,
    });
    this.markDirty();
  }

  private resetForSession<Phase, Outcome>(
    state: AgentState<Phase, Outcome>,
    phase: Phase,
  ): void {
    state.phase = phase;
    state.tail = [];
    state.openPartial = "";
    state.partialSeen = false;
    state.sessionId = undefined;
    state.lastEventAt = undefined;
    this.markDirty();
  }

  private handleSessionEvent<Phase, Outcome>(
    state: AgentState<Phase, Outcome>,
    event: SessionEvent,
  ): void {
    if (event.type === "stream") return;
    state.lastEventAt = Date.now();
    if (event.type === "partial") {
      state.partialSeen = true;
      const combined = state.openPartial + event.text;
      const lines = combined.split("\n");
      state.openPartial = lines.pop() ?? "";
      for (const line of lines) {
        this.pushMessage(state, line);
      }
    } else if (event.type === "text" && state.partialSeen) {
      this.closePartial(state);
    } else {
      this.closePartial(state);
      if (event.type === "init") state.sessionId = event.sessionId;
      if (event.type !== "text") state.partialSeen = false;
      this.pushEvent(state, event);
    }
    this.markDirty();
  }

  private pushEvent<Phase, Outcome>(
    state: AgentState<Phase, Outcome>,
    event: Exclude<SessionEvent, { type: "partial" | "stream" }>,
  ): void {
    switch (event.type) {
      case "init":
        this.pushTail(state, {
          kind: "meta",
          text: `model ${event.model} · ${formatToolCount(event.toolCount)} · ${event.sessionId}`,
        });
        break;
      case "text":
        for (const line of event.text.split("\n")) this.pushMessage(state, line);
        break;
      case "toolUse": {
        const call = describeToolUse(event.name, event.input);
        this.pushTail(state, { kind: "tool", tool: call.name, text: call.detail });
        break;
      }
      case "toolResult": {
        const [first, ...extra] = event.lines;
        this.pushTail(state, {
          kind: "result",
          text: `${event.isError ? "error: " : ""}${first ?? "(no output)"}`,
          extra: extra.length > 0 ? extra : undefined,
          dropped: event.dropped > 0 ? event.dropped : undefined,
          tone: event.isError ? "error" : undefined,
        });
        break;
      }
      case "raw":
        this.pushTail(state, { kind: "meta", text: event.line });
        break;
      case "stderr":
        this.pushTail(state, { kind: "meta", text: `stderr: ${event.line}` });
        break;
      case "killing":
        this.pushTail(state, {
          kind: "notice",
          tone: "warn",
          text: `⏹ stopping session (${event.reason})…`,
        });
        break;
      case "procError":
        this.pushTail(state, {
          kind: "notice",
          tone: "error",
          text: `✖ ${event.message}`,
        });
        break;
    }
  }

  private pushMessage<Phase, Outcome>(
    state: AgentState<Phase, Outcome>,
    line: string,
  ): void {
    if (!line.trim()) return;
    const previous = state.tail.at(-1);
    this.pushTail(state, {
      kind: "message",
      text: line,
      cont: previous?.kind === "message" ? true : undefined,
    });
  }

  private closePartial<Phase, Outcome>(state: AgentState<Phase, Outcome>): void {
    this.pushMessage(state, state.openPartial);
    state.openPartial = "";
  }

  private pushOutcome<Phase, Outcome>(
    state: AgentState<Phase, Outcome>,
    outcome: Outcome,
  ): void {
    state.recentOutcomes.unshift(outcome);
    if (state.recentOutcomes.length > RECENT_OUTCOMES_LIMIT) {
      state.recentOutcomes.length = RECENT_OUTCOMES_LIMIT;
    }
  }

  private pushTail<Phase, Outcome>(
    state: AgentState<Phase, Outcome>,
    line: TailLine,
  ): void {
    state.tail.push({
      ...line,
      text: clipLine(line.text),
      extra: line.extra?.map(clipLine),
    });
    if (state.tail.length > this.tailLimit) {
      state.tail.splice(0, state.tail.length - this.tailLimit);
    }
  }

  private markDirty(): void {
    this.notifyTimer ??= setTimeout(() => {
      this.notifyTimer = null;
      this.notify();
    }, this.notifyDelayMs);
  }

  private notify(): void {
    this.snapshot = this.buildSnapshot();
    for (const listener of this.listeners) listener();
  }

  private buildSnapshot(): WorkerStatus {
    return {
      startedAt: this.startedAt,
      shutdownSignal: this.shutdownSignal,
      drain: this.drain,
      monitor: this.buildPanel(this.monitorState),
      executor: this.buildPanel(this.executorState),
      tasks: this.tasks,
      stats: { ...this.stats },
      update: this.updateStatus,
    };
  }

  private buildPanel<Phase, Outcome>(
    state: AgentState<Phase, Outcome>,
  ): AgentPanelStatus<Phase, Outcome> {
    const tail: TailLine[] = [...state.tail];
    if (state.openPartial.trim()) {
      tail.push({
        kind: "message",
        text: clipLine(state.openPartial),
        cont: tail.at(-1)?.kind === "message" ? true : undefined,
      });
    }
    return {
      phase: state.phase,
      control: state.control,
      tail,
      recentOutcomes: [...state.recentOutcomes],
      sessionId: state.sessionId,
      lastOutcome: state.lastOutcome,
      lastEventAt: state.lastEventAt,
    };
  }
}
