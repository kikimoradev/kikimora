import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { defineCommand } from "citty";
import { parseSettings } from "./config.js";
import { runConfigure } from "./configure.js";
import { logger } from "./logger.js";
import { projectPaths } from "./paths.js";
import {
  writeProjectScaffold,
  type ProjectPrompts,
  type ScaffoldExtras,
} from "./scaffold.js";

export interface InitOptions {
  monitorPromptPath?: string | undefined;
  executorPromptPath?: string | undefined;
  settingsPath?: string | undefined;
  contextPath?: string | undefined;
  force?: boolean | undefined;
  projectDir?: string | undefined;
  interactive?: boolean | undefined;
}

interface InitInputs {
  prompts: ProjectPrompts | null;
  extras: ScaffoldExtras;
}

class InvalidInputError extends Error {}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function readInputFile(path: string, label: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    throw new InvalidInputError(
      `Cannot read ${label} file ${path}: ${describeError(err)}`,
    );
  }
}

async function readPromptFile(path: string, label: string): Promise<string> {
  const content = (await readInputFile(path, label)).trimEnd();
  if (content === "") {
    throw new InvalidInputError(`The ${label} file ${path} is empty.`);
  }
  return content;
}

async function readPrompts(
  monitorPromptPath: string,
  executorPromptPath: string,
): Promise<ProjectPrompts> {
  const [monitorPrompt, executorPrompt] = await Promise.all([
    readPromptFile(monitorPromptPath, "monitor prompt"),
    readPromptFile(executorPromptPath, "executor prompt"),
  ]);
  return { monitorPrompt, executorPrompt };
}

async function readSettingsDocument(path: string): Promise<unknown> {
  const raw = await readInputFile(path, "settings");
  let document: unknown;
  try {
    document = JSON.parse(raw);
  } catch (err) {
    throw new InvalidInputError(`Invalid JSON in ${path}: ${describeError(err)}`);
  }
  try {
    parseSettings(document);
  } catch (err) {
    throw new InvalidInputError(describeError(err));
  }
  return document;
}

async function readContextFile(path: string): Promise<string> {
  return (await readInputFile(path, "context")).trimEnd();
}

async function readInitInputs(options: InitOptions): Promise<InitInputs> {
  const { monitorPromptPath, executorPromptPath, settingsPath, contextPath } = options;
  const [prompts, settings, context] = await Promise.all([
    monitorPromptPath === undefined || executorPromptPath === undefined
      ? null
      : readPrompts(monitorPromptPath, executorPromptPath),
    settingsPath === undefined ? undefined : readSettingsDocument(settingsPath),
    contextPath === undefined ? undefined : readContextFile(contextPath),
  ]);
  return {
    prompts,
    extras: {
      ...(settingsPath === undefined ? {} : { settings }),
      ...(context === undefined ? {} : { context }),
    },
  };
}

export async function runInit(options: InitOptions = {}): Promise<void> {
  const { monitorPromptPath, executorPromptPath, settingsPath, contextPath } = options;
  const interactive =
    options.interactive ?? (process.stdin.isTTY && process.stdout.isTTY);
  const hasPromptFlag =
    monitorPromptPath !== undefined || executorPromptPath !== undefined;

  if (!hasPromptFlag && settingsPath === undefined && contextPath === undefined) {
    if (!interactive) {
      logger.error(
        "No prompt files given — pass --monitor-prompt and --executor-prompt, " +
          "or run kikimora init in an interactive terminal to use the wizard.",
      );
      process.exitCode = 1;
      return;
    }
    await runConfigure(options.projectDir);
    return;
  }

  if (
    hasPromptFlag &&
    (monitorPromptPath === undefined || executorPromptPath === undefined)
  ) {
    logger.error("Both --monitor-prompt and --executor-prompt are required together.");
    process.exitCode = 1;
    return;
  }

  const paths = projectPaths(options.projectDir);

  if (options.force !== true) {
    const targets = [
      ...(hasPromptFlag ? [paths.monitorPromptFile, paths.executorPromptFile] : []),
      ...(settingsPath === undefined ? [] : [paths.settingsFile]),
      ...(contextPath === undefined ? [] : [paths.contextFile]),
    ];
    const existing = targets.filter((path) => existsSync(path));
    if (existing.length > 0) {
      const details = existing.map((path) => `  - ${path}`).join("\n");
      logger.error(`Refusing to overwrite existing files (use --force):\n${details}`);
      process.exitCode = 1;
      return;
    }
  }

  let inputs: InitInputs;
  try {
    inputs = await readInitInputs(options);
  } catch (err) {
    if (!(err instanceof InvalidInputError)) throw err;
    logger.error(err.message);
    process.exitCode = 1;
    return;
  }

  const { wroteSettings } = await writeProjectScaffold(
    paths,
    inputs.prompts,
    inputs.extras,
  );

  if (wroteSettings) logger.success(`Saved ${paths.settingsFile}`);
  if (inputs.prompts !== null) {
    logger.success(`Saved ${paths.monitorPromptFile}`);
    logger.success(`Saved ${paths.executorPromptFile}`);
  }
  if (inputs.extras.context !== undefined) logger.success(`Saved ${paths.contextFile}`);
  logger.info("Run kikimora in the project directory to start the worker.");
}

export const initCommand = defineCommand({
  meta: {
    name: "init",
    description:
      "Set up .kikimora/ for the current project — non-interactive with " +
      "--monitor-prompt/--executor-prompt/--settings/--context, or via the " +
      "wizard in a terminal.",
  },
  args: {
    "monitor-prompt": {
      type: "string",
      description: "Path to a markdown file with the monitor prompt",
    },
    "executor-prompt": {
      type: "string",
      description: "Path to a markdown file with the executor prompt",
    },
    settings: {
      type: "string",
      description: "Path to a JSON file to write as .kikimora/settings.json",
    },
    context: {
      type: "string",
      description: "Path to a markdown file with the workspace context",
    },
    force: {
      type: "boolean",
      description: "Overwrite every file the invocation writes",
    },
  },
  run: ({ args }) =>
    runInit({
      monitorPromptPath: args["monitor-prompt"],
      executorPromptPath: args["executor-prompt"],
      settingsPath: args.settings,
      contextPath: args.context,
      force: args.force,
    }),
});
