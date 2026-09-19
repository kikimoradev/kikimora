import { defineCommand } from "citty";
import { isAutoUpdaterDisabled, loadGlobalConfig } from "./global-config.js";
import { logger } from "./logger.js";
import { globalConfigFile } from "./paths.js";
import { installCommand } from "./update/install.js";
import { defaultUpdateDeps, performUpdate, type UpdateDeps } from "./update/updater.js";

export interface UpdateOptions {
  check?: boolean | undefined;
  deps?: UpdateDeps | undefined;
}

export async function runUpdate(options: UpdateOptions = {}): Promise<void> {
  const deps = options.deps ?? defaultUpdateDeps();
  const install = options.check !== true;
  const outcome = await performUpdate(deps, { install });

  switch (outcome.status) {
    case "unreachable":
      logger.error("Could not reach the npm registry to check for updates.");
      process.exitCode = 1;
      break;
    case "up-to-date":
      logger.success(`kikimora is up to date (${outcome.from}).`);
      break;
    case "available":
      logger.info(`Update available: ${outcome.from} → ${outcome.to ?? "?"}.`);
      logger.info('Run "kikimora update" to install it.');
      break;
    case "unmanaged": {
      const manual = installCommand("npm", deps.name);
      logger.warn(
        `Update available: ${outcome.from} → ${outcome.to ?? "?"}, but the install ` +
          "location is not a global package manager install. Install it manually:",
      );
      logger.info(`  ${manual.command} ${manual.args.join(" ")}`);
      process.exitCode = 1;
      break;
    }
    case "updated":
      logger.success(
        `Updated kikimora ${outcome.from} → ${outcome.to ?? "?"}. Restart to apply.`,
      );
      break;
    case "failed":
      logger.error(
        `Failed to update kikimora ${outcome.from} → ${outcome.to ?? "?"} ` +
          `via ${outcome.method}.`,
      );
      if (outcome.output) logger.error(outcome.output);
      process.exitCode = 1;
      break;
  }

  await reportAutoUpdateState();
}

async function reportAutoUpdateState(): Promise<void> {
  if (isAutoUpdaterDisabled()) {
    logger.info("Auto-update is disabled (KIKIMORA_DISABLE_AUTOUPDATER).");
    return;
  }
  const config = await loadGlobalConfig();
  logger.info(
    `Auto-update is ${config.autoUpdate ? "on" : "off (notify only)"} — ` +
      `configure it in ${globalConfigFile}.`,
  );
}

export const updateCommand = defineCommand({
  meta: {
    name: "update",
    description: "Check npm for a newer kikimora and install it.",
  },
  args: {
    check: {
      type: "boolean",
      description: "Only check for a newer version without installing it",
    },
  },
  run: ({ args }) => runUpdate({ check: args.check }),
});
