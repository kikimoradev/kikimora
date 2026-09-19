import { readFile, rename, writeFile } from "node:fs/promises";
import { parseSettings, type Settings } from "./config.js";

export async function readRawSettings(
  settingsFile: string,
): Promise<Record<string, unknown>> {
  let raw: string;
  try {
    raw = await readFile(settingsFile, "utf8");
  } catch (err) {
    throw new Error(
      `settings file missing: ${settingsFile} — run kikimora in an interactive terminal to complete setup`,
      { cause: err },
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Invalid JSON in ${settingsFile}: ${(err as Error).message}`, {
      cause: err,
    });
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Invalid configuration (${settingsFile}): expected a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export type SettingsPatch = Record<string, JsonValue>;

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function mergeSettingsPatch(
  raw: Record<string, unknown>,
  patch: SettingsPatch,
): void {
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      Reflect.deleteProperty(raw, key);
    } else if (isPlainObject(value)) {
      mergeSettingsPatch(settingsSection(raw, key), value);
    } else {
      raw[key] = value;
    }
  }
}

export function settingsSection(
  raw: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  const existing = raw[key];
  if (isPlainObject(existing)) return existing;
  const section: Record<string, unknown> = {};
  raw[key] = section;
  return section;
}

export async function patchSettings(
  settingsFile: string,
  mutate: (raw: Record<string, unknown>) => void,
): Promise<Settings> {
  const raw = await readRawSettings(settingsFile);
  mutate(raw);
  const settings = parseSettings(raw);
  const tmpPath = `${settingsFile}.tmp`;
  await writeFile(tmpPath, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
  await rename(tmpPath, settingsFile);
  return settings;
}
