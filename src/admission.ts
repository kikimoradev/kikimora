import { randomUUID } from "node:crypto";

export const ADMISSION_MODES = ["local", "external"] as const;
export type AdmissionMode = (typeof ADMISSION_MODES)[number];

export const ADMISSION_ROLES = ["monitor", "executor"] as const;
export type AdmissionRole = (typeof ADMISSION_ROLES)[number];

export const ADMISSION_ENV = "KIKIMORA_ADMISSION";

export function parseAdmissionMode(raw: string | undefined): AdmissionMode | null {
  const value = raw?.trim().toLowerCase() ?? "";
  if (value === "" || value === "local") return "local";
  if (value === "external") return "external";
  return null;
}

export interface AdmissionWait {
  ticket: string;
  since: number;
  seq: number;
}

export type AdmissionSlot =
  | { state: "idle"; seq: number }
  | {
      state: "waiting" | "holding";
      ticket: string;
      since: number;
      seq: number;
      taskId?: string | undefined;
    };

export interface AdmissionChange {
  kind: "granted" | "released" | "cancelled";
  role: AdmissionRole;
  ticket: string;
  seq: number;
}

export type AdmissionGrantOutcome =
  { granted: true } | { granted: false; reason: "local" | "stale" };

export interface AdmissionLease {
  release(): void;
}

export interface AdmissionRequest {
  signal: AbortSignal;
  interrupted(until: AbortSignal): Promise<void>;
  taskId?: string | undefined;
  onWait(wait: AdmissionWait): void;
}

export interface AdmissionStatus {
  mode: AdmissionMode;
  monitor: AdmissionSlot;
  executor: AdmissionSlot;
}

const LOCAL_LEASE: AdmissionLease = { release: () => undefined };

export class AdmissionGate {
  private seq = 0;
  private readonly slots: Record<AdmissionRole, AdmissionSlot> = {
    monitor: { state: "idle", seq: 0 },
    executor: { state: "idle", seq: 0 },
  };
  private readonly wakers = new Map<AdmissionRole, () => void>();

  constructor(
    readonly mode: AdmissionMode,
    private readonly onChange: (change: AdmissionChange) => void = () => undefined,
    private readonly newTicket: () => string = randomUUID,
  ) {}

  status(): AdmissionStatus {
    return {
      mode: this.mode,
      monitor: { ...this.slots.monitor },
      executor: { ...this.slots.executor },
    };
  }

  async acquire(
    role: AdmissionRole,
    request: AdmissionRequest,
  ): Promise<AdmissionLease | null> {
    if (this.mode === "local") return LOCAL_LEASE;
    if (request.signal.aborted) return null;

    const ticket = this.newTicket();
    const since = Date.now();
    const seq = this.nextSeq();
    this.slots[role] = { state: "waiting", ticket, since, seq, taskId: request.taskId };
    request.onWait({ ticket, since, seq });

    await this.waitForGrant(role, request);

    const slot = this.slots[role];
    if (slot.state === "holding" && slot.ticket === ticket) {
      return this.leaseOf(role, ticket);
    }
    if (slot.state === "waiting" && slot.ticket === ticket) {
      this.settle(role, "cancelled", ticket);
    }
    return null;
  }

  grant(role: AdmissionRole, ticket: string): AdmissionGrantOutcome {
    if (this.mode === "local") return { granted: false, reason: "local" };
    const slot = this.slots[role];
    if (slot.state === "idle" || slot.ticket !== ticket) {
      return { granted: false, reason: "stale" };
    }
    if (slot.state === "holding") return { granted: true };
    const seq = this.nextSeq();
    this.slots[role] = { ...slot, state: "holding", seq };
    this.onChange({ kind: "granted", role, ticket, seq });
    this.wakers.get(role)?.();
    return { granted: true };
  }

  private waitForGrant(role: AdmissionRole, request: AdmissionRequest): Promise<void> {
    return new Promise((resolvePromise) => {
      const done = new AbortController();
      const finish = (): void => {
        if (done.signal.aborted) return;
        done.abort();
        request.signal.removeEventListener("abort", finish);
        if (this.wakers.get(role) === finish) this.wakers.delete(role);
        resolvePromise();
      };
      this.wakers.set(role, finish);
      request.signal.addEventListener("abort", finish, { once: true });
      void request.interrupted(done.signal).then(finish);
    });
  }

  private leaseOf(role: AdmissionRole, ticket: string): AdmissionLease {
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        const slot = this.slots[role];
        if (slot.state === "holding" && slot.ticket === ticket) {
          this.settle(role, "released", ticket);
        }
      },
    };
  }

  private settle(
    role: AdmissionRole,
    kind: "released" | "cancelled",
    ticket: string,
  ): void {
    const seq = this.nextSeq();
    this.slots[role] = { state: "idle", seq };
    this.onChange({ kind, role, ticket, seq });
  }

  private nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }
}
