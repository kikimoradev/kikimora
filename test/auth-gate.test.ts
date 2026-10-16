import { describe, expect, it, vi } from "vitest";
import { AuthGate, detectAuthFailure } from "../src/auth-gate.js";
import type { SessionResult } from "../src/types.js";

function failure(overrides: Partial<SessionResult> = {}): SessionResult {
  return {
    ok: false,
    durationMs: 10,
    failureReason: "isError",
    error: "Session ended with an error (is_error)",
    ...overrides,
  };
}

describe("detectAuthFailure", () => {
  it("a successful session is never an auth failure", () => {
    expect(
      detectAuthFailure({
        ok: true,
        durationMs: 10,
        apiError: { status: 401, code: "authentication_failed" },
        resultText: "Not logged in",
      }),
    ).toBeNull();
  });

  it("recognizes a structural 401 or 403 without any text", () => {
    expect(
      detectAuthFailure(
        failure({ apiError: { status: 401, code: "authentication_failed" } }),
      ),
    ).toEqual({ reason: "HTTP 401 authentication_failed" });
    expect(detectAuthFailure(failure({ apiError: { status: 403 } }))).toEqual({
      reason: "HTTP 403",
    });
  });

  it("recognizes an auth error code on another status", () => {
    expect(
      detectAuthFailure(failure({ apiError: { status: 400, code: "invalid_api_key" } })),
    ).toEqual({ reason: "HTTP 400 invalid_api_key" });
  });

  it("other API errors without auth wording are not auth failures", () => {
    expect(detectAuthFailure(failure({ apiError: { status: 529 } }))).toBeNull();
    expect(
      detectAuthFailure(failure({ apiError: { status: 500, code: "api_error" } })),
    ).toBeNull();
  });

  it.each([
    "Not logged in · Please run /login",
    "Failed to authenticate. API Error: 401 OAuth access token is invalid.",
    "Failed to authenticate. API Error: 401 API key is invalid.",
    "OAuth token expired",
    "authentication_failed",
    "Invalid API key · Fix external API key",
    "API Error: 403 Request not allowed",
  ])("recognizes the wording %j and keeps the first line as the reason", (text) => {
    expect(detectAuthFailure(failure({ resultText: `${text}\nsecond line` }))).toEqual({
      reason: text,
    });
  });

  it("recognizes wording in the error field when there is no result text", () => {
    expect(
      detectAuthFailure(
        failure({
          failureReason: "exit",
          error: "Failed to authenticate",
          resultText: undefined,
        }),
      ),
    ).toEqual({ reason: "Failed to authenticate" });
  });

  it("a timeout counts only with a structural auth error", () => {
    expect(
      detectAuthFailure(
        failure({
          failureReason: "timeout",
          apiError: { status: 401 },
          resultText: undefined,
        }),
      ),
    ).toEqual({ reason: "HTTP 401" });
    expect(
      detectAuthFailure(
        failure({ failureReason: "timeout", resultText: "Not logged in" }),
      ),
    ).toBeNull();
  });

  it("aborted, unspawnable and refused sessions are never auth failures", () => {
    expect(
      detectAuthFailure(failure({ failureReason: "abort", resultText: "Not logged in" })),
    ).toBeNull();
    expect(
      detectAuthFailure(
        failure({ failureReason: "spawn", error: "Failed to start: Not logged in" }),
      ),
    ).toBeNull();
    expect(
      detectAuthFailure(
        failure({ failureReason: "launcherRefused", error: "Not logged in to the pool" }),
      ),
    ).toBeNull();
  });

  it.each([
    "API Error: Connection closed mid-response.",
    "429 rate limit exceeded",
    "Claude AI usage limit reached",
    "gh: HTTP 401 Unauthorized when calling the GitHub API",
    "The remote returned 403 Forbidden",
    "I cannot complete this task.",
  ])("ignores ordinary failure wording %j", (text) => {
    expect(detectAuthFailure(failure({ resultText: text }))).toBeNull();
  });

  it("falls back to a generic reason when nothing describes the failure", () => {
    expect(
      detectAuthFailure(
        failure({ apiError: { status: 401 }, error: undefined, resultText: "   \n  " }),
      ),
    ).toEqual({ reason: "HTTP 401" });
    expect(
      detectAuthFailure(
        failure({ failureReason: "exit", error: "Not logged in", resultText: undefined }),
      ),
    ).toEqual({ reason: "Not logged in" });
  });

  it("truncates a long reason", () => {
    const text = `Not logged in ${"x".repeat(400)}`;
    const detected = detectAuthFailure(failure({ resultText: text }));
    expect(detected?.reason.length).toBe(161);
    expect(detected?.reason.endsWith("…")).toBe(true);
  });
});

describe("AuthGate", () => {
  it("is open by default", () => {
    expect(new AuthGate().blocked).toBeNull();
    expect(new AuthGate().clear()).toBe(false);
  });

  it("engage records the failure and notifies the listener every time", () => {
    const listener = vi.fn();
    const gate = new AuthGate(listener);

    gate.engage({ reason: "first" });
    gate.engage({ reason: "second" });

    expect(gate.blocked).toEqual({ reason: "second" });
    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenLastCalledWith({ reason: "second" });
  });

  it("clear opens the gate and reports whether it was blocked", () => {
    const gate = new AuthGate();
    gate.engage({ reason: "x" });

    expect(gate.clear()).toBe(true);
    expect(gate.blocked).toBeNull();
    expect(gate.clear()).toBe(false);
  });
});
