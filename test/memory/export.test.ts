import { existsSync, statSync, writeFileSync } from "node:fs";
import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { exportMemory } from "../../src/memory/export.js";
import { MemoryStore, type NewTaskSummaryRecord } from "../../src/memory/store.js";
import { SessionIndex } from "../../src/sessions/index.js";
import { createTempDir, removeTempDir } from "../helpers.js";

function summary(index: number): NewTaskSummaryRecord {
  return {
    taskId: `task-${String(index)}`,
    attempt: 1,
    ok: true,
    title: `Task ${String(index)}`,
    headline: `Shipped release ${String(index)}`,
    summary: "Bumped the version and tagged it.",
    error: undefined,
    sessionId: `sess-${String(index)}`,
    createdAt: "2026-10-16T09:00:00.000Z",
  };
}

describe("exportMemory", () => {
  let dir: string;
  let store: MemoryStore;
  let dbPath: string;

  beforeEach(async () => {
    dir = await createTempDir();
    dbPath = join(dir, "data", "memory.db");
    store = MemoryStore.open(dbPath);
  });

  afterEach(async () => {
    store.close();
    await removeTempDir(dir);
  });

  it("copies every entry and the session index, including writes still in the WAL", async () => {
    SessionIndex.on(store.connection).started({
      sessionId: "sess-1",
      agent: "executor",
      taskId: "task-1",
      model: "opus",
      startedAt: "2026-10-16T08:59:00.000Z",
      logPath: "logs/executor/sess-1.log",
      jsonlPath: "logs/executor/sess-1.jsonl",
    });
    for (let index = 1; index <= 25; index += 1) store.add(summary(index));
    expect(statSync(`${dbPath}-wal`).size).toBeGreaterThan(0);
    const target = join(dir, "backups", "nightly", "memory.db");

    const exported = await exportMemory(store, target);

    expect(exported).toEqual({
      path: target,
      bytes: statSync(target).size,
      entries: 25,
    });
    const copy = MemoryStore.open(target);
    try {
      expect(copy.recent(100)).toHaveLength(25);
      expect(copy.search("release 7")[0]?.taskId).toBe("task-7");
      expect(SessionIndex.on(copy.connection).get("sess-1")?.taskId).toBe("task-1");
      copy.add(summary(26));
      expect(copy.recent(100)).toHaveLength(26);
    } finally {
      copy.close();
    }
    expect(store.recent(100)).toHaveLength(25);
  });

  it("leaves nothing but the finished copy in the target directory", async () => {
    store.add(summary(1));
    const target = join(dir, "export.db");

    await exportMemory(store, target);

    expect((await readdir(dir)).sort()).toEqual(["data", "export.db"]);
    const db = new DatabaseSync(target, { readOnly: true });
    try {
      expect(db.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "delete" });
    } finally {
      db.close();
    }
  });

  it("refuses a relative path", async () => {
    await expect(exportMemory(store, "backup/memory.db")).rejects.toThrow(
      "The export path must be absolute: backup/memory.db",
    );
  });

  it("refuses to overwrite an existing file", async () => {
    const target = join(dir, "taken.db");
    await writeFile(target, "keep me", "utf8");

    await expect(exportMemory(store, target)).rejects.toThrow(
      `${target} already exists; export to a new path.`,
    );
    expect(statSync(target).size).toBe("keep me".length);
  });

  it("cleans up and reports a copy that is not a database", async () => {
    const target = join(dir, "broken.db");
    const source = {
      exportTo: (path: string) => {
        writeFileSync(path, "x".repeat(4096));
      },
    };

    await expect(exportMemory(source, target)).rejects.toThrow();
    expect(existsSync(target)).toBe(false);
    expect(await readdir(dir)).toEqual(["data"]);
  });
});
