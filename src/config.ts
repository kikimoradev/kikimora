import { readFile } from "node:fs/promises";
import { z } from "zod";
import { buildSchedule, parseActiveDays, parseTimeWindow } from "./active-hours.js";
import { DRAIN_TIMEOUT_MAX_MS } from "./drain.js";
import { assertReadable } from "./fs.js";
import { MEMORY_SERVER_NAME, PLAYWRIGHT_SERVER_NAME } from "./mcp-config.js";
import { projectPaths, systemPromptFiles } from "./paths.js";
import { EFFORT_LEVELS, type WorkerConfig } from "./types.js";

export const COMMAND = "claude";

export const SETTINGS_PATH_LABEL = ".brownie/settings.json";

const validatedString = (validate: (value: string) => unknown) =>
  z
    .string()
    .trim()
    .min(1)
    .superRefine((value, ctx) => {
      try {
        validate(value);
      } catch (err) {
        ctx.addIssue({ code: "custom", message: (err as Error).message });
      }
    });

export const MCP_SERVER_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/;

export const RESERVED_MCP_SERVER_NAMES: ReadonlySet<string> = new Set([
  MEMORY_SERVER_NAME,
  PLAYWRIGHT_SERVER_NAME,
]);

const mcpEnvSchema = z.record(z.string().regex(/^[A-Z][A-Z0-9_]*$/), z.string());

const stdioMcpServerSchema = z
  .object({
    type: z.literal("stdio").optional(),
    command: z.string().trim().min(1),
    args: z.array(z.string()).default([]),
    env: mcpEnvSchema.default({}),
  })
  .strict();

const httpMcpServerSchema = z
  .object({
    type: z.enum(["http", "sse"]),
    url: z.url(),
    headers: z.record(z.string().min(1), z.string()).default({}),
  })
  .strict();

export const mcpServerSchema = z.union([stdioMcpServerSchema, httpMcpServerSchema]);

const mcpServerNamesSchema = z
  .array(z.string().regex(MCP_SERVER_NAME_PATTERN))
  .default([]);

export const settingsSchema = z
  .object({
    monitor: z
      .object({
        model: z.string().trim().min(1).default("haiku"),
        effort: z.enum(EFFORT_LEVELS).default("medium"),
        intervalMinutes: z.number().positive().default(15),
        activeHours: validatedString(parseTimeWindow).optional(),
        activeDays: validatedString(parseActiveDays).optional(),
        sessionTimeoutMs: z.number().int().positive().optional(),
        mcpServers: mcpServerNamesSchema,
      })
      .strict()
      .prefault({}),
    executor: z
      .object({
        model: z.string().trim().min(1).default("opus"),
        effort: z.enum(EFFORT_LEVELS).default("high"),
        sessionTimeoutMs: z.number().int().positive().optional(),
        maxTaskAttempts: z.number().int().positive().default(3),
        retryDelayMs: z.number().int().nonnegative().default(30_000),
        mcpServers: mcpServerNamesSchema,
      })
      .strict()
      .prefault({}),
    summarizer: z
      .object({
        model: z.string().trim().min(1).default("sonnet"),
        effort: z.enum(EFFORT_LEVELS).default("medium"),
        sessionTimeoutMs: z.number().int().positive().default(300_000),
      })
      .strict()
      .prefault({}),
    streamPartial: z.boolean().default(true),
    browser: z.boolean().default(false),
    shutdownGraceMs: z.number().int().nonnegative().max(DRAIN_TIMEOUT_MAX_MS).default(0),
    mcpServers: z
      .record(z.string().regex(MCP_SERVER_NAME_PATTERN), mcpServerSchema)
      .default({}),
  })
  .strict()
  .superRefine((settings, ctx) => {
    for (const name of Object.keys(settings.mcpServers)) {
      if (RESERVED_MCP_SERVER_NAMES.has(name)) {
        ctx.addIssue({
          code: "custom",
          path: ["mcpServers", name],
          message: `"${name}" is reserved`,
        });
      }
    }
    for (const role of ["monitor", "executor"] as const) {
      settings[role].mcpServers.forEach((name, index) => {
        if (!(name in settings.mcpServers)) {
          ctx.addIssue({
            code: "custom",
            path: [role, "mcpServers", index],
            message: `unknown MCP server "${name}"`,
          });
        }
      });
    }
  });

export type Settings = z.infer<typeof settingsSchema>;

export function parseSettings(source: unknown): Settings {
  const parsed = settingsSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid configuration (${SETTINGS_PATH_LABEL}):\n${issues}`);
  }
  return parsed.data;
}

export async function loadSettings(settingsFile: string): Promise<Settings> {
  let raw: string;
  try {
    raw = await readFile(settingsFile, "utf8");
  } catch (err) {
    throw new Error(
      `settings file missing: ${settingsFile} — run brownie in an interactive terminal to complete setup`,
      { cause: err },
    );
  }
  let source: unknown;
  try {
    source = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Invalid JSON in ${settingsFile}: ${(err as Error).message}`, {
      cause: err,
    });
  }
  return parseSettings(source);
}

export interface ConfigDirs {
  projectDir?: string | undefined;
  systemPromptsDir?: string | undefined;
}

export interface PromptPaths {
  promptPath: string;
  systemPromptPath: string;
}

export interface WorkerPromptPaths {
  monitor: PromptPaths;
  executor: PromptPaths;
  summarizer: Pick<PromptPaths, "systemPromptPath">;
  contextPath: string;
}

export function resolvePromptPaths(dirs: ConfigDirs = {}): WorkerPromptPaths {
  const project = projectPaths(dirs.projectDir);
  const system = systemPromptFiles(dirs.systemPromptsDir);
  return {
    monitor: {
      promptPath: project.monitorPromptFile,
      systemPromptPath: system.monitor,
    },
    executor: {
      promptPath: project.executorPromptFile,
      systemPromptPath: system.executor,
    },
    summarizer: {
      systemPromptPath: system.summarizer,
    },
    contextPath: project.contextFile,
  };
}

export const PROMPT_FILE_LABELS = {
  monitor: {
    promptPath: "monitor prompt file (.brownie/prompts/monitor.prompt.md)",
    systemPromptPath: "monitor system prompt file (bundled with brownie)",
  },
  executor: {
    promptPath: "executor prompt file (.brownie/prompts/executor.prompt.md)",
    systemPromptPath: "executor system prompt file (bundled with brownie)",
  },
  summarizer: {
    systemPromptPath: "summarizer system prompt file (bundled with brownie)",
  },
  contextPath: "context file (.brownie/prompts/context.md, optional)",
} as const;

async function assertPromptPathsReadable(paths: WorkerPromptPaths): Promise<void> {
  for (const agent of ["monitor", "executor"] as const) {
    for (const key of ["promptPath", "systemPromptPath"] as const) {
      await assertReadable(paths[agent][key], PROMPT_FILE_LABELS[agent][key]);
    }
  }
  await assertReadable(
    paths.summarizer.systemPromptPath,
    PROMPT_FILE_LABELS.summarizer.systemPromptPath,
  );
}

export async function loadWorkerConfig(
  dirs: ConfigDirs = {},
  verified?: WorkerPromptPaths,
): Promise<WorkerConfig> {
  const project = projectPaths(dirs.projectDir);
  const settings = await loadSettings(project.settingsFile);

  const paths = verified ?? resolvePromptPaths(dirs);
  if (!verified) {
    await assertPromptPathsReadable(paths);
  }

  return {
    command: COMMAND,
    monitor: {
      model: settings.monitor.model,
      effort: settings.monitor.effort,
      intervalMs: Math.round(settings.monitor.intervalMinutes * 60_000),
      schedule: buildSchedule(settings.monitor.activeHours, settings.monitor.activeDays),
      promptPath: paths.monitor.promptPath,
      systemPromptPath: paths.monitor.systemPromptPath,
      sessionTimeoutMs: settings.monitor.sessionTimeoutMs,
      mcpServers: settings.monitor.mcpServers,
    },
    executor: {
      model: settings.executor.model,
      effort: settings.executor.effort,
      promptPath: paths.executor.promptPath,
      systemPromptPath: paths.executor.systemPromptPath,
      sessionTimeoutMs: settings.executor.sessionTimeoutMs,
      maxTaskAttempts: settings.executor.maxTaskAttempts,
      retryDelayMs: settings.executor.retryDelayMs,
      mcpServers: settings.executor.mcpServers,
    },
    summarizer: {
      model: settings.summarizer.model,
      effort: settings.summarizer.effort,
      systemPromptPath: paths.summarizer.systemPromptPath,
      sessionTimeoutMs: settings.summarizer.sessionTimeoutMs,
    },
    streamPartial: settings.streamPartial,
    browser: settings.browser,
    shutdownGraceMs: settings.shutdownGraceMs,
    mcpServers: settings.mcpServers,
    cwd: project.projectDir,
    settingsFilePath: project.settingsFile,
    contextFilePath: paths.contextPath,
    tasksFilePath: project.tasksFile,
    memoryDbPath: project.memoryDbFile,
    dataDir: project.dataDir,
    playwrightOutputDir: project.playwrightOutputDir,
    logsDir: project.logsDir,
  };
}
