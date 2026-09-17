export interface SignalPolicy {
  graceMsFor(signal: NodeJS.Signals): number;
  onDrain(signal: NodeJS.Signals, graceMs: number): void;
  onAbort(signal: NodeJS.Signals): void;
}

export function abortOnSignals(
  policy: SignalPolicy,
  signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM"],
): AbortSignal {
  const controller = new AbortController();
  const listeners = new Map<NodeJS.Signals, () => void>();
  let draining = false;

  const detach = (): void => {
    for (const [signal, listener] of listeners) process.removeListener(signal, listener);
  };

  for (const signal of signals) {
    const listener = (): void => {
      const graceMs = draining ? 0 : policy.graceMsFor(signal);
      if (graceMs > 0) {
        draining = true;
        policy.onDrain(signal, graceMs);
        return;
      }
      detach();
      policy.onAbort(signal);
      controller.abort();
    };
    listeners.set(signal, listener);
    process.on(signal, listener);
  }

  return controller.signal;
}
