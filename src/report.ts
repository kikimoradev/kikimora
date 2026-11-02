import { z } from "zod";
import {
  SOURCE_LABEL_MAX,
  sourceFields,
  sourceLabelSchema,
  sourceUrlSchema,
} from "./task-source.js";
import type { NewTask } from "./types.js";

export const TASK_REPORT_JSON_SCHEMA = JSON.stringify({
  type: "object",
  properties: {
    tasks: {
      type: "array",
      description: "Detected tasks; empty list when no work was detected",
      items: {
        type: "object",
        properties: {
          id: {
            type: "string",
            description:
              "Stable identifier derived from the task source (source kind + " +
              "task identifier within the source) — the same task must receive " +
              "the same id on every cycle",
          },
          title: { type: "string", description: "Short task title" },
          description: {
            type: "string",
            description:
              "All the context needed to complete the task independently " +
              "in a separate session",
          },
          sourceLabel: {
            type: "string",
            maxLength: SOURCE_LABEL_MAX,
            description:
              "Optional. The short label people know the source of the task by, " +
              "such as an issue key (ENG-142), a ticket number (#3021) or a pull " +
              "request (acme/shop#57). Omit it for a task with no item in a " +
              "tracker, such as a CI run or a dependency update",
          },
          sourceUrl: {
            type: "string",
            description:
              "Optional. The http(s) address of that item; only together with " +
              "sourceLabel",
          },
        },
        required: ["id", "title", "description"],
        additionalProperties: false,
      },
    },
  },
  required: ["tasks"],
  additionalProperties: false,
});

export const taskReportSchema = z.object({
  tasks: z.array(
    z
      .object({
        id: z.string().trim().min(1),
        title: z.string().trim().min(1),
        description: z.string().trim().default(""),
        sourceLabel: sourceLabelSchema.optional().catch(undefined),
        sourceUrl: sourceUrlSchema.optional().catch(undefined),
      })
      .transform((task): NewTask => ({
        id: task.id,
        title: task.title,
        description: task.description,
        ...sourceFields(task),
      })),
  ),
});

export function lastJsonBlock(text: string): string | undefined {
  const matches = [...text.matchAll(/```json\s*([\s\S]*?)```/gi)];
  return matches.at(-1)?.[1];
}

const CONTROL_CHAR_ESCAPES: Record<string, string> = {
  "\b": "\\b",
  "\t": "\\t",
  "\n": "\\n",
  "\f": "\\f",
  "\r": "\\r",
};

function escapeRawControlCharsInStrings(text: string): string {
  let result = "";
  let inString = false;
  let escaped = false;
  for (const char of text) {
    if (!inString) {
      if (char === '"') inString = true;
      result += char;
      continue;
    }
    if (escaped) {
      escaped = false;
      result += char;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      result += char;
      continue;
    }
    if (char === '"') {
      inString = false;
      result += char;
      continue;
    }
    if (char < " ") {
      result +=
        CONTROL_CHAR_ESCAPES[char] ??
        `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`;
      continue;
    }
    result += char;
  }
  return result;
}

export function parseLenient(candidate: string): unknown {
  try {
    return JSON.parse(candidate);
  } catch {
    return JSON.parse(escapeRawControlCharsInStrings(candidate));
  }
}

export function parseTaskReport(resultText: string): NewTask[] | null {
  const candidate = lastJsonBlock(resultText) ?? resultText.trim();
  let raw: unknown;
  try {
    raw = parseLenient(candidate);
  } catch {
    return null;
  }

  const parsed = taskReportSchema.safeParse(raw);
  if (!parsed.success) return null;

  const seen = new Set<string>();
  const tasks: NewTask[] = [];
  for (const task of parsed.data.tasks) {
    if (seen.has(task.id)) continue;
    seen.add(task.id);
    tasks.push(task);
  }
  return tasks;
}
