import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskSummaryRecord } from "../src/memory/store.js";

const mocks = vi.hoisted(() => ({
  sendControlRequest: vi.fn(),
}));

vi.mock("../src/control-client.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/control-client.js")>();
  return { ...original, sendControlRequest: mocks.sendControlRequest };
});
vi.mock("../src/logger.js", async () =>
  (await import("./helpers.js")).loggerModuleMock(),
);

const { memoryCommand, runMemoryExport, runMemoryRecent, runMemorySearch } =
  await import("../src/memory-command.js");
const { logger } = await import("../src/logger.js");

function buildRecord(overrides: Partial<TaskSummaryRecord> = {}): TaskSummaryRecord {
  return {
    id: 7,
    taskId: "ci-42",
    attempt: 1,
    ok: true,
    title: "Fix the build",
    headline: "Pinned the compiler",
    summary: "Details.",
    error: undefined,
    sessionId: "sess-1",
    createdAt: "2026-07-08T09:00:00.000Z",
    ...overrides,
  };
}

describe("memory commands", () => {
  let lines: string[];
  let savedExitCode: typeof process.exitCode;
  const write = (line: string) => lines.push(line);

  beforeEach(() => {
    vi.clearAllMocks();
    lines = [];
    savedExitCode = process.exitCode;
  });

  afterEach(() => {
    process.exitCode = savedExitCode;
  });

  it("search prints one line per record with the default limit", async () => {
    mocks.sendControlRequest.mockResolvedValue({
      ok: true,
      data: [
        buildRecord(),
        buildRecord({ id: 8, ok: false, attempt: 2, headline: "Failed" }),
      ],
    });

    await runMemorySearch("deploy", { write });

    expect(mocks.sendControlRequest).toHaveBeenCalledWith(expect.any(String), {
      cmd: "memory.search",
      query: "deploy",
      limit: 10,
    });
    expect(lines[0]).toBe(
      "#7 2026-07-08T09:00:00.000Z ok ci-42 (attempt 1) — Pinned the compiler",
    );
    expect(lines[1]).toBe(
      "#8 2026-07-08T09:00:00.000Z failed ci-42 (attempt 2) — Failed",
    );
  });

  it("recent forwards the limit and prints JSON", async () => {
    const records = [buildRecord()];
    mocks.sendControlRequest.mockResolvedValue({ ok: true, data: records });

    await runMemoryRecent({ limit: "3", json: true, write });

    expect(mocks.sendControlRequest).toHaveBeenCalledWith(expect.any(String), {
      cmd: "memory.recent",
      limit: 3,
    });
    expect(JSON.parse(lines.join("\n"))).toEqual(records);
  });

  it("says when nothing matches", async () => {
    mocks.sendControlRequest.mockResolvedValue({ ok: true, data: [] });

    await runMemoryRecent({ write });

    expect(lines).toEqual(["No memory entries."]);
  });

  it("rejects an invalid limit and an empty query locally", async () => {
    await runMemoryRecent({ limit: "0", write });
    await runMemoryRecent({ limit: "101", write });
    await runMemorySearch("deploy", { limit: "2.5", write });
    await runMemorySearch("   ", { write });

    expect(mocks.sendControlRequest).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('Invalid limit "0"'),
    );
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('Invalid limit "101"'),
    );
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('Invalid limit "2.5"'),
    );
    expect(logger.error).toHaveBeenCalledWith("The search query is empty.");
    expect(process.exitCode).toBe(1);
  });

  it("export sends an absolute path and prints what was written", async () => {
    mocks.sendControlRequest.mockResolvedValue({
      ok: true,
      data: { path: resolve("backup/memory.db"), bytes: 1_572_864, entries: 42 },
    });

    await runMemoryExport("backup/memory.db", { write });

    expect(mocks.sendControlRequest).toHaveBeenCalledWith(expect.any(String), {
      cmd: "memory.export",
      path: resolve("backup/memory.db"),
    });
    expect(lines).toEqual([
      `Exported 42 entries (1.5 MiB) to ${resolve("backup/memory.db")}`,
    ]);
  });

  it("export prints JSON, a single entry and small sizes", async () => {
    const data = { path: "/b/one.db", bytes: 900, entries: 1 };
    mocks.sendControlRequest.mockResolvedValue({ ok: true, data });

    await runMemoryExport("/b/one.db", { write });
    await runMemoryExport("/b/one.db", { json: true, write });

    expect(lines[0]).toBe("Exported 1 entry (900 B) to /b/one.db");
    expect(JSON.parse(lines.slice(1).join("\n"))).toEqual(data);
  });

  it("export refuses an empty path locally and reports a worker refusal", async () => {
    await runMemoryExport("  ", { write });
    expect(mocks.sendControlRequest).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith("The export path is empty.");

    mocks.sendControlRequest.mockResolvedValue({
      ok: false,
      error: "/b/one.db already exists; export to a new path.",
    });
    await runMemoryExport("/b/one.db", { write });

    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("already exists; export to a new path."),
    );
    expect(lines).toEqual([]);
    expect(process.exitCode).toBe(1);
  });

  it("exposes search and recent as subcommands", async () => {
    mocks.sendControlRequest.mockResolvedValue({ ok: true, data: [] });
    const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const subCommands = memoryCommand.subCommands as Record<
      string,
      { run: (ctx: unknown) => Promise<void> }
    >;

    try {
      expect(Object.keys(subCommands).sort()).toEqual(["export", "recent", "search"]);
      await subCommands.search?.run({ args: { _: [], query: "deploy", limit: "2" } });
    } finally {
      stdoutWrite.mockRestore();
    }

    expect(mocks.sendControlRequest).toHaveBeenCalledWith(expect.any(String), {
      cmd: "memory.search",
      query: "deploy",
      limit: 2,
    });
  });
});
