import { truncate } from "./session-events.js";
import type { SessionFailureReason, SessionResult } from "./types.js";

const AUTH_STATUSES: ReadonlySet<number> = new Set([401, 403]);
const AUTH_ERROR_CODE_PATTERN = /authentication_failed|invalid_api_key/i;
const AUTH_TEXT_PATTERN =
  /not logged in|please run \/login|failed to authenticate|authentication_failed|(?:oauth (?:access )?token|api key) (?:is )?(?:invalid|expired|revoked)|invalid (?:api key|x-api-key)|api error: 40[13]\b/i;
const REASON_MAX_LENGTH = 160;
const FALLBACK_REASON = "authentication failed";
const WITHOUT_AUTH_VERDICT: ReadonlySet<SessionFailureReason | undefined> = new Set([
  "abort",
  "spawn",
  "launcherRefused",
]);

export interface AuthFailure {
  reason: string;
}

export type AuthFailureListener = (failure: AuthFailure) => void;

function isStructuralAuthError(result: SessionResult): boolean {
  const { apiError } = result;
  if (apiError === undefined) return false;
  if (AUTH_STATUSES.has(apiError.status)) return true;
  return apiError.code !== undefined && AUTH_ERROR_CODE_PATTERN.test(apiError.code);
}

function describeReason(result: SessionResult): string {
  const firstLine = result.resultText
    ?.split("\n")
    .map((line) => line.trim())
    .find((line) => line !== "");
  if (firstLine !== undefined) return truncate(firstLine, REASON_MAX_LENGTH);
  if (result.apiError !== undefined) {
    const code = result.apiError.code === undefined ? "" : ` ${result.apiError.code}`;
    return `HTTP ${String(result.apiError.status)}${code}`;
  }
  return result.error === undefined
    ? FALLBACK_REASON
    : truncate(result.error, REASON_MAX_LENGTH);
}

export function detectAuthFailure(result: SessionResult): AuthFailure | null {
  if (result.ok) return null;
  if (WITHOUT_AUTH_VERDICT.has(result.failureReason)) return null;

  const structural = isStructuralAuthError(result);
  if (result.failureReason === "timeout") {
    return structural ? { reason: describeReason(result) } : null;
  }

  const text = `${result.resultText ?? ""}\n${result.error ?? ""}`;
  if (!structural && !AUTH_TEXT_PATTERN.test(text)) return null;
  return { reason: describeReason(result) };
}

export class AuthGate {
  private failure: AuthFailure | null = null;

  constructor(private readonly onEngaged: AuthFailureListener = () => undefined) {}

  get blocked(): AuthFailure | null {
    return this.failure;
  }

  engage(failure: AuthFailure): void {
    this.failure = failure;
    this.onEngaged(failure);
  }

  clear(): boolean {
    if (this.failure === null) return false;
    this.failure = null;
    return true;
  }
}
