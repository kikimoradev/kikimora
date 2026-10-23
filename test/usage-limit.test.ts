import { describe, expect, it } from "vitest";
import type { SessionResult } from "../src/types.js";
import {
  detectUsageLimit,
  FALLBACK_WAIT_MS,
  RESET_BUFFER_MS,
  UsageLimitGate,
} from "../src/usage-limit.js";

function failure(overrides: Partial<SessionResult> = {}): SessionResult {
  return {
    ok: false,
    durationMs: 10,
    failureReason: "isError",
    error: "Session ended with an error (is_error)",
    ...overrides,
  };
}

describe("detectUsageLimit", () => {
  it("a successful session is never a limit hit", () => {
    expect(
      detectUsageLimit({
        ok: true,
        durationMs: 10,
        rateLimit: { status: "rejected", resetsAt: 1778193600 },
      }),
    ).toBeNull();
  });

  it("a rejected rate_limit_event yields the reset time from resetsAt", () => {
    const hit = detectUsageLimit(
      failure({
        rateLimit: {
          status: "rejected",
          resetsAt: 1778193600,
          rateLimitType: "five_hour",
        },
      }),
    );
    expect(hit?.resetAt?.getTime()).toBe(1778193600 * 1000);
  });

  it("a rejected rate_limit_event without resetsAt yields a null reset time", () => {
    const hit = detectUsageLimit(failure({ rateLimit: { status: "rejected" } }));
    expect(hit).toEqual({ resetAt: null });
  });

  it("a non-rejected rate_limit_event alone is not a limit hit", () => {
    expect(
      detectUsageLimit(
        failure({ rateLimit: { status: "allowed" }, resultText: "some failure" }),
      ),
    ).toBeNull();
  });

  it("recognizes the legacy pipe format with a unix timestamp", () => {
    const hit = detectUsageLimit(
      failure({ resultText: "Claude AI usage limit reached|1778193600" }),
    );
    expect(hit?.resetAt?.getTime()).toBe(1778193600 * 1000);
  });

  it("recognizes limit wording without a timestamp", () => {
    for (const text of [
      "5-hour limit reached ∙ resets 3:45pm",
      "You've reached your weekly limit",
      "Claude AI usage limit reached",
      "Session limit reached, try again later",
      "You've hit your session limit · resets 4:10pm (Europe/Warsaw)",
    ]) {
      expect(detectUsageLimit(failure({ resultText: text }))).toEqual({
        resetAt: null,
      });
    }
  });

  it("recognizes limit wording in the error field", () => {
    expect(
      detectUsageLimit(failure({ failureReason: "exit", error: "usage limit reached" })),
    ).toEqual({ resetAt: null });
  });

  it("ordinary failures are not limit hits", () => {
    for (const text of [
      "API Error: Connection closed mid-response.",
      "429 rate limit exceeded",
      "I cannot complete this task.",
    ]) {
      expect(detectUsageLimit(failure({ resultText: text }))).toBeNull();
    }
  });
});

describe("UsageLimitGate", () => {
  const now = 1_700_000_000_000;

  it("is open by default", () => {
    expect(new UsageLimitGate().msRemaining(now)).toBe(0);
  });

  it("blocks until the reset time plus a safety buffer", () => {
    const gate = new UsageLimitGate();
    const resetAt = new Date(now + 60_000);
    gate.engage({ resetAt }, now);
    expect(gate.msRemaining(now)).toBe(60_000 + RESET_BUFFER_MS);
  });

  it("falls back to a fixed wait when the reset time is unknown", () => {
    const gate = new UsageLimitGate();
    gate.engage({ resetAt: null }, now);
    expect(gate.msRemaining(now)).toBe(FALLBACK_WAIT_MS);
  });

  it("falls back to a fixed wait when the reset time is in the past", () => {
    const gate = new UsageLimitGate();
    gate.engage({ resetAt: new Date(now - 1000) }, now);
    expect(gate.msRemaining(now)).toBe(FALLBACK_WAIT_MS);
  });

  it("keeps the latest block when engaged twice", () => {
    const gate = new UsageLimitGate();
    gate.engage({ resetAt: new Date(now + 3_600_000) }, now);
    gate.engage({ resetAt: null }, now);
    expect(gate.msRemaining(now)).toBe(3_600_000 + RESET_BUFFER_MS);
  });

  it("extends the block when a later reset arrives", () => {
    const gate = new UsageLimitGate();
    gate.engage({ resetAt: null }, now);
    gate.engage({ resetAt: new Date(now + 3_600_000) }, now);
    expect(gate.msRemaining(now)).toBe(3_600_000 + RESET_BUFFER_MS);
  });

  it("opens again once the block expires", () => {
    const gate = new UsageLimitGate();
    gate.engage({ resetAt: new Date(now + 1000) }, now);
    expect(gate.msRemaining(now + 1000 + RESET_BUFFER_MS)).toBe(0);
    expect(gate.msRemaining(now)).toBe(0);
  });
});
