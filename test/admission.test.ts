import { describe, expect, it, vi } from "vitest";
import {
  AdmissionGate,
  parseAdmissionMode,
  type AdmissionChange,
  type AdmissionRequest,
  type AdmissionWait,
} from "../src/admission.js";

function sequentialTickets(): () => string {
  let next = 0;
  return () => {
    next += 1;
    return `ticket-${String(next)}`;
  };
}

function externalGate() {
  const changes: AdmissionChange[] = [];
  const gate = new AdmissionGate(
    "external",
    (change) => {
      changes.push(change);
    },
    sequentialTickets(),
  );
  return { gate, changes };
}

interface Interruption {
  promise: Promise<void>;
  interrupt(): void;
}

function interruption(): Interruption {
  let interrupt: () => void = () => undefined;
  const promise = new Promise<void>((resolvePromise) => {
    interrupt = resolvePromise;
  });
  return { promise, interrupt };
}

function request(
  overrides: Partial<AdmissionRequest> = {},
): AdmissionRequest & { waits: AdmissionWait[] } {
  const waits: AdmissionWait[] = [];
  return {
    signal: new AbortController().signal,
    interrupted: () => new Promise<void>(() => undefined),
    onWait: (wait) => {
      waits.push(wait);
    },
    ...overrides,
    waits,
  };
}

describe("parseAdmissionMode", () => {
  it("defaults to local and accepts the two modes in any case", () => {
    expect(parseAdmissionMode(undefined)).toBe("local");
    expect(parseAdmissionMode("")).toBe("local");
    expect(parseAdmissionMode(" Local ")).toBe("local");
    expect(parseAdmissionMode("EXTERNAL")).toBe("external");
  });

  it("rejects anything else", () => {
    expect(parseAdmissionMode("queue")).toBeNull();
  });
});

describe("AdmissionGate in local mode", () => {
  it("admits at once, reports nothing and refuses grants", async () => {
    const onChange = vi.fn();
    const gate = new AdmissionGate("local", onChange);
    const wanted = request();

    const lease = await gate.acquire("monitor", wanted);
    const spawnedSeq = lease?.spawned(4242);
    lease?.exited(4242);
    lease?.release();

    expect(lease).not.toBeNull();
    expect(lease?.ticket).toBeUndefined();
    expect(spawnedSeq).toBeUndefined();
    expect(wanted.waits).toEqual([]);
    expect(onChange).not.toHaveBeenCalled();
    expect(gate.grant("monitor", "anything")).toEqual({
      granted: false,
      reason: "local",
    });
    expect(gate.status()).toEqual({
      mode: "local",
      monitor: { state: "idle", seq: 0 },
      executor: { state: "idle", seq: 0 },
    });
  });
});

describe("AdmissionGate in external mode", () => {
  it("waits for a grant of its own ticket, then holds until released", async () => {
    const { gate, changes } = externalGate();
    const wanted = request({ taskId: "t-1" });

    const acquiring = gate.acquire("executor", wanted);
    expect(wanted.waits).toEqual([
      { ticket: "ticket-1", since: expect.any(Number) as number, seq: 1 },
    ]);
    expect(gate.status().executor).toMatchObject({
      state: "waiting",
      ticket: "ticket-1",
      taskId: "t-1",
      seq: 1,
    });
    expect(gate.grant("executor", "ticket-0")).toEqual({
      granted: false,
      reason: "stale",
    });
    expect(gate.grant("monitor", "ticket-1")).toEqual({
      granted: false,
      reason: "stale",
    });

    expect(gate.grant("executor", "ticket-1")).toEqual({ granted: true });
    const lease = await acquiring;
    expect(gate.status().executor).toMatchObject({ state: "holding", seq: 2 });
    expect(gate.grant("executor", "ticket-1")).toEqual({ granted: true });

    lease?.release();
    lease?.release();

    expect(gate.status().executor).toEqual({ state: "idle", seq: 3 });
    expect(changes).toEqual([
      { kind: "granted", role: "executor", ticket: "ticket-1", seq: 2 },
      { kind: "released", role: "executor", ticket: "ticket-1", seq: 3 },
    ]);
    expect(gate.grant("executor", "ticket-1")).toEqual({
      granted: false,
      reason: "stale",
    });
  });

  it("cancels the wait when interrupted", async () => {
    const { gate, changes } = externalGate();
    const pause = interruption();

    const acquiring = gate.acquire(
      "monitor",
      request({ interrupted: () => pause.promise }),
    );
    pause.interrupt();

    expect(await acquiring).toBeNull();
    expect(gate.status().monitor).toEqual({ state: "idle", seq: 2 });
    expect(changes).toEqual([
      { kind: "cancelled", role: "monitor", ticket: "ticket-1", seq: 2 },
    ]);
    expect(gate.grant("monitor", "ticket-1")).toEqual({
      granted: false,
      reason: "stale",
    });
  });

  it("lets go of the interruption once the wait ends", async () => {
    const { gate } = externalGate();
    let until: AbortSignal | undefined;

    const acquiring = gate.acquire(
      "monitor",
      request({
        interrupted: (signal) => {
          until = signal;
          return new Promise<void>(() => undefined);
        },
      }),
    );
    expect(until?.aborted).toBe(false);
    gate.grant("monitor", "ticket-1");
    await acquiring;

    expect(until?.aborted).toBe(true);
  });

  it("cancels the wait on abort", async () => {
    const { gate, changes } = externalGate();
    const abort = new AbortController();

    const acquiring = gate.acquire("monitor", request({ signal: abort.signal }));
    abort.abort();

    expect(await acquiring).toBeNull();
    expect(changes.map((change) => change.kind)).toEqual(["cancelled"]);
  });

  it("keeps a grant that lands together with an interruption", async () => {
    const { gate } = externalGate();
    const pause = interruption();

    const acquiring = gate.acquire(
      "monitor",
      request({ interrupted: () => pause.promise }),
    );
    gate.grant("monitor", "ticket-1");
    pause.interrupt();

    const lease = await acquiring;
    expect(lease).not.toBeNull();
    expect(gate.status().monitor.state).toBe("holding");
    lease?.release();
    expect(gate.status().monitor.state).toBe("idle");
  });

  it("does not wait when the signal is already aborted", async () => {
    const { gate, changes } = externalGate();
    const abort = new AbortController();
    abort.abort();
    const wanted = request({ signal: abort.signal });

    expect(await gate.acquire("monitor", wanted)).toBeNull();
    expect(wanted.waits).toEqual([]);
    expect(changes).toEqual([]);
  });

  it("keeps the roles apart and numbers every change in one sequence", async () => {
    const { gate } = externalGate();

    const monitor = gate.acquire("monitor", request());
    const executor = gate.acquire("executor", request());
    gate.grant("executor", "ticket-2");
    (await executor)?.release();

    expect(gate.status()).toMatchObject({
      monitor: { state: "waiting", ticket: "ticket-1", seq: 1 },
      executor: { state: "idle", seq: 4 },
    });

    gate.grant("monitor", "ticket-1");
    (await monitor)?.release();
    expect(gate.status().monitor).toEqual({ state: "idle", seq: 6 });
  });

  it("puts the pid of the running session on the held slot and takes it off at exit", async () => {
    const { gate, changes } = externalGate();
    const acquiring = gate.acquire("executor", request({ taskId: "t-1" }));
    gate.grant("executor", "ticket-1");
    const lease = await acquiring;
    if (lease === null) throw new Error("no lease");

    expect(lease.ticket).toBe("ticket-1");
    expect(lease.spawned(101)).toBe(3);
    expect(gate.status().executor).toMatchObject({ state: "holding", pid: 101, seq: 3 });

    lease.exited(999);
    expect(gate.status().executor).toMatchObject({ pid: 101, seq: 3 });
    lease.exited(101);
    expect(gate.status().executor).toMatchObject({ state: "holding", seq: 4 });
    expect(gate.status().executor).toHaveProperty("pid", undefined);

    expect(lease.spawned(102)).toBe(5);
    lease.release();
    expect(lease.spawned(103)).toBeUndefined();
    lease.exited(102);
    expect(gate.status().executor).toEqual({ state: "idle", seq: 6 });
    expect(changes.map((change) => change.kind)).toEqual(["granted", "released"]);
  });

  it("issues random tickets by default", () => {
    const gate = new AdmissionGate("external");
    const wanted = request();

    void gate.acquire("monitor", wanted);

    expect(wanted.waits[0]?.ticket).toMatch(/^[0-9a-f-]{36}$/);
  });
});
