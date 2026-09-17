import type { AgentController } from "./control.js";

export const DRAIN_TIMEOUT_MAX_MS = 86_400_000;

export type DrainReason = "drain" | NodeJS.Signals;

export interface DrainSnapshot {
  since: number;
  until: number | undefined;
  reason: DrainReason;
}

type DrainedAgent = Pick<AgentController, "pause" | "state">;

export interface DrainedAgents {
  monitor: DrainedAgent;
  executor: DrainedAgent;
}

export type DrainListener = (snapshot: DrainSnapshot) => void;

export class DrainController {
  private requested: DrainSnapshot | undefined;
  private deadline: NodeJS.Timeout | undefined;
  private ending: "settled" | "expired" | undefined;

  constructor(
    private readonly controls: DrainedAgents,
    private readonly abort: () => void,
    private readonly onRequested: DrainListener = () => undefined,
  ) {}

  get snapshot(): DrainSnapshot | undefined {
    return this.requested;
  }

  get settled(): boolean {
    return this.ending === "settled";
  }

  request(reason: DrainReason, timeoutMs: number | undefined): DrainSnapshot {
    if (this.requested !== undefined) return this.requested;
    const since = Date.now();
    const snapshot: DrainSnapshot = {
      since,
      until: timeoutMs === undefined ? undefined : since + timeoutMs,
      reason,
    };
    this.requested = snapshot;
    this.onRequested(snapshot);
    if (timeoutMs !== undefined) {
      this.deadline = setTimeout(() => {
        this.end("expired");
      }, timeoutMs);
      this.deadline.unref();
    }
    this.controls.monitor.pause();
    this.controls.executor.pause();
    this.noteSettled();
    return snapshot;
  }

  noteSettled(): void {
    if (this.requested === undefined) return;
    const { monitor, executor } = this.controls;
    if (monitor.state === "paused" && executor.state === "paused") this.end("settled");
  }

  dispose(): void {
    clearTimeout(this.deadline);
  }

  private end(ending: "settled" | "expired"): void {
    if (this.ending !== undefined) return;
    this.ending = ending;
    this.dispose();
    this.abort();
  }
}
