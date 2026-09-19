import { readFile } from "node:fs/promises";
import { z } from "zod";
import { globalConfigFile } from "./paths.js";

export const globalConfigSchema = z
  .object({
    autoUpdate: z.boolean().default(true),
  })
  .strict();

export type GlobalConfig = z.infer<typeof globalConfigSchema>;

const DEFAULT_GLOBAL_CONFIG: GlobalConfig = globalConfigSchema.parse({});

export async function loadGlobalConfig(
  file: string = globalConfigFile,
): Promise<GlobalConfig> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    return DEFAULT_GLOBAL_CONFIG;
  }
  try {
    return globalConfigSchema.parse(JSON.parse(raw));
  } catch {
    return DEFAULT_GLOBAL_CONFIG;
  }
}

export function isAutoUpdaterDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.KIKIMORA_DISABLE_AUTOUPDATER?.trim().toLowerCase();
  return value === "1" || value === "true";
}
