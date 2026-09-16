import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentController, type AgentControlState } from "../src/control.js";
import { DrainController, type DrainSnapshot } from "../src/drain.js";

interface Harness {
  drain: DrainController;
  monitor: AgentController;
  executor: AgentController;
  abort: ReturnType<typeof vi.fn>;
  requested: DrainSnapshot[];
  events: string[];
  loops: AbortController;
}

function harness(initialState: AgentControlState = "running"): Harness {
  const events: string[] = [];
  const requested: DrainSnapshot[] = [];
  const loops = new AbortController();
  const abort = vi.fn(() => {
    events.push("abort");
    loops.abort();
  });
  const holder: { drain?: DrainController } = {};
  const track =
    (agent: string) =>
    (state: AgentControlState): void => {
      events.push(`${agent} ${state}`);
      holder.drain?.noteSettled();
    };
  const monitor = new AgentController(track("monitor"), initialState);
  const executor = new AgentController(track("executor"), initialState);
  const drain = new DrainController({ monitor, executor }, abort, (snapshot) => {
    events.push("requested");
    requested.push(snapshot);
  });
  holder.drain = drain;
  return { drain, monitor, executor, abort, requested, events, loops };
}

describe("DrainController", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: Date.parse("2026-09-16T12:00:00.000Z") });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("has no snapshot before a request and ignores settled agents until one arrives", () => {
    const { drain, abort } = harness("paused");

    drain.noteSettled();

    expect(drain.snapshot).toBeUndefined();
    expect(drain.settled).toBe(false);
    expect(abort).not.toHaveBeenCalled();
  });

  it("records the request, announces it, then pauses both agents", () => {
    const { drain, monitor, executor, requested, events, abort } = harness();

    const snapshot = drain.request("drain", 60_000);

    expect(snapshot).toEqual({
      since: Date.parse("2026-09-16T12:00:00.000Z"),
      until: Date.parse("2026-09-16T12:01:00.000Z"),
      reason: "drain",
    });
    expect(drain.snapshot).toBe(snapshot);
    expect(requested).toEqual([snapshot]);
    expect(events).toEqual(["requested", "monitor pausing", "executor pausing"]);
    expect(monitor.state).toBe("pausing");
    expect(executor.state).toBe("pausing");
    expect(abort).not.toHaveBeenCalled();
    drain.dispose();
  });

  it("has no deadline without a timeout", () => {
    const { drain, abort } = harness();

    const snapshot = drain.request("SIGTERM", undefined);

    expect(snapshot).toEqual({
      since: Date.now(),
      until: undefined,
      reason: "SIGTERM",
    });
    vi.advanceTimersByTime(86_400_000);
    expect(abort).not.toHaveBeenCalled();
  });

  it("is idempotent: a second request returns the first snapshot and never moves the deadline", () => {
    const { drain, requested, abort, events } = harness();
    const first = drain.request("drain", 1_000);
    const eventsAfterFirst = [...events];

    vi.advanceTimersByTime(500);
    const second = drain.request("SIGTERM", 5_000);

    expect(second).toBe(first);
    expect(requested).toHaveLength(1);
    expect(events).toEqual(eventsAfterFirst);
    vi.advanceTimersByTime(499);
    expect(abort).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(abort).toHaveBeenCalledTimes(1);
  });

  it("a later request with a timeout does not add a deadline to one without", () => {
    const { drain, abort } = harness();
    drain.request("drain", undefined);

    const second = drain.request("drain", 1_000);

    expect(second.until).toBeUndefined();
    vi.advanceTimersByTime(10_000);
    expect(abort).not.toHaveBeenCalled();
  });

  it("aborts exactly when the second agent comes to rest at its gate", async () => {
    const { drain, monitor, executor, abort, events, loops } = harness();
    drain.request("drain", 60_000);

    const monitorGate = monitor.gate(loops.signal);
    expect(monitor.state).toBe("paused");
    expect(abort).not.toHaveBeenCalled();

    const executorGate = executor.gate(loops.signal);

    expect(abort).toHaveBeenCalledTimes(1);
    expect(drain.settled).toBe(true);
    expect(events.slice(-2)).toEqual(["executor paused", "abort"]);
    await expect(Promise.all([monitorGate, executorGate])).resolves.toEqual([
      undefined,
      undefined,
    ]);
    vi.advanceTimersByTime(60_000);
    expect(abort).toHaveBeenCalledTimes(1);
  });

  it("aborts at once when both agents are already paused", () => {
    const { drain, abort, events } = harness("paused");

    drain.request("drain", 60_000);

    expect(abort).toHaveBeenCalledTimes(1);
    expect(drain.settled).toBe(true);
    expect(events).toEqual(["requested", "abort"]);
  });

  it("aborts at the deadline while a session is still running, and only once", () => {
    const { drain, monitor, executor, abort, loops } = harness();
    drain.request("SIGTERM", 1_000);
    void monitor.gate(loops.signal);

    vi.advanceTimersByTime(999);
    expect(abort).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);

    expect(abort).toHaveBeenCalledTimes(1);
    expect(drain.settled).toBe(false);
    void executor.gate(new AbortController().signal);
    expect(executor.state).toBe("paused");
    expect(abort).toHaveBeenCalledTimes(1);
    expect(drain.settled).toBe(false);
  });

  it("dispose disarms the deadline", () => {
    const { drain, abort } = harness();
    drain.request("drain", 1_000);

    drain.dispose();
    vi.advanceTimersByTime(5_000);

    expect(abort).not.toHaveBeenCalled();
    expect(drain.settled).toBe(false);
  });

  it("dispose without a request is harmless", () => {
    const { drain } = harness();

    expect(() => {
      drain.dispose();
    }).not.toThrow();
  });
});

describe("DrainController deadline timer", () => {
  it("does not keep the process alive on its own", () => {
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const { drain } = harness();

    drain.request("drain", 60_000);

    const timer = setTimeoutSpy.mock.results[0]?.value as NodeJS.Timeout;
    expect(timer.hasRef()).toBe(false);
    drain.dispose();
    setTimeoutSpy.mockRestore();
  });
});
