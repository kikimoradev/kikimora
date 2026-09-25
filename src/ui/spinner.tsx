import { Text } from "ink";
import type { JSX } from "react";
import { createContext, useContext, useSyncExternalStore } from "react";
import { SPINNER_FRAMES } from "./theme.js";

export const SPINNER_INTERVAL_MS = 100;

const AnimationContext = createContext(true);

export const AnimationProvider = AnimationContext.Provider;

const listeners = new Set<() => void>();
let frame = 0;
let timer: ReturnType<typeof setInterval> | undefined;

function tick(): void {
  frame = (frame + 1) % SPINNER_FRAMES.length;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  timer ??= setInterval(tick, SPINNER_INTERVAL_MS);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  };
}

function subscribeNever(): () => void {
  return () => undefined;
}

function currentFrame(): number {
  return frame;
}

function firstFrame(): number {
  return 0;
}

export function Spinner({ color }: { color?: string | undefined }): JSX.Element {
  const animate = useContext(AnimationContext);
  const index = useSyncExternalStore(
    animate ? subscribe : subscribeNever,
    animate ? currentFrame : firstFrame,
  );
  return <Text {...(color === undefined ? {} : { color })}>{SPINNER_FRAMES[index]}</Text>;
}
