import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

export const KIKIMORA_DIR_NAME = ".kikimora";

export const FALLBACK_PACKAGE_NAME = "@kikimoradev/kikimora";

export const MCP_DIR_NAME = "mcp";

export const PLAYWRIGHT_DIR_NAME = "playwright";

export interface ProjectPaths {
  projectDir: string;
  kikimoraDir: string;
  settingsFile: string;
  promptsDir: string;
  monitorPromptFile: string;
  executorPromptFile: string;
  contextFile: string;
  dataDir: string;
  tasksFile: string;
  memoryDbFile: string;
  mcpDir: string;
  playwrightOutputDir: string;
  logsDir: string;
  gitignoreFile: string;
}

export function projectPaths(projectDir: string = process.cwd()): ProjectPaths {
  const kikimoraDir = join(projectDir, KIKIMORA_DIR_NAME);
  const promptsDir = join(kikimoraDir, "prompts");
  const dataDir = join(kikimoraDir, "data");
  return {
    projectDir,
    kikimoraDir,
    settingsFile: join(kikimoraDir, "settings.json"),
    promptsDir,
    monitorPromptFile: join(promptsDir, "monitor.prompt.md"),
    executorPromptFile: join(promptsDir, "executor.prompt.md"),
    contextFile: join(promptsDir, "context.md"),
    dataDir,
    tasksFile: join(dataDir, "tasks.json"),
    memoryDbFile: join(dataDir, "memory.db"),
    mcpDir: join(dataDir, MCP_DIR_NAME),
    playwrightOutputDir: join(dataDir, PLAYWRIGHT_DIR_NAME),
    logsDir: join(kikimoraDir, "logs"),
    gitignoreFile: join(kikimoraDir, ".gitignore"),
  };
}

export const CONTROL_SOCKET_ENV = "KIKIMORA_CONTROL_SOCKET";

export const UNIX_SOCKET_PATH_LIMIT = 104;

export class InvalidControlSocketPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidControlSocketPathError";
  }
}

export interface ControlSocketPathOptions {
  env?: NodeJS.ProcessEnv | undefined;
  platform?: NodeJS.Platform | undefined;
}

function validateControlSocketOverride(override: string): string {
  if (!isAbsolute(override)) {
    throw new InvalidControlSocketPathError(
      `${CONTROL_SOCKET_ENV} must be an absolute path, got "${override}".`,
    );
  }
  const bytes = Buffer.byteLength(override, "utf8");
  if (bytes >= UNIX_SOCKET_PATH_LIMIT) {
    throw new InvalidControlSocketPathError(
      `${CONTROL_SOCKET_ENV} is too long (${String(bytes)} bytes) — unix socket paths must be shorter than ${String(UNIX_SOCKET_PATH_LIMIT)} bytes.`,
    );
  }
  return override;
}

export function controlSocketPath(
  projectDir: string = process.cwd(),
  options: ControlSocketPathOptions = {},
): string {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const override = (env[CONTROL_SOCKET_ENV] ?? "").trim();
  if (override !== "") {
    return platform === "win32" ? override : validateControlSocketOverride(override);
  }
  const hash = createHash("sha256")
    .update(resolve(projectDir))
    .digest("hex")
    .slice(0, 16);
  const uid = process.getuid?.() ?? 0;
  const name = `kikimora-${String(uid)}-${hash}`;
  return platform === "win32" ? `\\\\.\\pipe\\${name}` : join(tmpdir(), `${name}.sock`);
}

export const packageRootDir = dirname(dirname(fileURLToPath(import.meta.url)));

export const packagePromptsDir = join(packageRootDir, "prompts");

export const globalKikimoraDir = join(homedir(), KIKIMORA_DIR_NAME);

export const globalConfigFile = join(globalKikimoraDir, "config.json");

const packageManifestSchema = z.object({
  name: z.string().default(FALLBACK_PACKAGE_NAME),
  version: z.string().default("unknown"),
});

function readPackageManifest(): z.infer<typeof packageManifestSchema> {
  try {
    const raw = readFileSync(join(packageRootDir, "package.json"), "utf8");
    return packageManifestSchema.parse(JSON.parse(raw));
  } catch {
    return { name: FALLBACK_PACKAGE_NAME, version: "unknown" };
  }
}

export function packageVersion(): string {
  return readPackageManifest().version;
}

export function packageName(): string {
  return readPackageManifest().name;
}

export interface SystemPromptFiles {
  monitor: string;
  executor: string;
  summarizer: string;
}

export function systemPromptFiles(dir: string = packagePromptsDir): SystemPromptFiles {
  return {
    monitor: join(dir, "monitor.system.md"),
    executor: join(dir, "executor.system.md"),
    summarizer: join(dir, "summarizer.system.md"),
  };
}
