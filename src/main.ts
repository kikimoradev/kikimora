import { defineCommand } from "citty";
import { isConfigured, runConfigure } from "./configure.js";
import { parseHeadlessLogFormat } from "./headless/format.js";
import { logger } from "./logger.js";
import { packageVersion } from "./paths.js";
import { startWorker } from "./start.js";

export interface RunKikimoraOptions {
  positionals?: string[] | undefined;
  interactive?: boolean | undefined;
  headless?: boolean | undefined;
  logFormat?: string | undefined;
  verbose?: boolean | undefined;
  paused?: boolean | undefined;
}

function isInteractiveTerminal(): boolean {
  return process.stdin.isTTY && process.stdout.isTTY;
}

export function parseStartPaused(raw: string | undefined): boolean {
  const value = raw?.trim().toLowerCase();
  return value === "1" || value === "true";
}

export async function runKikimora(options: RunKikimoraOptions = {}): Promise<void> {
  const [positional] = options.positionals ?? [];
  if (positional !== undefined) {
    logger.error(
      `Unknown command "${positional}" — available commands: init, status, version, pause, ` +
        "resume, drain, tasks, settings, prompt, context, memory, sessions, update, mcp; run plain kikimora to start the worker.",
    );
    process.exitCode = 1;
    return;
  }

  const rawLogFormat = options.logFormat ?? process.env.KIKIMORA_LOG_FORMAT;
  const logFormat =
    rawLogFormat === undefined ? "pretty" : parseHeadlessLogFormat(rawLogFormat);
  if (logFormat === null) {
    logger.error(`Invalid log format "${rawLogFormat ?? ""}" — use pretty or json.`);
    process.exitCode = 1;
    return;
  }

  const headless = options.headless === true;
  const interactive = options.interactive ?? isInteractiveTerminal();
  const needsConfig = !isConfigured();
  if (needsConfig && interactive && !headless) {
    const saved = await runConfigure();
    if (!saved) return;
  }

  const paused =
    options.paused === true || parseStartPaused(process.env.KIKIMORA_START_PAUSED);

  await startWorker({ headless, logFormat, verbose: options.verbose, paused });
}

export const mainCommand = defineCommand({
  meta: {
    name: "kikimora",
    version: packageVersion(),
    description:
      "Two-agent Claude Code worker: the monitor reports tasks on a cycle, the executor completes them. " +
      "Configures itself on first run, then starts the dashboard.",
  },
  args: {
    headless: {
      type: "boolean",
      description: "Run without the dashboard and print line logs to stdout",
    },
    "log-format": {
      type: "string",
      description: "Headless log format: pretty or json (env: KIKIMORA_LOG_FORMAT)",
    },
    verbose: {
      type: "boolean",
      description: "Include session text and tool calls in headless logs",
    },
    paused: {
      type: "boolean",
      description:
        "Boot both agents paused — wake them with kikimora resume or /start (env: KIKIMORA_START_PAUSED=1)",
    },
  },
  run: ({ args }) =>
    runKikimora({
      positionals: args._,
      headless: args.headless,
      logFormat: args["log-format"],
      verbose: args.verbose,
      paused: args.paused,
    }),
});
