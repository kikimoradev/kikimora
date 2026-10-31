import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { defineCommand } from "citty";
import { z } from "zod";
import {
  normalizeHandoffReason,
  writeHandoffMark,
  type HandoffTarget,
} from "./handoff.js";
import { MEMORY_ORDERS, MemoryStore, type TaskSummaryRecord } from "./store.js";

export type MemoryReader = Pick<MemoryStore, "search" | "latestMatches" | "get">;

function formatRecord(record: TaskSummaryRecord): string {
  const status = record.ok ? "success" : "failure";
  const lines = [
    `### ${record.taskId} — ${record.headline}`,
    `Task: ${record.title}`,
    `Attempt: ${record.attempt}, result: ${status}, date: ${record.createdAt}`,
  ];
  if (record.handedOff === true) {
    lines.push(`Handed off to a human: ${record.handoffReason ?? "no reason given"}`);
  }
  if (record.error !== undefined) lines.push(`Error: ${record.error}`);
  lines.push("", record.summary);
  return lines.join("\n");
}

function textResult(records: TaskSummaryRecord[], emptyMessage: string) {
  const text =
    records.length === 0 ? emptyMessage : records.map(formatRecord).join("\n\n---\n\n");
  return { content: [{ type: "text" as const, text }] };
}

function textContent(text: string) {
  return [{ type: "text" as const, text }];
}

function registerHandoffTool(server: McpServer, target: HandoffTarget): void {
  server.registerTool(
    "task_handoff",
    {
      title: "Mark the task as handed off to a human",
      description:
        "Marks the task of this session as handed off to a human, with a " +
        "short reason (one sentence). Call it before you finish when you " +
        "leave the task for a person to act on. The last call wins; the " +
        "mark travels with the task result and its memory entry.",
      inputSchema: {
        reason: z
          .string()
          .describe("One sentence: why the task waits for a human and for what"),
      },
    },
    async ({ reason }) => {
      const checked = normalizeHandoffReason(reason);
      if (!checked.ok) {
        return { content: textContent(checked.error), isError: true };
      }
      await writeHandoffMark(target, checked.reason);
      return {
        content: textContent(
          `Task ${target.taskId} marked as handed off to a human: ${checked.reason}. ` +
            "Finish the task as usual; the mark travels with its result.",
        ),
      };
    },
  );
}

export interface MemoryMcpServerOptions {
  handoff?: HandoffTarget | undefined;
}

export function createMemoryMcpServer(
  reader: MemoryReader,
  options: MemoryMcpServerOptions = {},
): McpServer {
  const server = new McpServer({ name: "kikimora-memory", version: "1.0.0" });

  server.registerTool(
    "memory_search",
    {
      title: "Search task memory",
      description:
        "Full-text search over long-term memory: summaries of previously " +
        "completed tasks (decisions, dead ends, pitfalls). Picks the entries " +
        "that contain the most query words, a rare word counting more than " +
        "a common one, a word in the task id or title counting twice and " +
        "the latest entry winning among equals, and lists " +
        "them newest first; pass order rank to pick and list them by " +
        "relevance instead.",
      inputSchema: {
        query: z
          .string()
          .min(1)
          .describe("Keywords, e.g. task source, project, error message"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe("Maximum number of results (default 10)"),
        order: z
          .enum(MEMORY_ORDERS)
          .optional()
          .describe(
            "newest: the entries with the most query words, rare words and words in the task id or title counting more, newest first (default); rank: best match first",
          ),
      },
    },
    ({ query, limit, order }) => {
      const matches =
        order === "rank"
          ? reader.search(query, limit ?? 10)
          : reader.latestMatches(query, limit ?? 10);
      return textResult(matches, "No results in memory.");
    },
  );

  server.registerTool(
    "memory_get",
    {
      title: "Task summary history",
      description:
        "Returns all session summaries for a task with the given ID, " +
        "in chronological order.",
      inputSchema: {
        taskId: z
          .string()
          .min(1)
          .describe("Exact task identifier (the “ID” field from the task description)"),
      },
    },
    ({ taskId }) => textResult(reader.get(taskId), "No summaries for this task."),
  );

  if (options.handoff !== undefined) registerHandoffTool(server, options.handoff);

  return server;
}

export function handoffTargetOf(
  taskId: string | undefined,
  file: string | undefined,
): HandoffTarget | undefined {
  if (taskId === undefined || taskId === "" || file === undefined || file === "") {
    return undefined;
  }
  return { taskId, file };
}

export async function runMemoryMcpServer(
  dbPath: string,
  handoff?: HandoffTarget,
): Promise<void> {
  const store = MemoryStore.open(dbPath, { readOnly: true });
  const server = createMemoryMcpServer(store, { handoff });
  await server.connect(new StdioServerTransport());
}

export const mcpServeCommand = defineCommand({
  meta: {
    name: "serve",
    description:
      "MCP server (stdio) exposing task summary memory for the executor session",
  },
  args: {
    db: {
      type: "string",
      required: true,
      description: "Path to the memory database file (SQLite)",
    },
    task: {
      type: "string",
      description: "ID of the session's task; with --handoff enables task_handoff",
    },
    handoff: {
      type: "string",
      description: "File the task_handoff tool writes the mark to; needs --task",
    },
  },
  run: ({ args }) =>
    runMemoryMcpServer(args.db, handoffTargetOf(args.task, args.handoff)),
});
