import { readdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  composeMcpConfig,
  writeMcpConfig,
  type McpConfigInput,
} from "../src/mcp-config.js";
import type { McpServer } from "../src/types.js";
import { createTempDir, removeTempDir } from "./helpers.js";

const linter: McpServer = { command: "run-linter", args: ["--stdio"], env: {} };
const sentry: McpServer = {
  type: "http",
  url: "https://mcp.sentry.dev/mcp",
  headers: { Authorization: "Bearer ${TOOL_SENTRY_TOKEN}" },
};

function input(overrides: Partial<McpConfigInput> = {}): McpConfigInput {
  return {
    role: "executor",
    servers: {},
    selected: [],
    browser: false,
    memoryDbPath: null,
    playwrightOutputDir: "/data/playwright",
    entry: "/repo/dist/index.js",
    ...overrides,
  };
}

describe("composeMcpConfig", () => {
  it("returns an empty document when nothing is selected", () => {
    expect(composeMcpConfig(input())).toEqual({ mcpServers: {} });
  });

  it("runs the memory server via tsx for a .ts entry", () => {
    const { mcpServers } = composeMcpConfig(
      input({ memoryDbPath: "/data/memory.db", entry: "/repo/src/index.ts" }),
    );

    expect(mcpServers.memory).toEqual({
      command: process.execPath,
      args: [
        "--disable-warning=ExperimentalWarning",
        "--import",
        "tsx",
        "/repo/src/index.ts",
        "mcp",
        "serve",
        "--db",
        "/data/memory.db",
      ],
    });
  });

  it("runs the memory server directly with node for a .js entry", () => {
    const { mcpServers } = composeMcpConfig(input({ memoryDbPath: "/data/memory.db" }));

    expect(mcpServers.memory).toEqual({
      command: process.execPath,
      args: [
        "--disable-warning=ExperimentalWarning",
        "/repo/dist/index.js",
        "mcp",
        "serve",
        "--db",
        "/data/memory.db",
      ],
    });
  });

  it("resolves a bin symlink to the real entry file", async () => {
    const dir = await createTempDir();
    try {
      const realEntry = join(dir, "entry.js");
      const link = join(dir, "kikimora");
      await writeFile(realEntry, "", "utf8");
      await symlink(realEntry, link);

      const { mcpServers } = composeMcpConfig(
        input({ memoryDbPath: "/data/memory.db", entry: link }),
      );

      expect((mcpServers.memory as { args: string[] }).args[1]).toBe(
        await realpath(realEntry),
      );
    } finally {
      await removeTempDir(dir);
    }
  });

  it("omits the memory server without a database path", () => {
    expect(composeMcpConfig(input()).mcpServers.memory).toBeUndefined();
  });

  it("falls back to the running entry point when none is given", () => {
    const { mcpServers } = composeMcpConfig(
      input({ memoryDbPath: "/data/memory.db", entry: undefined }),
    );

    expect((mcpServers.memory as { args: string[] }).args).toContain(
      process.argv[1] ?? "",
    );
  });

  it("skips a selected server that is not in the catalogue", () => {
    expect(composeMcpConfig(input({ selected: ["gone"] })).mcpServers).toEqual({});
  });

  it("adds the headless playwright server with browser: true", () => {
    const { mcpServers } = composeMcpConfig(input({ browser: true }));

    expect(mcpServers.playwright).toEqual({
      command: "playwright-mcp",
      args: [
        "--headless",
        "--isolated",
        "--no-sandbox",
        "--output-dir",
        "/data/playwright",
      ],
    });
  });

  it("orders memory and playwright before the selected servers", () => {
    const { mcpServers } = composeMcpConfig(
      input({
        memoryDbPath: "/data/memory.db",
        browser: true,
        servers: { linter, sentry },
        selected: ["sentry", "linter"],
      }),
    );

    expect(Object.keys(mcpServers)).toEqual(["memory", "playwright", "sentry", "linter"]);
    expect(mcpServers.sentry).toEqual(sentry);
  });

  it("copies a selected server entry unchanged and skips an unselected one", () => {
    const { mcpServers } = composeMcpConfig(
      input({ servers: { linter, sentry }, selected: ["linter"] }),
    );

    expect(mcpServers).toEqual({ linter });
  });
});

describe("writeMcpConfig", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await createTempDir();
  });

  afterEach(() => removeTempDir(dir));

  it("writes one file per role under mcp/ and returns its path", async () => {
    const monitorFile = await writeMcpConfig(dir, input({ role: "monitor" }));
    const summarizerFile = await writeMcpConfig(dir, input({ role: "summarizer" }));

    expect(monitorFile).toBe(join(dir, "mcp", "monitor.json"));
    expect(summarizerFile).toBe(join(dir, "mcp", "summarizer.json"));
    expect(JSON.parse(await readFile(summarizerFile, "utf8"))).toEqual({
      mcpServers: {},
    });
  });

  it("rewrites the file on every call and leaves no temporary file behind", async () => {
    const file = await writeMcpConfig(dir, input({ servers: { linter } }));
    await writeMcpConfig(dir, input({ servers: { linter }, selected: ["linter"] }));

    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
      mcpServers: { linter },
    });
    expect(await readdir(join(dir, "mcp"))).toEqual(["executor.json"]);
  });
});
