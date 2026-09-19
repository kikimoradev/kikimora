import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { defineCommand } from "citty";
import { z } from "zod";
import { MemoryStore, type TaskSummaryRecord } from "./store.js";

export type MemoryReader = Pick<MemoryStore, "search" | "get">;

function formatRecord(record: TaskSummaryRecord): string {
  const status = record.ok ? "success" : "failure";
  const lines = [
    `### ${record.taskId} — ${record.headline}`,
    `Task: ${record.title}`,
    `Attempt: ${record.attempt}, result: ${status}, date: ${record.createdAt}`,
  ];
  if (record.error !== undefined) lines.push(`Error: ${record.error}`);
  lines.push("", record.summary);
  return lines.join("\n");
}

function textResult(records: TaskSummaryRecord[], emptyMessage: string) {
  const text =
    records.length === 0 ? emptyMessage : records.map(formatRecord).join("\n\n---\n\n");
  return { content: [{ type: "text" as const, text }] };
}

export function createMemoryMcpServer(reader: MemoryReader): McpServer {
  const server = new McpServer({ name: "kikimora-memory", version: "1.0.0" });

  server.registerTool(
    "memory_search",
    {
      title: "Search task memory",
      description:
        "Full-text search over long-term memory: summaries of previously " +
        "completed tasks (decisions, dead ends, pitfalls). Results sorted by " +
        "relevance.",
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
      },
    },
    ({ query, limit }) =>
      textResult(reader.search(query, limit ?? 10), "No results in memory."),
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

  return server;
}

export async function runMemoryMcpServer(dbPath: string): Promise<void> {
  const store = MemoryStore.open(dbPath, { readOnly: true });
  const server = createMemoryMcpServer(store);
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
  },
  run: ({ args }) => runMemoryMcpServer(args.db),
});
