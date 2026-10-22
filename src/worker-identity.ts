import type { AuthKind, WorkerIdentity } from "./control-protocol.js";
import type { ClaudeAuthStatus, ClaudeCliInfo } from "./preflight.js";

const API_KEY_ENV = "ANTHROPIC_API_KEY";
const OAUTH_TOKEN_ENV = "CLAUDE_CODE_OAUTH_TOKEN";

function isSet(value: string | undefined): boolean {
  return value !== undefined && value.trim() !== "";
}

function authKindReportedBy(status: ClaudeAuthStatus | null): AuthKind {
  if (status === null) return "unknown";
  if (status.apiKeySource !== undefined) return "apiKey";
  switch (status.authMethod) {
    case "oauth_token":
      return "oauth";
    case "api_key":
      return "apiKey";
    case "claude.ai":
      return "claude.ai";
    default:
      return "unknown";
  }
}

export function resolveAuthKind(
  status: ClaudeAuthStatus | null,
  env: NodeJS.ProcessEnv = process.env,
): AuthKind {
  if (isSet(env[API_KEY_ENV])) return "apiKey";
  if (isSet(env[OAUTH_TOKEN_ENV])) return "oauth";
  return authKindReportedBy(status);
}

export interface WorkerIdentityInput {
  version: string;
  claude: ClaudeCliInfo;
  nodeVersion: string;
  pid: number;
  startedAt: number;
  projectDir: string;
  env?: NodeJS.ProcessEnv | undefined;
}

export function buildWorkerIdentity(input: WorkerIdentityInput): WorkerIdentity {
  const { version: claudeVersion, auth } = input.claude;
  return {
    version: input.version,
    ...(claudeVersion === null ? {} : { claudeVersion }),
    nodeVersion: input.nodeVersion,
    pid: input.pid,
    startedAt: new Date(input.startedAt).toISOString(),
    projectDir: input.projectDir,
    authKind: resolveAuthKind(auth, input.env),
  };
}
