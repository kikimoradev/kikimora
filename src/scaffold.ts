import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createContextFileAccess } from "./context-file.js";
import type { ProjectPaths } from "./paths.js";

const KIKIMORA_GITIGNORE = "data/\nlogs/\n";

export interface ProjectPrompts {
  monitorPrompt: string;
  executorPrompt: string;
}

export interface ScaffoldExtras {
  settings?: unknown;
  context?: string | undefined;
}

export interface ScaffoldResult {
  wroteSettings: boolean;
}

export async function writeProjectScaffold(
  paths: ProjectPaths,
  prompts: ProjectPrompts | null,
  extras: ScaffoldExtras = {},
): Promise<ScaffoldResult> {
  await mkdir(paths.promptsDir, { recursive: true });

  const wroteSettings = extras.settings !== undefined || !existsSync(paths.settingsFile);
  if (wroteSettings) {
    const document =
      extras.settings === undefined ? "{}" : JSON.stringify(extras.settings, null, 2);
    await writeFile(paths.settingsFile, `${document}\n`, "utf8");
  }

  if (prompts !== null) {
    await writeFile(paths.monitorPromptFile, `${prompts.monitorPrompt}\n`, "utf8");
    await writeFile(paths.executorPromptFile, `${prompts.executorPrompt}\n`, "utf8");
  }

  if (extras.context !== undefined) {
    await createContextFileAccess(paths.contextFile).write(extras.context);
  }

  if (!existsSync(paths.gitignoreFile)) {
    await writeFile(paths.gitignoreFile, KIKIMORA_GITIGNORE, "utf8");
  }

  return { wroteSettings };
}
