import { z } from "zod";

export const SOURCE_LABEL_MAX = 80;

export const SOURCE_URL_MAX = 2048;

export interface TaskSource {
  sourceLabel?: string | undefined;
  sourceUrl?: string | undefined;
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export const sourceLabelSchema = z
  .string()
  .trim()
  .min(1)
  .max(SOURCE_LABEL_MAX)
  .refine((value) => !/[\r\n]/.test(value), "must be a single line");

export const sourceUrlSchema = z
  .string()
  .trim()
  .max(SOURCE_URL_MAX)
  .refine(isHttpUrl, "must be an http or https URL");

export const SOURCE_URL_NEEDS_LABEL = "sourceUrl requires sourceLabel";

export function sourceFields(source: TaskSource): {
  sourceLabel?: string;
  sourceUrl?: string;
} {
  if (source.sourceLabel === undefined) return {};
  return source.sourceUrl === undefined
    ? { sourceLabel: source.sourceLabel }
    : { sourceLabel: source.sourceLabel, sourceUrl: source.sourceUrl };
}

export function formatSource(source: TaskSource): string | undefined {
  if (source.sourceLabel === undefined) return undefined;
  return source.sourceUrl === undefined
    ? source.sourceLabel
    : `${source.sourceLabel} (${source.sourceUrl})`;
}
