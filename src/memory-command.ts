import { resolve } from "node:path";
import { defineCommand } from "citty";
import {
  fail,
  requestControl,
  SOCKET_ENV_HINT,
  writerFor,
  type ControlCommandIo,
} from "./control-commands.js";
import { MEMORY_LIMIT_DEFAULT, MEMORY_LIMIT_MAX } from "./control-protocol.js";
import type { TaskSummaryRecord } from "./memory/store.js";
import { formatBytes } from "./units.js";

function parseLimit(raw: string | undefined): number | null {
  if (raw === undefined) return MEMORY_LIMIT_DEFAULT;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > MEMORY_LIMIT_MAX) return null;
  return value;
}

function invalidLimit(raw: string | undefined): string {
  return `Invalid limit "${raw ?? ""}" — use a whole number from 1 to ${String(MEMORY_LIMIT_MAX)}.`;
}

function recordLine(record: TaskSummaryRecord): string {
  const verdict = record.ok ? "ok" : "failed";
  return `#${String(record.id)} ${record.createdAt} ${verdict} ${record.taskId} (attempt ${String(record.attempt)}) — ${record.headline}`;
}

function writeRecords(
  records: TaskSummaryRecord[],
  options: { json?: boolean | undefined } & ControlCommandIo,
): void {
  const write = writerFor(options);
  if (options.json === true) {
    write(JSON.stringify(records, null, 2));
    return;
  }
  if (records.length === 0) {
    write("No memory entries.");
    return;
  }
  for (const record of records) write(recordLine(record));
}

export async function runMemorySearch(
  query: string,
  options: {
    limit?: string | undefined;
    json?: boolean | undefined;
  } & ControlCommandIo = {},
): Promise<void> {
  if (query.trim() === "") {
    fail("The search query is empty.");
    return;
  }
  const limit = parseLimit(options.limit);
  if (limit === null) {
    fail(invalidLimit(options.limit));
    return;
  }
  const response = await requestControl({ cmd: "memory.search", query, limit }, options);
  if (response === null) return;
  writeRecords(response.data, options);
}

export async function runMemoryRecent(
  options: {
    limit?: string | undefined;
    json?: boolean | undefined;
  } & ControlCommandIo = {},
): Promise<void> {
  const limit = parseLimit(options.limit);
  if (limit === null) {
    fail(invalidLimit(options.limit));
    return;
  }
  const response = await requestControl({ cmd: "memory.recent", limit }, options);
  if (response === null) return;
  writeRecords(response.data, options);
}

export async function runMemoryExport(
  path: string,
  options: { json?: boolean | undefined } & ControlCommandIo = {},
): Promise<void> {
  if (path.trim() === "") {
    fail("The export path is empty.");
    return;
  }
  const response = await requestControl(
    { cmd: "memory.export", path: resolve(path) },
    options,
  );
  if (response === null) return;
  const write = writerFor(options);
  if (options.json === true) {
    write(JSON.stringify(response.data, null, 2));
    return;
  }
  const { entries, bytes } = response.data;
  write(
    `Exported ${String(entries)} ${entries === 1 ? "entry" : "entries"} (${formatBytes(bytes)}) to ${response.data.path}`,
  );
}

const limitArg = {
  type: "string",
  description: `How many entries (1-${String(MEMORY_LIMIT_MAX)}, default ${String(MEMORY_LIMIT_DEFAULT)})`,
} as const;
const jsonArg = { type: "boolean", description: "Print JSON instead of text" } as const;

export const memoryCommand = defineCommand({
  meta: {
    name: "memory",
    description: `Search or export the running worker's long-term memory. ${SOCKET_ENV_HINT}`,
  },
  subCommands: {
    search: defineCommand({
      meta: { name: "search", description: "Full-text search over task summaries" },
      args: {
        query: { type: "positional", required: true, description: "Search terms" },
        limit: limitArg,
        json: jsonArg,
      },
      run: ({ args }) =>
        runMemorySearch(args.query, { limit: args.limit, json: args.json }),
    }),
    recent: defineCommand({
      meta: { name: "recent", description: "The newest task summaries" },
      args: { limit: limitArg, json: jsonArg },
      run: ({ args }) => runMemoryRecent({ limit: args.limit, json: args.json }),
    }),
    export: defineCommand({
      meta: {
        name: "export",
        description:
          "Copy memory.db, the session index included, to a new file while the worker runs",
      },
      args: {
        path: {
          type: "positional",
          required: true,
          description: "Where the worker writes the copy; it must not exist yet",
        },
        json: jsonArg,
      },
      run: ({ args }) => runMemoryExport(args.path, { json: args.json }),
    }),
  },
});
