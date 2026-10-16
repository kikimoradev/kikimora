import type { AdmissionLease, AdmissionRole } from "./admission.js";

export const SESSION_LAUNCHER_ENV = "KIKIMORA_SESSION_LAUNCHER";
export const SESSION_ROLE_ENV = "KIKIMORA_SESSION_ROLE";
export const ADMISSION_POOL_ENV = "KIKIMORA_ADMISSION_POOL";
export const ADMISSION_TICKET_ENV = "KIKIMORA_ADMISSION_TICKET";

export const SESSION_ROLES = ["monitor", "executor", "summarizer"] as const;
export type SessionRole = (typeof SESSION_ROLES)[number];

export type SessionLauncher = readonly string[];

export const NO_LAUNCHER: SessionLauncher = [];

export interface SessionPlacement {
  role: SessionRole;
  pool: AdmissionRole;
  lease: AdmissionLease;
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
  placement: SessionPlacement,
  env: NodeJS.ProcessEnv | undefined,
): SessionCommand {
  const [file, ...prefix] = launcher;
  if (file === undefined) return { file: command, args, env };
  return {
    file,
    args: [...prefix, command, ...args],
    env: placementEnv(env ?? process.env, placement),
  };
}

function placementEnv(
  base: NodeJS.ProcessEnv,
  placement: SessionPlacement,
): NodeJS.ProcessEnv {
  return {
    ...base,
    [SESSION_ROLE_ENV]: placement.role,
    [ADMISSION_POOL_ENV]: placement.pool,
    [ADMISSION_TICKET_ENV]: placement.lease.ticket,
  };
}
