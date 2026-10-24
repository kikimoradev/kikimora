import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { leadsOwnProcessGroup, terminateProcessTree } from "./process-tree.js";
import type { SessionEventSink } from "./session-events.js";
import {
  LAUNCHER_REFUSED_EXIT_CODE,
  launcherFailureReason,
  sessionCommand,
  type LauncherFailureReason,
  type PlacedSession,
  type SessionLauncher,
  type SessionPlacement,
} from "./session-launcher.js";
import type { SessionMeta, SessionRecorder } from "./sessions/index.js";
import { StreamRenderer } from "./stream.js";
import type { EffortLevel, SessionFailureReason, SessionResult } from "./types.js";

const KILL_GRACE_MS = 5000;
const SESSION_SETTINGS = JSON.stringify({ attribution: { commit: "", pr: "" } });

type KillReason = "timeout" | "abort";

export interface SessionSpec {
  command: string;
  launcher: SessionLauncher;
  placement: SessionPlacement;
  model: string;
  effort: EffortLevel;
  systemPrompt: string;
  prompt: string;
  resume?: string | undefined;
  sessionTimeoutMs?: number | undefined;
  streamPartial: boolean;
  mcpConfigPath: string;
  jsonSchema?: string | undefined;
  cwd: string;
  childEnv?: NodeJS.ProcessEnv | undefined;
  events: SessionEventSink;
  meta: SessionMeta;
  index?: SessionRecorder | undefined;
}

export async function runSession(
  spec: SessionSpec,
  signal: AbortSignal,
): Promise<SessionResult> {
  const startedAt = Date.now();

  const args = [
    "-p",
    "--model",
    spec.model,
    "--effort",
    spec.effort,
    "--system-prompt",
    spec.systemPrompt,
    "--output-format",
    "stream-json",
    "--verbose",
    "--permission-mode",
    "bypassPermissions",
    "--settings",
    SESSION_SETTINGS,
  ];
  if (spec.streamPartial) args.push("--include-partial-messages");
  args.push("--mcp-config", spec.mcpConfigPath, "--strict-mcp-config");
  if (spec.jsonSchema) args.push("--json-schema", spec.jsonSchema);
  if (spec.resume !== undefined) args.push("--resume", spec.resume);

  const placed: PlacedSession = {
    role: spec.meta.agent,
    pool: spec.placement.pool,
    ticket: spec.placement.lease.ticket,
  };
  const launch = sessionCommand(spec.command, args, spec.launcher, placed, spec.childEnv);
  const child = spawn(launch.file, launch.args, {
    cwd: spec.cwd,
    env: launch.env,
    stdio: ["pipe", "pipe", "pipe"],
    detached: leadsOwnProcessGroup(),
  });

  const indexed: { sessionId: string | null } = { sessionId: null };
  const events: SessionEventSink = (event) => {
    if (event.type !== "init") {
      spec.events(event);
      return;
    }
    spec.events({ ...event, taskId: spec.meta.taskId, cycle: spec.meta.cycle });
    indexed.sessionId = event.sessionId;
    spec.index?.started({
      ...spec.meta,
      sessionId: event.sessionId,
      model: event.model,
      startedAt: new Date(startedAt).toISOString(),
    });
  };
  const renderer = new StreamRenderer(events, spec.streamPartial);

  const killState: { reason: KillReason | null; termination: Promise<void> | null } = {
    reason: null,
    termination: null,
  };
  const kill = (reason: KillReason): void => {
    if (killState.termination !== null || hasExited(child)) return;
    killState.reason = reason;
    spec.events({ type: "killing", reason });
    killState.termination = terminateProcessTree(child, KILL_GRACE_MS);
  };

  const timeout = spec.sessionTimeoutMs
    ? setTimeout(() => kill("timeout"), spec.sessionTimeoutMs)
    : undefined;
  const onAbort = () => kill("abort");
  signal.addEventListener("abort", onAbort, { once: true });

  const rl = createInterface({ input: child.stdout });
  rl.on("line", (line) => renderer.handleLine(line));

  const stderrRl = createInterface({ input: child.stderr });
  stderrRl.on("line", (line) => {
    if (line.trim()) spec.events({ type: "stderr", line });
  });

  try {
    const spawnError = await new Promise<Error | null>((resolvePromise) => {
      child.once("error", (err) => resolvePromise(err));
      child.once("spawn", () => resolvePromise(null));
    });

    if (spawnError) {
      return {
        ok: false,
        durationMs: Date.now() - startedAt,
        error: `Failed to start "${launch.file}": ${spawnError.message}`,
        failureReason: "spawn",
      };
    }
    announceSpawn(child, spec, placed);

    child.on("error", (err) =>
      spec.events({ type: "procError", message: `Process error: ${err.message}` }),
    );
    child.stdin.on("error", (err) =>
      spec.events({ type: "procError", message: `stdin: ${err.message}` }),
    );
    child.stdin.write(spec.prompt);
    child.stdin.end();

    const { code, exitSignal } = await new Promise<{
      code: number | null;
      exitSignal: NodeJS.Signals | null;
    }>((resolvePromise) => {
      child.once("close", (exitCode, closeSignal) =>
        resolvePromise({ code: exitCode, exitSignal: closeSignal }),
      );
    });
    if (killState.termination !== null) await killState.termination;

    const summary = renderer.getSummary();
    const ok = code === 0 && !summary.isError && killState.reason === null;
    const failureReason = ok
      ? undefined
      : classifyFailure(
          killState.reason,
          summary.isError,
          launcherFailureReason(spec.launcher, {
            code,
            signal: exitSignal,
            initialized: indexed.sessionId !== null,
          }),
          spec.resume !== undefined && indexed.sessionId === null,
        );

    if (indexed.sessionId !== null) {
      spec.index?.finished({
        sessionId: indexed.sessionId,
        finishedAt: new Date().toISOString(),
        ok,
        failureReason,
        costUsd: summary.costUsd,
        numTurns: summary.numTurns,
      });
    }

    return {
      ok,
      durationMs: Date.now() - startedAt,
      costUsd: summary.costUsd,
      numTurns: summary.numTurns,
      toolUses: summary.toolUses,
      sessionId: summary.sessionId ?? indexed.sessionId ?? undefined,
      resultText: summary.resultText,
      error: ok ? undefined : describeFailure(failureReason, code, exitSignal),
      failureReason,
      rateLimit: summary.rateLimit,
      apiError: summary.apiError,
      terminalReason: summary.terminalReason,
    };
  } finally {
    if (child.pid !== undefined) spec.placement.lease.exited(child.pid);
    if (timeout) clearTimeout(timeout);
    signal.removeEventListener("abort", onAbort);
    rl.close();
    stderrRl.close();
  }
}

function announceSpawn(
  child: ChildProcess,
  spec: SessionSpec,
  placed: PlacedSession,
): void {
  const { pid } = child;
  if (pid === undefined) return;
  const seq = spec.placement.lease.spawned(pid);
  spec.events({ type: "spawned", pid, ...placed, seq });
}

function classifyFailure(
  killReason: KillReason | null,
  isError: boolean | undefined,
  launcherReason: LauncherFailureReason | null,
  resumeUnstarted: boolean,
): SessionFailureReason {
  if (killReason !== null) return killReason;
  if (resumeUnstarted && launcherReason === null) return "resumeFailed";
  if (isError) return "isError";
  return launcherReason ?? "exit";
}

function describeFailure(
  reason: SessionFailureReason | undefined,
  code: number | null,
  exitSignal: NodeJS.Signals | null,
): string {
  switch (reason) {
    case "timeout":
      return "Session timed out";
    case "abort":
      return "Session aborted";
    case "isError":
      return "Session ended with an error (is_error)";
    case "launcherRefused":
      return `Session launcher refused the session (exit code ${LAUNCHER_REFUSED_EXIT_CODE})`;
    case "poolMemoryLimit":
      return "Session killed by the pool memory limit";
    case "resumeFailed":
      return "Session could not be resumed";
    default:
      return code !== null
        ? `Process exited with code ${code}`
        : `Process terminated by signal ${exitSignal ?? "?"}`;
  }
}

function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}
