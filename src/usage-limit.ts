import type { SessionResult } from "./types.js";

export const RESET_BUFFER_MS = 60_000;
export const FALLBACK_WAIT_MS = 15 * 60_000;

const LIMIT_TEXT_PATTERN =
  /usage limit reached|(?:5-hour|five.hour|weekly|session) limit reached|(?:reached|hit) your (?:usage|weekly|session|5-hour|five.hour) limit/i;
const PIPE_TIMESTAMP_PATTERN = /limit reached\|\s*(\d{10,13})/;

export interface UsageLimitHit {
  resetAt: Date | null;
}

function toMillis(raw: number): number {
  return raw < 1e12 ? raw * 1000 : raw;
}

export function detectUsageLimit(result: SessionResult): UsageLimitHit | null {
  if (result.ok) return null;

  if (result.rateLimit?.status === "rejected") {
    const { resetsAt } = result.rateLimit;
    return {
      resetAt: resetsAt !== undefined ? new Date(toMillis(resetsAt)) : null,
    };
  }

  const text = `${result.resultText ?? ""}\n${result.error ?? ""}`;
  if (!LIMIT_TEXT_PATTERN.test(text)) return null;

  const match = PIPE_TIMESTAMP_PATTERN.exec(text);
  const raw = match?.[1];
  return { resetAt: raw === undefined ? null : new Date(toMillis(Number(raw))) };
}

export class UsageLimitGate {
  private blockedUntil: number | null = null;

  engage(hit: UsageLimitHit, now: number): number {
    const resetAt = hit.resetAt?.getTime();
    const until =
      resetAt !== undefined && resetAt > now
        ? resetAt + RESET_BUFFER_MS
        : now + FALLBACK_WAIT_MS;
    this.blockedUntil = Math.max(this.blockedUntil ?? 0, until);
    return this.blockedUntil;
  }

  msRemaining(now: number): number {
    if (this.blockedUntil === null) return 0;
    const left = this.blockedUntil - now;
    if (left <= 0) {
      this.blockedUntil = null;
      return 0;
    }
    return left;
  }
}
