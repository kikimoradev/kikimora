import { randomUUID } from "node:crypto";
import { constants, mkdir, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { canAccess } from "../fs.js";

export interface MemoryExport {
  path: string;
  bytes: number;
  entries: number;
}

export interface MemorySnapshotSource {
  exportTo(path: string): void;
}

const quickCheckSchema = z.object({ quick_check: z.string() });
const entryCountSchema = z.object({ entries: z.number() });

export async function exportMemory(
  source: MemorySnapshotSource,
  target: string,
): Promise<MemoryExport> {
  if (!isAbsolute(target)) {
    throw new Error(`The export path must be absolute: ${target}`);
  }
  if (await canAccess(target, constants.F_OK)) {
    throw new Error(`${target} already exists; export to a new path.`);
  }
  const directory = dirname(target);
  await mkdir(directory, { recursive: true });
  const staging = join(directory, `.${basename(target)}.${randomUUID()}.tmp`);
  try {
    source.exportTo(staging);
    const entries = countVerifiedEntries(staging);
    await rename(staging, target);
    const { size } = await stat(target);
    return { path: target, bytes: size, entries };
  } finally {
    await rm(staging, { force: true });
  }
}

function countVerifiedEntries(path: string): number {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const check = quickCheckSchema.parse(db.prepare("PRAGMA quick_check").get());
    if (check.quick_check !== "ok") {
      throw new Error(`The exported database is damaged: ${check.quick_check}`);
    }
    return entryCountSchema.parse(
      db.prepare("SELECT count(*) AS entries FROM summaries").get(),
    ).entries;
  } finally {
    db.close();
  }
}
