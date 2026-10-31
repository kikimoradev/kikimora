import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import type { TaskHandoff } from "../types.js";

export const HANDOFF_REASON_MAX = 200;

export interface HandoffTarget {
  taskId: string;
  file: string;
}

export interface HandoffMark extends TaskHandoff {
  taskId: string;
}

export type HandoffReasonCheck =
  { ok: true; reason: string } | { ok: false; error: string };

const handoffMarkSchema = z.object({
  taskId: z.string().min(1),
  reason: z.string().min(1).max(HANDOFF_REASON_MAX),
  markedAt: z.iso.datetime(),
});

export function normalizeHandoffReason(raw: string): HandoffReasonCheck {
  const reason = raw.replace(/\s+/g, " ").trim();
  if (reason === "") {
    return { ok: false, error: "The reason is empty: give one short sentence." };
  }
  if (reason.length > HANDOFF_REASON_MAX) {
    return {
      ok: false,
      error: `The reason has ${String(reason.length)} characters; the limit is ${String(HANDOFF_REASON_MAX)}. Shorten it to one sentence.`,
    };
  }
  return { ok: true, reason };
}

export async function writeHandoffMark(
  target: HandoffTarget,
  reason: string,
  now: Date = new Date(),
): Promise<HandoffMark> {
  const mark: HandoffMark = {
    taskId: target.taskId,
    reason,
    markedAt: now.toISOString(),
  };
  await mkdir(dirname(target.file), { recursive: true });
  const tmpPath = `${target.file}.${String(process.pid)}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmpPath, `${JSON.stringify(mark, null, 2)}\n`, "utf8");
    await rename(tmpPath, target.file);
  } catch (err) {
    await rm(tmpPath, { force: true });
    throw err;
  }
  return mark;
}

export async function clearHandoffMark(file: string): Promise<void> {
  await rm(file, { force: true });
}

export async function readHandoffMark(
  target: HandoffTarget,
): Promise<TaskHandoff | undefined> {
  let raw: string;
  try {
    raw = await readFile(target.file, "utf8");
  } catch {
    return undefined;
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    json = undefined;
  }
  const parsed = handoffMarkSchema.safeParse(json);
  if (!parsed.success || parsed.data.taskId !== target.taskId) {
    await clearHandoffMark(target.file);
    return undefined;
  }
  return { reason: parsed.data.reason, markedAt: parsed.data.markedAt };
}

export function handoffFields(handoff: TaskHandoff | undefined): {
  handedOff?: true;
  handoffReason?: string;
} {
  return handoff === undefined ? {} : { handedOff: true, handoffReason: handoff.reason };
}
