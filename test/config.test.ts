import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  COMMAND,
  loadSettings,
  loadWorkerConfig,
  resolvePromptPaths,
  settingsSchema,
} from "../src/config.js";
import { packagePromptsDir } from "../src/paths.js";
import {
  createTempDir,
  removeTempDir,
  seedProject,
  seedSystemPrompts,
} from "./helpers.js";

describe("settingsSchema", () => {
  it("applies default values to an empty object", () => {
    const settings = settingsSchema.parse({});
    expect(settings.monitor.model).toBe("haiku");
    expect(settings.monitor.effort).toBe("medium");
    expect(settings.monitor.intervalMinutes).toBe(15);
    expect(settings.monitor.activeHours).toBeUndefined();
    expect(settings.monitor.activeDays).toBeUndefined();
    expect(settings.executor.model).toBe("opus");
    expect(settings.executor.effort).toBe("high");
    expect(settings.executor.maxTaskAttempts).toBe(3);
    expect(settings.executor.retryDelayMs).toBe(30_000);
    expect(settings.summarizer.model).toBe("sonnet");
    expect(settings.summarizer.effort).toBe("medium");
    expect(settings.summarizer.sessionTimeoutMs).toBe(300_000);
    expect(settings.streamPartial).toBe(true);
    expect(settings.browser).toBe(false);
    expect(settings.shutdownGraceMs).toBe(0);
    expect(settings.mcpServers).toEqual({});
    expect(settings.monitor.mcpServers).toEqual([]);
    expect(settings.executor.mcpServers).toEqual([]);
  });

  it("accepts a shutdown grace of whole milliseconds up to a day", () => {
    expect(settingsSchema.parse({ shutdownGraceMs: 120_000 }).shutdownGraceMs).toBe(
      120_000,
    );
    expect(settingsSchema.parse({ shutdownGraceMs: 86_400_000 }).shutdownGraceMs).toBe(
      86_400_000,
    );
  });

  it("rejects a negative, fractional or over-a-day shutdown grace", () => {
    for (const shutdownGraceMs of [-1, 1.5, 86_400_001, "120000"]) {
      expect(settingsSchema.safeParse({ shutdownGraceMs }).success).toBe(false);
    }
  });

  it("rejects a non-positive monitor interval", () => {
    expect(settingsSchema.safeParse({ monitor: { intervalMinutes: 0 } }).success).toBe(
      false,
    );
    expect(settingsSchema.safeParse({ monitor: { intervalMinutes: -5 } }).success).toBe(
      false,
    );
  });

  it("accepts a fractional monitor interval", () => {
    const settings = settingsSchema.parse({ monitor: { intervalMinutes: 1.5 } });
    expect(settings.monitor.intervalMinutes).toBe(1.5);
  });

  it("rejects an unknown effort level", () => {
    expect(settingsSchema.safeParse({ monitor: { effort: "turbo" } }).success).toBe(
      false,
    );
    expect(settingsSchema.safeParse({ executor: { effort: "turbo" } }).success).toBe(
      false,
    );
    expect(settingsSchema.safeParse({ summarizer: { effort: "turbo" } }).success).toBe(
      false,
    );
  });

  it("rejects a non-boolean streamPartial", () => {
    expect(settingsSchema.safeParse({ streamPartial: "yes" }).success).toBe(false);
  });

  it("rejects an unknown top-level key", () => {
    expect(settingsSchema.safeParse({ montior: {} }).success).toBe(false);
  });

  it("rejects an unknown nested key", () => {
    expect(settingsSchema.safeParse({ monitor: { modle: "opus" } }).success).toBe(false);
  });

  it("accepts valid active hours and days", () => {
    const settings = settingsSchema.parse({
      monitor: { activeHours: "08:00-18:00", activeDays: "mon-fri" },
    });
    expect(settings.monitor.activeHours).toBe("08:00-18:00");
    expect(settings.monitor.activeDays).toBe("mon-fri");
  });

  it("rejects an invalid active hours format", () => {
    expect(settingsSchema.safeParse({ monitor: { activeHours: "8-18" } }).success).toBe(
      false,
    );
  });

  it("rejects identical start and end of active hours", () => {
    expect(
      settingsSchema.safeParse({ monitor: { activeHours: "08:00-08:00" } }).success,
    ).toBe(false);
  });

  it("rejects an unknown active day", () => {
    expect(settingsSchema.safeParse({ monitor: { activeDays: "mo" } }).success).toBe(
      false,
    );
  });

  it("accepts stdio and http MCP servers selected per agent", () => {
    const settings = settingsSchema.parse({
      browser: true,
      mcpServers: {
        sentry: {
          type: "http",
          url: "https://mcp.sentry.dev/mcp",
          headers: { Authorization: "Bearer ${TOOL_SENTRY_TOKEN}" },
        },
        linter: { command: "run-linter", args: ["--stdio"], env: { LOG_LEVEL: "debug" } },
      },
      monitor: { mcpServers: ["sentry"] },
      executor: { mcpServers: ["sentry", "linter"] },
    });

    expect(settings.browser).toBe(true);
    expect(settings.monitor.mcpServers).toEqual(["sentry"]);
    expect(settings.executor.mcpServers).toEqual(["sentry", "linter"]);
    expect(settings.mcpServers.linter).toEqual({
      command: "run-linter",
      args: ["--stdio"],
      env: { LOG_LEVEL: "debug" },
    });
  });

  it("fills in empty args, env and headers for a sparse server entry", () => {
    const settings = settingsSchema.parse({
      mcpServers: {
        linter: { command: "run-linter" },
        docs: { type: "sse", url: "https://docs.example/mcp" },
      },
    });

    expect(settings.mcpServers.linter).toEqual({
      command: "run-linter",
      args: [],
      env: {},
    });
    expect(settings.mcpServers.docs).toEqual({
      type: "sse",
      url: "https://docs.example/mcp",
      headers: {},
    });
  });

  it("rejects a reserved MCP server name at its own path", () => {
    for (const name of ["memory", "playwright"]) {
      const parsed = settingsSchema.safeParse({
        mcpServers: { [name]: { command: "x" } },
      });
      expect(parsed.success).toBe(false);
      expect(parsed.error?.issues[0]?.path.join(".")).toBe(`mcpServers.${name}`);
      expect(parsed.error?.issues[0]?.message).toBe(`"${name}" is reserved`);
    }
  });

  it("rejects an unknown server name in an agent list at the list index", () => {
    const parsed = settingsSchema.safeParse({ executor: { mcpServers: ["nope"] } });

    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.path.join(".")).toBe("executor.mcpServers.0");
    expect(parsed.error?.issues[0]?.message).toBe('unknown MCP server "nope"');
  });

  it("rejects an MCP server name outside the allowed pattern", () => {
    expect(
      settingsSchema.safeParse({ mcpServers: { "Bad Name": { command: "x" } } }).success,
    ).toBe(false);
    expect(
      settingsSchema.safeParse({ monitor: { mcpServers: ["Bad Name"] } }).success,
    ).toBe(false);
  });

  it("rejects an unknown key, a non-uppercase env name and a malformed url in a server", () => {
    expect(
      settingsSchema.safeParse({ mcpServers: { a: { command: "x", cwd: "/tmp" } } })
        .success,
    ).toBe(false);
    expect(
      settingsSchema.safeParse({
        mcpServers: { a: { command: "x", env: { lower: "1" } } },
      }).success,
    ).toBe(false);
    expect(
      settingsSchema.safeParse({ mcpServers: { a: { type: "http", url: "nope" } } })
        .success,
    ).toBe(false);
  });

  it("rejects a non-boolean browser", () => {
    expect(settingsSchema.safeParse({ browser: "yes" }).success).toBe(false);
  });

  it("has no mcpServers key for the summarizer", () => {
    expect(settingsSchema.safeParse({ summarizer: { mcpServers: [] } }).success).toBe(
      false,
    );
  });
});

describe("loadSettings", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await createTempDir();
  });

  afterEach(async () => {
    await removeTempDir(dir);
  });

  it("throws with a configure hint when the file is missing", async () => {
    await expect(loadSettings(join(dir, "settings.json"))).rejects.toThrow(
      /interactive terminal/,
    );
  });

  it("throws a readable error on invalid JSON", async () => {
    const file = join(dir, "settings.json");
    await writeFile(file, "{", "utf8");
    await expect(loadSettings(file)).rejects.toThrow(/Invalid JSON in/);
  });

  it("throws a validation error naming the key on a schema violation", async () => {
    const file = join(dir, "settings.json");
    await writeFile(file, JSON.stringify({ monitor: { effort: "turbo" } }), "utf8");
    await expect(loadSettings(file)).rejects.toThrow(
      /Invalid configuration[\s\S]*monitor\.effort/,
    );
  });

  it("parses valid settings with defaults filled in", async () => {
    const file = join(dir, "settings.json");
    await writeFile(file, JSON.stringify({ monitor: { model: "haiku" } }), "utf8");
    const settings = await loadSettings(file);
    expect(settings.monitor.model).toBe("haiku");
    expect(settings.executor.model).toBe("opus");
  });
});

describe("resolvePromptPaths", () => {
  it("resolves project prompts under .brownie and system prompts from the given dir", () => {
    const paths = resolvePromptPaths({
      projectDir: "/proj",
      systemPromptsDir: "/sys",
    });
    expect(paths.monitor.promptPath).toBe(
      join("/proj", ".brownie", "prompts", "monitor.prompt.md"),
    );
    expect(paths.monitor.systemPromptPath).toBe(join("/sys", "monitor.system.md"));
    expect(paths.executor.promptPath).toBe(
      join("/proj", ".brownie", "prompts", "executor.prompt.md"),
    );
    expect(paths.executor.systemPromptPath).toBe(join("/sys", "executor.system.md"));
    expect(paths.summarizer.systemPromptPath).toBe(join("/sys", "summarizer.system.md"));
    expect(paths.contextPath).toBe(join("/proj", ".brownie", "prompts", "context.md"));
  });

  it("defaults to process.cwd() and the packaged prompts directory", () => {
    const paths = resolvePromptPaths();
    expect(paths.monitor.promptPath).toBe(
      join(process.cwd(), ".brownie", "prompts", "monitor.prompt.md"),
    );
    expect(paths.monitor.systemPromptPath).toBe(
      join(packagePromptsDir, "monitor.system.md"),
    );
    expect(paths.summarizer.systemPromptPath).toBe(
      join(packagePromptsDir, "summarizer.system.md"),
    );
  });
});

describe("loadWorkerConfig", () => {
  let dir: string;
  let systemPromptsDir: string;

  beforeEach(async () => {
    dir = await createTempDir();
    systemPromptsDir = await seedSystemPrompts(dir);
  });

  afterEach(async () => {
    await removeTempDir(dir);
  });

  function dirs() {
    return { projectDir: dir, systemPromptsDir };
  }

  it("builds a full WorkerConfig from valid settings", async () => {
    await seedProject(dir, {
      settings: {
        monitor: {
          model: "sonnet",
          effort: "low",
          intervalMinutes: 1,
          sessionTimeoutMs: 120_000,
        },
        executor: { model: "opus", effort: "max" },
        summarizer: { model: "sonnet", effort: "medium", sessionTimeoutMs: 90_000 },
      },
    });

    const config = await loadWorkerConfig(dirs());

    expect(config.command).toBe(COMMAND);
    expect(config.monitor.model).toBe("sonnet");
    expect(config.monitor.effort).toBe("low");
    expect(config.monitor.intervalMs).toBe(60_000);
    expect(config.monitor.sessionTimeoutMs).toBe(120_000);
    expect(config.monitor.promptPath).toBe(
      join(dir, ".brownie", "prompts", "monitor.prompt.md"),
    );
    expect(config.monitor.systemPromptPath).toBe(
      join(systemPromptsDir, "monitor.system.md"),
    );
    expect(config.executor.model).toBe("opus");
    expect(config.executor.effort).toBe("max");
    expect(config.summarizer.sessionTimeoutMs).toBe(90_000);
    expect(config.cwd).toBe(dir);
    expect(config.settingsFilePath).toBe(join(dir, ".brownie", "settings.json"));
    expect(config.tasksFilePath).toBe(join(dir, ".brownie", "data", "tasks.json"));
    expect(config.memoryDbPath).toBe(join(dir, ".brownie", "data", "memory.db"));
    expect(config.dataDir).toBe(join(dir, ".brownie", "data"));
    expect(config.playwrightOutputDir).toBe(join(dir, ".brownie", "data", "playwright"));
    expect(config.logsDir).toBe(join(dir, ".brownie", "logs"));
    expect(config.streamPartial).toBe(true);
    expect(config.shutdownGraceMs).toBe(0);
    expect(config.monitor.schedule).toBeNull();
  });

  it("maps the shutdown grace", async () => {
    await seedProject(dir, { settings: { shutdownGraceMs: 120_000 } });

    const config = await loadWorkerConfig(dirs());

    expect(config.shutdownGraceMs).toBe(120_000);
  });

  it("rounds a fractional interval to whole milliseconds", async () => {
    await seedProject(dir, { settings: { monitor: { intervalMinutes: 1.5 } } });

    const config = await loadWorkerConfig(dirs());

    expect(config.monitor.intervalMs).toBe(90_000);
  });

  it("builds the monitor schedule from active hours and days", async () => {
    await seedProject(dir, {
      settings: { monitor: { activeHours: "08:00-18:00", activeDays: "mon-fri" } },
    });

    const config = await loadWorkerConfig(dirs());

    expect(config.monitor.schedule).toEqual({
      startMinute: 480,
      endMinute: 1080,
      days: [1, 2, 3, 4, 5],
    });
  });

  it("throws when any prompt file is missing", async () => {
    await seedProject(dir);
    await removeTempDir(join(dir, ".brownie", "prompts", "executor.prompt.md"));

    await expect(loadWorkerConfig(dirs())).rejects.toThrow(/executor prompt file/);
  });

  it("throws when the summarizer system prompt file is missing", async () => {
    await seedProject(dir);
    await removeTempDir(join(systemPromptsDir, "summarizer.system.md"));

    await expect(loadWorkerConfig(dirs())).rejects.toThrow(
      /summarizer system prompt file/,
    );
  });

  it("throws a readable validation error on bad settings", async () => {
    await seedProject(dir, { settings: { monitor: { intervalMinutes: -1 } } });

    await expect(loadWorkerConfig(dirs())).rejects.toThrow(/Invalid configuration/);
  });

  it("with passed verified paths skips re-validating the files", async () => {
    await seedProject(dir);
    const verified = {
      monitor: {
        promptPath: join(dir, "missing-m.md"),
        systemPromptPath: join(dir, "missing-ms.md"),
      },
      executor: {
        promptPath: join(dir, "missing-e.md"),
        systemPromptPath: join(dir, "missing-es.md"),
      },
      summarizer: {
        systemPromptPath: join(dir, "missing-ss.md"),
      },
      contextPath: join(dir, "missing-context.md"),
    };

    const config = await loadWorkerConfig({ projectDir: dir }, verified);

    expect(config.monitor.promptPath).toBe(verified.monitor.promptPath);
    expect(config.monitor.systemPromptPath).toBe(verified.monitor.systemPromptPath);
    expect(config.executor.promptPath).toBe(verified.executor.promptPath);
    expect(config.executor.systemPromptPath).toBe(verified.executor.systemPromptPath);
    expect(config.summarizer.systemPromptPath).toBe(verified.summarizer.systemPromptPath);
    expect(config.contextFilePath).toBe(verified.contextPath);
  });

  it("carries the MCP catalogue and the per-agent selections", async () => {
    await seedProject(dir, {
      settings: {
        browser: true,
        mcpServers: { linter: { command: "run-linter" } },
        executor: { mcpServers: ["linter"] },
      },
    });

    const config = await loadWorkerConfig(dirs());

    expect(config.browser).toBe(true);
    expect(config.mcpServers).toEqual({
      linter: { command: "run-linter", args: [], env: {} },
    });
    expect(config.monitor.mcpServers).toEqual([]);
    expect(config.executor.mcpServers).toEqual(["linter"]);
  });
});
