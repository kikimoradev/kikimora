import { realpathSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { HandoffTarget } from "./memory/handoff.js";
import { MCP_DIR_NAME } from "./paths.js";
import type { McpServer } from "./types.js";

export const MCP_ROLES = ["monitor", "executor", "summarizer"] as const;

export type McpRole = (typeof MCP_ROLES)[number];

export const MEMORY_SERVER_NAME = "memory";

export const PLAYWRIGHT_SERVER_NAME = "playwright";

export const PLAYWRIGHT_MCP_COMMAND = "playwright-mcp";

export interface McpConfigInput {
  role: McpRole;
  servers: Record<string, McpServer>;
  selected: readonly string[];
  browser: boolean;
  memoryDbPath: string | null;
  handoff?: HandoffTarget | undefined;
  playwrightOutputDir: string;
  entry?: string | undefined;
}

export interface McpConfigDocument {
  mcpServers: Record<string, McpServer>;
}

function memoryServer(
  dbPath: string,
  entry: string,
  handoff: HandoffTarget | undefined,
): McpServer {
  let resolved: string;
  try {
    resolved = realpathSync(entry);
  } catch {
    resolved = entry;
  }
  const nodeFlags = ["--disable-warning=ExperimentalWarning"];
  const serve = ["mcp", "serve", "--db", dbPath];
  if (handoff !== undefined) {
    serve.push("--task", handoff.taskId, "--handoff", handoff.file);
  }
  const args = resolved.endsWith(".ts")
    ? [...nodeFlags, "--import", "tsx", resolved, ...serve]
    : [...nodeFlags, resolved, ...serve];
  return { command: process.execPath, args };
}

function playwrightServer(outputDir: string): McpServer {
  return {
    command: PLAYWRIGHT_MCP_COMMAND,
    args: ["--headless", "--isolated", "--no-sandbox", "--output-dir", outputDir],
  };
}

export function composeMcpConfig(input: McpConfigInput): McpConfigDocument {
  const mcpServers: Record<string, McpServer> = {};
  if (input.memoryDbPath !== null) {
    mcpServers[MEMORY_SERVER_NAME] = memoryServer(
      input.memoryDbPath,
      input.entry ?? process.argv[1] ?? "",
      input.handoff,
    );
  }
  if (input.browser) {
    mcpServers[PLAYWRIGHT_SERVER_NAME] = playwrightServer(input.playwrightOutputDir);
  }
  for (const name of input.selected) {
    const server = input.servers[name];
    if (server !== undefined) mcpServers[name] = server;
  }
  return { mcpServers };
}

export async function writeMcpConfig(
  dataDir: string,
  input: McpConfigInput,
): Promise<string> {
  const dir = join(dataDir, MCP_DIR_NAME);
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${input.role}.json`);
  const tmpPath = `${file}.tmp`;
  const document = `${JSON.stringify(composeMcpConfig(input), null, 2)}\n`;
  await writeFile(tmpPath, document, "utf8");
  await rename(tmpPath, file);
  return file;
}
