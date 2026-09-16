import { afterEach, describe, expect, it, vi } from "vitest";
import { abortOnSignals, type SignalPolicy } from "../src/shutdown.js";

const SIGNAL: NodeJS.Signals = "SIGUSR2";
const OTHER_SIGNAL: NodeJS.Signals = "SIGHUP";

interface PolicySpy extends SignalPolicy {
  graceMsFor: ReturnType<typeof vi.fn<(signal: NodeJS.Signals) => number>>;
  onDrain: ReturnType<typeof vi.fn<(signal: NodeJS.Signals, graceMs: number) => void>>;
  onAbort: ReturnType<typeof vi.fn<(signal: NodeJS.Signals) => void>>;
}

function policy(graces: Partial<Record<NodeJS.Signals, number>> = {}): PolicySpy {
  return {
    graceMsFor: vi.fn((signal: NodeJS.Signals) => graces[signal] ?? 0),
    onDrain: vi.fn(),
    onAbort: vi.fn(),
  };
}

describe("abortOnSignals", () => {
  afterEach(() => {
    process.removeAllListeners(SIGNAL);
    process.removeAllListeners(OTHER_SIGNAL);
  });

  it("is not aborted before a signal arrives", () => {
    const signal = abortOnSignals(policy(), [SIGNAL, OTHER_SIGNAL]);

    expect(signal.aborted).toBe(false);
    expect(process.listenerCount(SIGNAL)).toBe(1);
    expect(process.listenerCount(OTHER_SIGNAL)).toBe(1);
  });

  it("aborts at once on a signal without grace and names it", () => {
    const spy = policy();
    const signal = abortOnSignals(spy, [SIGNAL, OTHER_SIGNAL]);

    process.emit(SIGNAL);

    expect(signal.aborted).toBe(true);
    expect(spy.graceMsFor).toHaveBeenCalledWith(SIGNAL);
    expect(spy.onAbort).toHaveBeenCalledWith(SIGNAL);
    expect(spy.onDrain).not.toHaveBeenCalled();
  });

  it("names the signal before the abort reaches listeners", () => {
    const order: string[] = [];
    const signal = abortOnSignals(
      {
        graceMsFor: () => 0,
        onDrain: () => undefined,
        onAbort: () => order.push("onAbort"),
      },
      [SIGNAL],
    );
    signal.addEventListener("abort", () => order.push("aborted"));

    process.emit(SIGNAL);

    expect(order).toEqual(["onAbort", "aborted"]);
  });

  it("drains instead of aborting when the policy grants the signal a grace", () => {
    const spy = policy({ [SIGNAL]: 120_000 });
    const signal = abortOnSignals(spy, [SIGNAL, OTHER_SIGNAL]);

    process.emit(SIGNAL);

    expect(signal.aborted).toBe(false);
    expect(spy.onDrain).toHaveBeenCalledWith(SIGNAL, 120_000);
    expect(spy.onAbort).not.toHaveBeenCalled();
  });

  it("a signal without grace still aborts at once when another has one", () => {
    const spy = policy({ [SIGNAL]: 120_000 });
    const signal = abortOnSignals(spy, [SIGNAL, OTHER_SIGNAL]);

    process.emit(OTHER_SIGNAL);

    expect(signal.aborted).toBe(true);
    expect(spy.onAbort).toHaveBeenCalledWith(OTHER_SIGNAL);
    expect(spy.onDrain).not.toHaveBeenCalled();
  });

  it("a second signal of any kind during the drain aborts at once without asking for grace", () => {
    for (const second of [SIGNAL, OTHER_SIGNAL]) {
      const spy = policy({ [SIGNAL]: 120_000, [OTHER_SIGNAL]: 120_000 });
      const signal = abortOnSignals(spy, [SIGNAL, OTHER_SIGNAL]);

      process.emit(SIGNAL);
      process.emit(second);

      expect(signal.aborted).toBe(true);
      expect(spy.graceMsFor).toHaveBeenCalledTimes(1);
      expect(spy.onDrain).toHaveBeenCalledTimes(1);
      expect(spy.onAbort).toHaveBeenCalledWith(second);
      process.removeAllListeners(SIGNAL);
      process.removeAllListeners(OTHER_SIGNAL);
    }
  });

  it("detaches after the abort, leaving a further signal to the default disposition", () => {
    const spy = policy();
    abortOnSignals(spy, [SIGNAL, OTHER_SIGNAL]);

    process.emit(OTHER_SIGNAL);

    expect(process.listenerCount(SIGNAL)).toBe(0);
    expect(process.listenerCount(OTHER_SIGNAL)).toBe(0);
    process.emit(SIGNAL);
    expect(spy.onAbort).toHaveBeenCalledTimes(1);
  });

  it("stays attached while draining", () => {
    abortOnSignals(policy({ [SIGNAL]: 1_000 }), [SIGNAL, OTHER_SIGNAL]);

    process.emit(SIGNAL);

    expect(process.listenerCount(SIGNAL)).toBe(1);
    expect(process.listenerCount(OTHER_SIGNAL)).toBe(1);
  });

  it("listens to SIGINT and SIGTERM by default", () => {
    const before = {
      SIGINT: process.listeners("SIGINT"),
      SIGTERM: process.listeners("SIGTERM"),
    };
    const spy = policy();
    const signal = abortOnSignals(spy);

    const added = process
      .listeners("SIGINT")
      .filter((listener) => !before.SIGINT.includes(listener));
    expect(added).toHaveLength(1);
    expect(process.listeners("SIGTERM")).toHaveLength(before.SIGTERM.length + 1);
    added[0]?.("SIGINT");

    expect(signal.aborted).toBe(true);
    expect(spy.onAbort).toHaveBeenCalledWith("SIGINT");
    expect(process.listeners("SIGINT")).toEqual(before.SIGINT);
    expect(process.listeners("SIGTERM")).toEqual(before.SIGTERM);
  });
});
