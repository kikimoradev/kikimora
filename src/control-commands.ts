import { defineCommand } from "citty";
import { readFile } from "node:fs/promises";
import { sendControlRequest } from "./control-client.js";
import {
  CONTROL_TARGETS,
  UNRECOGNIZED_REQUEST,
  type ControlAgentStatus,
  type ControlDrainStatus,
  type ControlPhase,
  type ControlRequestInput,
  type ControlStatus,
  type ControlSuccess,
  type ControlTarget,
  type WorkerIdentity,
} from "./control-protocol.js";
import { DRAIN_TIMEOUT_MAX_MS } from "./drain.js";
import { logger } from "./logger.js";
import { CONTROL_SOCKET_ENV, controlSocketPath } from "./paths.js";

export interface ControlCommandIo {
  projectDir?: string | undefined;
  write?: ((line: string) => void) | undefined;
  readStdin?: (() => Promise<string>) | undefined;
}

export const SOCKET_ENV_HINT = `Env: ${CONTROL_SOCKET_ENV} overrides the control socket path.`;

export function writerFor(io: ControlCommandIo): (line: string) => void {
  return (
    io.write ??
    ((line: string) => {
      process.stdout.write(`${line}\n`);
    })
  );
}

export function fail(message: string): void {
  logger.error(message);
  process.exitCode = 1;
}

export function readStdinText(): Promise<string> {
  if (process.stdin.isTTY) {
    return Promise.reject(new Error("Pass a file path or pipe the content on stdin."));
  }
  return new Promise((resolve, reject) => {
    let content = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => {
      content += chunk;
    });
    process.stdin.once("end", () => {
      resolve(content);
    });
    process.stdin.once("error", reject);
  });
}

export async function readTextSource(
  source: string | undefined,
  io: ControlCommandIo,
): Promise<string | null> {
  if (source === undefined || source === "-") {
    return (io.readStdin ?? readStdinText)();
  }
  try {
    return await readFile(source, "utf8");
  } catch {
    fail(`Cannot read "${source}".`);
    return null;
  }
}

function describeRejection(cmd: string, error: string): string {
  return error === UNRECOGNIZED_REQUEST
    ? `The running worker does not support "${cmd}" — it was started from an older brownie; restart it to pick up the installed version.`
    : error;
}

export async function requestControl<R extends ControlRequestInput>(
  request: R,
  io: ControlCommandIo,
): Promise<ControlSuccess<R["cmd"]> | null> {
  try {
    const response = await sendControlRequest(controlSocketPath(io.projectDir), request);
    if (!response.ok) {
      fail(describeRejection(request.cmd, response.error));
      return null;
    }
    return response;
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
    return null;
  }
}

function formatUptime(startedAt: string): string {
  const elapsedMs = Math.max(0, Date.now() - Date.parse(startedAt));
  const totalMinutes = Math.floor(elapsedMs / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours > 0) return `${String(hours)}h ${String(minutes)}m`;
  if (totalMinutes > 0) return `${String(minutes)}m`;
  return `${String(Math.floor(elapsedMs / 1000))}s`;
}

function clockTime(iso: string): string {
  return new Date(iso).toLocaleTimeString();
}

function describePhase(phase: ControlPhase): string {
  const parts = [phase.kind];
  if (phase.cycle !== undefined) parts.push(`cycle ${String(phase.cycle)}`);
  if (phase.taskId !== undefined) parts.push(phase.taskId);
  if (phase.until !== undefined) parts.push(`until ${clockTime(phase.until)}`);
  if (phase.reason !== undefined) parts.push(phase.reason);
  return parts.join(" · ");
}

function agentLine(name: string, agent: ControlAgentStatus<{ ok: boolean }>): string {
  return `${name.padEnd(9)} ${agent.control.padEnd(8)} ${describePhase(agent.phase)}`;
}

function orUnknown(value: string | undefined): string {
  return value ?? "unknown";
}

function identityLine(identity: WorkerIdentity): string {
  return `brownie ${identity.version} · claude ${orUnknown(identity.claudeVersion)} · auth ${orUnknown(identity.authKind)} · pid ${String(identity.pid)}`;
}

function renderIdentity(identity: WorkerIdentity): string[] {
  return [
    `brownie   ${identity.version}`,
    `claude    ${orUnknown(identity.claudeVersion)}`,
    `node      ${identity.nodeVersion}`,
    `auth      ${orUnknown(identity.authKind)}`,
    `pid       ${String(identity.pid)}`,
    `started   ${identity.startedAt} · up ${formatUptime(identity.startedAt)}`,
    `project   ${identity.projectDir}`,
  ];
}

function drainLine(drain: ControlDrainStatus): string {
  const parts = [`since ${clockTime(drain.since)}`];
  if (drain.until !== undefined) parts.push(`until ${clockTime(drain.until)}`);
  parts.push(drain.reason);
  return `draining  ${parts.join(" · ")}`;
}

function renderStatus(status: ControlStatus): string[] {
  const { stats, taskCounts } = status;
  const mode = status.headless ? "headless" : "interactive";
  const lines = [
    `${identityLine(status)} · up ${formatUptime(status.startedAt)} · ${mode}`,
    `project   ${status.projectDir}`,
    agentLine("monitor", status.agents.monitor),
    agentLine("executor", status.agents.executor),
    `tasks     pending ${String(taskCounts.pending)} · in_progress ${String(taskCounts.in_progress)} · done ${String(taskCounts.done)} · failed ${String(taskCounts.failed)} · cancelled ${String(taskCounts.cancelled)}`,
    `stats     cycles ${String(stats.cycles)} · tasks ok ${String(stats.tasksSucceeded)} · tasks failed ${String(stats.tasksFailed)} · cost $${stats.totalCostUsd.toFixed(4)}`,
  ];
  if (status.drain !== undefined) lines.push(drainLine(status.drain));
  return lines;
}

export async function runStatus(
  options: { json?: boolean | undefined } & ControlCommandIo = {},
): Promise<void> {
  const write = writerFor(options);
  const response = await requestControl({ cmd: "status" }, options);
  if (response === null) return;
  if (options.json === true) {
    write(JSON.stringify(response.data, null, 2));
    return;
  }
  for (const line of renderStatus(response.data)) write(line);
}

export async function runVersion(
  options: { json?: boolean | undefined } & ControlCommandIo = {},
): Promise<void> {
  const write = writerFor(options);
  const response = await requestControl({ cmd: "version" }, options);
  if (response === null) return;
  if (options.json === true) {
    write(JSON.stringify(response.data, null, 2));
    return;
  }
  for (const line of renderIdentity(response.data)) write(line);
}

function parseTarget(value: string | undefined): ControlTarget | null {
  if (value === undefined) return "all";
  return (CONTROL_TARGETS as readonly string[]).includes(value) && value !== "all"
    ? (value as ControlTarget)
    : null;
}

export async function runControlAction(
  action: "pause" | "resume",
  agentArg: string | undefined,
  options: ControlCommandIo = {},
): Promise<void> {
  const target = parseTarget(agentArg);
  if (target === null) {
    fail(
      `Unknown agent "${agentArg ?? ""}" — use monitor or executor, or omit it for both.`,
    );
    return;
  }
  const response = await requestControl({ cmd: action, agent: target }, options);
  if (response === null) return;
  const label = target === "all" ? "monitor and executor" : target;
  logger.success(action === "pause" ? `Pausing ${label}.` : `Resumed ${label}.`);
}

function parseDrainTimeout(raw: string | undefined): number | undefined | null {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > DRAIN_TIMEOUT_MAX_MS) return null;
  return value;
}

export async function runDrain(
  options: {
    timeout?: string | undefined;
    json?: boolean | undefined;
  } & ControlCommandIo = {},
): Promise<void> {
  const timeoutMs = parseDrainTimeout(options.timeout);
  if (timeoutMs === null) {
    fail(
      `Invalid timeout "${options.timeout ?? ""}" — use a whole number of milliseconds from 1 to ${String(DRAIN_TIMEOUT_MAX_MS)}.`,
    );
    return;
  }
  const response = await requestControl({ cmd: "drain", timeoutMs }, options);
  if (response === null) return;
  const ack = response.data;
  if (options.json === true) {
    writerFor(options)(JSON.stringify(ack, null, 2));
    return;
  }
  const deadline =
    ack.until === undefined ? "" : `, by ${clockTime(ack.until)} at the latest`;
  logger.success(
    `Draining since ${clockTime(ack.since)} — the worker exits once its current sessions finish${deadline}.`,
  );
}

export const statusCommand = defineCommand({
  meta: {
    name: "status",
    description: `Show the status of the brownie worker running in this project. ${SOCKET_ENV_HINT}`,
  },
  args: {
    json: { type: "boolean", description: "Print the raw status as JSON" },
  },
  run: ({ args }) => runStatus({ json: args.json }),
});

export const versionCommand = defineCommand({
  meta: {
    name: "version",
    description: `Show the versions and identity of the brownie worker running in this project (brownie --version prints the installed CLI's version instead). ${SOCKET_ENV_HINT}`,
  },
  args: {
    json: { type: "boolean", description: "Print the raw identity as JSON" },
  },
  run: ({ args }) => runVersion({ json: args.json }),
});

export const pauseCommand = defineCommand({
  meta: {
    name: "pause",
    description: "Pause the running worker's agents (they finish their session first).",
  },
  args: {
    agent: {
      type: "positional",
      required: false,
      description: "monitor or executor (default: both)",
    },
  },
  run: ({ args }) => runControlAction("pause", args.agent),
});

export const resumeCommand = defineCommand({
  meta: {
    name: "resume",
    description: "Resume the running worker's paused agents.",
  },
  args: {
    agent: {
      type: "positional",
      required: false,
      description: "monitor or executor (default: both)",
    },
  },
  run: ({ args }) => runControlAction("resume", args.agent),
});

export const drainCommand = defineCommand({
  meta: {
    name: "drain",
    description:
      "Let the running worker finish its current sessions, then exit (it takes no new work meanwhile).",
  },
  args: {
    timeout: {
      type: "string",
      description: `Stop at the latest this many milliseconds from now, killing what still runs (1-${String(DRAIN_TIMEOUT_MAX_MS)})`,
    },
    json: { type: "boolean", description: "Print the acknowledgement as JSON" },
  },
  run: ({ args }) => runDrain({ timeout: args.timeout, json: args.json }),
});
