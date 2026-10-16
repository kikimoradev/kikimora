import type { AdmissionLease, AdmissionRole } from "./admission.js";
import type { SessionAgent } from "./sessions/index.js";
import type { SessionFailureReason } from "./types.js";

export const SESSION_LAUNCHER_ENV = "KIKIMORA_SESSION_LAUNCHER";
export const SESSION_ROLE_ENV = "KIKIMORA_SESSION_ROLE";
export const ADMISSION_POOL_ENV = "KIKIMORA_ADMISSION_POOL";
export const ADMISSION_TICKET_ENV = "KIKIMORA_ADMISSION_TICKET";

export type SessionLauncher = readonly string[];

export const NO_LAUNCHER: SessionLauncher = [];

export interface SessionPlacement {
  pool: AdmissionRole;
  lease: AdmissionLease;
}

export interface PlacedSession {
  role: SessionAgent;
  pool: AdmissionRole;
  ticket: string | undefined;
}

export interface SessionCommand {
  file: string;
  args: string[];
  env: NodeJS.ProcessEnv | undefined;
}

export function parseSessionLauncher(raw: string | undefined): SessionLauncher | null {
  if (raw === undefined || raw.trim() === "") return NO_LAUNCHER;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return null;
  const parts: unknown[] = parsed;
  return parts.every(isNonEmptyString) ? parts : null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value !== "";
}

export function invalidLauncherMessage(raw: string | undefined): string {
  return `Invalid ${SESSION_LAUNCHER_ENV} "${raw ?? ""}": use a JSON array of non-empty strings, e.g. ["/usr/local/bin/launch","--pool"].`;
}

export function sessionCommand(
  command: string,
  args: string[],
  launcher: SessionLauncher,
  session: PlacedSession,
  env: NodeJS.ProcessEnv | undefined,
): SessionCommand {
  const [file, ...prefix] = launcher;
  if (file === undefined) return { file: command, args, env };
  return {
    file,
    args: [...prefix, command, ...args],
    env: placementEnv(env ?? process.env, session),
  };
}

function placementEnv(
  base: NodeJS.ProcessEnv,
  session: PlacedSession,
): NodeJS.ProcessEnv {
  return {
    ...base,
    [SESSION_ROLE_ENV]: session.role,
    [ADMISSION_POOL_ENV]: session.pool,
    [ADMISSION_TICKET_ENV]: session.ticket,
  };
}

export const LAUNCHER_REFUSED_EXIT_CODE = 75;
export const POOL_MEMORY_LIMIT_EXIT_CODE = 137;
export const LAUNCHER_REFUSAL_BACKOFF_MS = 30_000;

export interface SessionExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  initialized: boolean;
}

export type LauncherFailureReason = Extract<
  SessionFailureReason,
  "launcherRefused" | "poolMemoryLimit"
>;

export function launcherFailureReason(
  launcher: SessionLauncher,
  exit: SessionExit,
): LauncherFailureReason | null {
  if (launcher.length === 0) return null;
  if (exit.code === LAUNCHER_REFUSED_EXIT_CODE && !exit.initialized) {
    return "launcherRefused";
  }
  if (exit.signal === "SIGKILL" || exit.code === POOL_MEMORY_LIMIT_EXIT_CODE) {
    return "poolMemoryLimit";
  }
  return null;
}
