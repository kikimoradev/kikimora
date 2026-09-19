import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { render } from "ink";
import { logger } from "./logger.js";
import { projectPaths } from "./paths.js";
import { writeProjectScaffold } from "./scaffold.js";
import { Wizard, type WizardResult } from "./ui/wizard.js";

export interface WizardIo {
  stdin?: NodeJS.ReadStream | undefined;
  stdout?: NodeJS.WriteStream | undefined;
}

export function isConfigured(projectDir?: string): boolean {
  const paths = projectPaths(projectDir);
  return [paths.settingsFile, paths.monitorPromptFile, paths.executorPromptFile].every(
    (path) => existsSync(path),
  );
}

async function readPromptDraft(path: string): Promise<string> {
  try {
    return (await readFile(path, "utf8")).trimEnd();
  } catch {
    return "";
  }
}

async function collectPrompts(
  initialMonitorPrompt: string,
  initialExecutorPrompt: string,
  io: WizardIo,
): Promise<WizardResult | null> {
  let resolveResult: (result: WizardResult | null) => void = () => undefined;
  const result = new Promise<WizardResult | null>((resolve) => {
    resolveResult = resolve;
  });
  const app = render(
    <Wizard
      initialMonitorPrompt={initialMonitorPrompt}
      initialExecutorPrompt={initialExecutorPrompt}
      onComplete={(value) => {
        resolveResult(value);
      }}
    />,
    {
      exitOnCtrlC: false,
      patchConsole: false,
      ...(io.stdin === undefined ? {} : { stdin: io.stdin }),
      ...(io.stdout === undefined ? {} : { stdout: io.stdout }),
    },
  );
  try {
    return await result;
  } finally {
    app.unmount();
    await app.waitUntilExit();
  }
}

export async function runConfigure(
  projectDir?: string,
  io: WizardIo = {},
): Promise<boolean> {
  const paths = projectPaths(projectDir);

  const [initialMonitorPrompt, initialExecutorPrompt] = await Promise.all([
    readPromptDraft(paths.monitorPromptFile),
    readPromptDraft(paths.executorPromptFile),
  ]);

  const result = await collectPrompts(initialMonitorPrompt, initialExecutorPrompt, io);
  if (result === null) {
    logger.info("Cancelled — nothing changed.");
    return false;
  }

  await writeProjectScaffold(paths, result);

  logger.success(`Saved ${paths.settingsFile}`);
  logger.success(`Saved ${paths.monitorPromptFile}`);
  logger.success(`Saved ${paths.executorPromptFile}`);
  logger.info(
    "All other settings use defaults — change them from the dashboard (/model, /effort, " +
      "/interval, /hours, /days) or by editing .kikimora/settings.json.",
  );
  return true;
}
