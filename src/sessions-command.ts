import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { defineCommand } from "citty";
import {
  fail,
  requestControl,
  SOCKET_ENV_HINT,
  writerFor,
  type ControlCommandIo,
} from "./control-commands.js";
import { projectPaths } from "./paths.js";
import {
  SESSION_AGENTS,
  SESSIONS_LIMIT_DEFAULT,
  SESSIONS_LIMIT_MAX,
  type SessionAgent,
  type SessionRecord,
} from "./sessions/index.js";

function parseLimit(raw: string | undefined): number | null {
  if (raw === undefined) return SESSIONS_LIMIT_DEFAULT;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > SESSIONS_LIMIT_MAX) return null;
  return value;
}

function parseAgent(raw: string | undefined): SessionAgent | null {
  if (raw === undefined) return null;
  return (SESSION_AGENTS as readonly string[]).includes(raw)
    ? (raw as SessionAgent)
    : null;
}

function verdict(record: SessionRecord): string {
  if (record.finishedAt === undefined) return "running";
  return record.ok === true ? "ok" : (record.failureReason ?? "failed");
}

function recordLine(record: SessionRecord): string {
  const parts = [
    record.startedAt,
    record.agent.padEnd(10),
    verdict(record).padEnd(8),
    record.sessionId,
  ];
  if (record.taskId !== undefined) parts.push(record.taskId);
  if (record.costUsd !== undefined) parts.push(`$${record.costUsd.toFixed(4)}`);
  return parts.join(" ");
}

function resolvePath(kikimoraDir: string, path: string): string {
  return isAbsolute(path) ? path : join(kikimoraDir, path);
}

function renderSession(record: SessionRecord, kikimoraDir: string): string[] {
  const lines = [`session   ${record.sessionId}`, `agent     ${record.agent}`];
  if (record.taskId !== undefined) lines.push(`task      ${record.taskId}`);
  if (record.cycle !== undefined) lines.push(`cycle     ${String(record.cycle)}`);
  if (record.model !== undefined) lines.push(`model     ${record.model}`);
  lines.push(`started   ${record.startedAt}`);
  if (record.finishedAt !== undefined) lines.push(`finished  ${record.finishedAt}`);
  lines.push(`result    ${verdict(record)}`);
  if (record.costUsd !== undefined) {
    lines.push(`cost      $${record.costUsd.toFixed(4)}`);
  }
  if (record.numTurns !== undefined) lines.push(`turns     ${String(record.numTurns)}`);
  lines.push(`log       ${resolvePath(kikimoraDir, record.logPath)}`);
  lines.push(`jsonl     ${resolvePath(kikimoraDir, record.jsonlPath)}`);
  return lines;
}

export async function runSessionsList(
  options: {
    agent?: string | undefined;
    task?: string | undefined;
    before?: string | undefined;
    limit?: string | undefined;
    json?: boolean | undefined;
  } & ControlCommandIo = {},
): Promise<void> {
  const limit = parseLimit(options.limit);
  if (limit === null) {
    fail(
      `Invalid limit "${options.limit ?? ""}" — use a whole number from 1 to ${String(SESSIONS_LIMIT_MAX)}.`,
    );
    return;
  }
  const agent = options.agent === undefined ? undefined : parseAgent(options.agent);
  if (agent === null) {
    fail(`Unknown agent "${options.agent ?? ""}" — use ${SESSION_AGENTS.join(", ")}.`);
    return;
  }
  const response = await requestControl(
    {
      cmd: "sessions.list",
      ...(agent === undefined ? {} : { agent }),
      ...(options.task === undefined ? {} : { taskId: options.task }),
      ...(options.before === undefined ? {} : { before: options.before }),
      limit,
    },
    options,
  );
  if (response === null) return;
  const write = writerFor(options);
  if (options.json === true) {
    write(JSON.stringify(response.data, null, 2));
    return;
  }
  if (response.data.length === 0) {
    write("No sessions.");
    return;
  }
  for (const record of response.data) write(recordLine(record));
}

export async function runSessionsShow(
  sessionId: string,
  options: {
    json?: boolean | undefined;
    log?: boolean | undefined;
  } & ControlCommandIo = {},
): Promise<void> {
  if (sessionId.trim() === "") {
    fail("The session id is empty.");
    return;
  }
  const response = await requestControl({ cmd: "sessions.get", sessionId }, options);
  if (response === null) return;
  const write = writerFor(options);
  if (options.json === true) {
    write(JSON.stringify(response.data, null, 2));
    return;
  }
  const { kikimoraDir } = projectPaths(options.projectDir);
  for (const line of renderSession(response.data, kikimoraDir)) write(line);
  if (options.log !== true) return;
  const path = resolvePath(kikimoraDir, response.data.logPath);
  try {
    write("");
    write(await readFile(path, "utf8"));
  } catch {
    fail(`Cannot read the session log ${path}.`);
  }
}

const jsonArg = { type: "boolean", description: "Print JSON instead of text" } as const;

export const sessionsCommand = defineCommand({
  meta: {
    name: "sessions",
    description: `List the sessions the running worker has indexed. ${SOCKET_ENV_HINT}`,
  },
  subCommands: {
    list: defineCommand({
      meta: { name: "list", description: "The newest sessions first" },
      args: {
        agent: {
          type: "string",
          description: `Only one agent (${SESSION_AGENTS.join(", ")})`,
        },
        task: { type: "string", description: "Only sessions for this task id" },
        before: {
          type: "string",
          description: "Only sessions started before this ISO 8601 instant",
        },
        limit: {
          type: "string",
          description: `How many sessions (1-${String(SESSIONS_LIMIT_MAX)}, default ${String(SESSIONS_LIMIT_DEFAULT)})`,
        },
        json: jsonArg,
      },
      run: ({ args }) =>
        runSessionsList({
          agent: args.agent,
          task: args.task,
          before: args.before,
          limit: args.limit,
          json: args.json,
        }),
    }),
    show: defineCommand({
      meta: {
        name: "show",
        description: "The metadata and file paths of one session",
      },
      args: {
        sessionId: { type: "positional", required: true, description: "The session id" },
        log: { type: "boolean", description: "Also print the readable session log" },
        json: jsonArg,
      },
      run: ({ args }) =>
        runSessionsShow(args.sessionId, { json: args.json, log: args.log }),
    }),
  },
});
