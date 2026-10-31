import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearHandoffMark,
  HANDOFF_REASON_MAX,
  handoffFields,
  normalizeHandoffReason,
  readHandoffMark,
  writeHandoffMark,
} from "../../src/memory/handoff.js";
import { createTempDir, removeTempDir } from "../helpers.js";

describe("normalizeHandoffReason", () => {
  it("folds whitespace and line breaks into single spaces and trims the ends", () => {
    expect(normalizeHandoffReason("  line one\n\n  line\ttwo  ")).toEqual({
      ok: true,
      reason: "line one line two",
    });
  });

  it("rejects a reason that is empty after trimming", () => {
    const checked = normalizeHandoffReason(" \n\t ");

    expect(checked.ok).toBe(false);
    expect(checked).toMatchObject({ error: expect.stringContaining("empty") as unknown });
  });

  it("accepts the limit and rejects one character more, naming the limit", () => {
    expect(normalizeHandoffReason("a".repeat(HANDOFF_REASON_MAX))).toEqual({
      ok: true,
      reason: "a".repeat(HANDOFF_REASON_MAX),
    });
    const checked = normalizeHandoffReason("a".repeat(HANDOFF_REASON_MAX + 1));

    expect(checked.ok).toBe(false);
    expect(checked).toMatchObject({
      error: expect.stringContaining("the limit is 200") as unknown,
    });
  });
});

describe("handoff mark file", () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await createTempDir();
    file = join(dir, "data", "handoff.json");
  });

  afterEach(() => removeTempDir(dir));

  it("writes the mark atomically, creating the directory, and reads it back for its task", async () => {
    const mark = await writeHandoffMark(
      { taskId: "t-1", file },
      "Needs the owner's approval of the budget",
      new Date("2026-10-30T12:00:00.000Z"),
    );

    expect(mark).toEqual({
      taskId: "t-1",
      reason: "Needs the owner's approval of the budget",
      markedAt: "2026-10-30T12:00:00.000Z",
    });
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual(mark);
    expect(await readdir(join(dir, "data"))).toEqual(["handoff.json"]);
    await expect(readHandoffMark({ taskId: "t-1", file })).resolves.toEqual({
      reason: "Needs the owner's approval of the budget",
      markedAt: "2026-10-30T12:00:00.000Z",
    });
  });

  it("keeps only the last mark", async () => {
    await writeHandoffMark({ taskId: "t-1", file }, "first");
    await writeHandoffMark({ taskId: "t-1", file }, "second");

    await expect(readHandoffMark({ taskId: "t-1", file })).resolves.toMatchObject({
      reason: "second",
    });
  });

  it("lets parallel marks of one session all succeed, leaving one of them and no temporary file", async () => {
    const reasons = ["first", "second", "third", "fourth"];

    await Promise.all(
      reasons.map((reason) => writeHandoffMark({ taskId: "t-1", file }, reason)),
    );

    const mark = await readHandoffMark({ taskId: "t-1", file });
    expect(reasons).toContain(mark?.reason);
    expect(await readdir(join(dir, "data"))).toEqual(["handoff.json"]);
  });

  it("removes its temporary file when the mark cannot be put in place", async () => {
    await mkdir(join(file, "occupied"), { recursive: true });

    await expect(writeHandoffMark({ taskId: "t-1", file }, "why")).rejects.toThrow();
    expect(await readdir(join(dir, "data"))).toEqual(["handoff.json"]);
  });

  it("reads nothing when there is no mark", async () => {
    await expect(readHandoffMark({ taskId: "t-1", file })).resolves.toBeUndefined();
  });

  it("ignores and removes the mark of another task", async () => {
    await writeHandoffMark({ taskId: "other", file }, "stale");

    await expect(readHandoffMark({ taskId: "t-1", file })).resolves.toBeUndefined();
    await expect(readdir(join(dir, "data"))).resolves.toEqual([]);
  });

  it("ignores and removes a corrupt or malformed mark", async () => {
    await mkdir(join(dir, "data"), { recursive: true });
    for (const content of [
      "{not json",
      JSON.stringify({ taskId: "t-1", reason: "", markedAt: "2026-10-30T12:00:00.000Z" }),
      JSON.stringify({ taskId: "t-1", reason: "why", markedAt: "yesterday" }),
    ]) {
      await writeFile(file, content, "utf8");

      await expect(readHandoffMark({ taskId: "t-1", file })).resolves.toBeUndefined();
      await expect(readdir(join(dir, "data"))).resolves.toEqual([]);
    }
  });

  it("reads nothing when the mark cannot be read", async () => {
    await mkdir(file, { recursive: true });

    await expect(readHandoffMark({ taskId: "t-1", file })).resolves.toBeUndefined();
  });

  it("clears a mark and tolerates a missing one", async () => {
    await writeHandoffMark({ taskId: "t-1", file }, "why");

    await clearHandoffMark(file);
    await clearHandoffMark(file);

    await expect(readdir(join(dir, "data"))).resolves.toEqual([]);
  });
});

describe("handoffFields", () => {
  it("adds both fields for a mark and nothing without one", () => {
    expect(
      handoffFields({ reason: "why", markedAt: "2026-10-30T12:00:00.000Z" }),
    ).toEqual({ handedOff: true, handoffReason: "why" });
    expect(handoffFields(undefined)).toEqual({});
  });
});
