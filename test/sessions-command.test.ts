import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionRecord } from "../src/sessions/index.js";
import { createTempDir, removeTempDir } from "./helpers.js";

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

const { sessionsCommand, runSessionsList, runSessionsShow } =
  await import("../src/sessions-command.js");
const { logger } = await import("../src/logger.js");

function buildRecord(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    sessionId: "sess-1",
    agent: "executor",
    taskId: "ci-42",
    model: "opus",
    startedAt: "2026-09-14T15:44:12.531Z",
    finishedAt: "2026-09-14T15:49:00.000Z",
    ok: true,
    costUsd: 0.4183,
    numTurns: 24,
    logPath: "logs/executor/2026-09-14/17-44-12-sess-1.log",
    jsonlPath: "logs/executor/2026-09-14/17-44-12-sess-1.jsonl",
    ...overrides,
  };
}

describe("sessions commands", () => {
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

  it("list prints one line per session with the default limit", async () => {
    mocks.sendControlRequest.mockResolvedValue({
      ok: true,
      data: [
        buildRecord(),
        buildRecord({
          sessionId: "sess-2",
          agent: "monitor",
          taskId: undefined,
          ok: false,
          failureReason: "timeout",
          costUsd: undefined,
        }),
      ],
    });

    await runSessionsList({ write });

    expect(mocks.sendControlRequest).toHaveBeenCalledWith(expect.any(String), {
      cmd: "sessions.list",
      limit: 20,
    });
    expect(lines[0]).toBe(
      "2026-09-14T15:44:12.531Z executor   ok       sess-1 ci-42 $0.4183",
    );
    expect(lines[1]).toBe("2026-09-14T15:44:12.531Z monitor    timeout  sess-2");
  });

  it("list forwards every filter and prints JSON", async () => {
    const records = [buildRecord()];
    mocks.sendControlRequest.mockResolvedValue({ ok: true, data: records });

    await runSessionsList({
      agent: "executor",
      task: "ci-42",
      before: "2026-09-14T15:44:12.531Z",
      limit: "5",
      json: true,
      write,
    });

    expect(mocks.sendControlRequest).toHaveBeenCalledWith(expect.any(String), {
      cmd: "sessions.list",
      agent: "executor",
      taskId: "ci-42",
      before: "2026-09-14T15:44:12.531Z",
      limit: 5,
    });
    expect(JSON.parse(lines.join("\n"))).toEqual(records);
  });

  it("list says when the index is empty", async () => {
    mocks.sendControlRequest.mockResolvedValue({ ok: true, data: [] });

    await runSessionsList({ write });

    expect(lines).toEqual(["No sessions."]);
  });

  it("list rejects an unknown agent and an invalid limit locally", async () => {
    await runSessionsList({ agent: "wizard", write });
    await runSessionsList({ limit: "0", write });

    expect(mocks.sendControlRequest).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('Unknown agent "wizard"'),
    );
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('Invalid limit "0"'),
    );
    expect(process.exitCode).toBe(1);
  });

  it("show prints the metadata and the absolute file paths", async () => {
    mocks.sendControlRequest.mockResolvedValue({ ok: true, data: buildRecord() });

    await runSessionsShow("sess-1", { projectDir: "/srv/project", write });

    expect(mocks.sendControlRequest).toHaveBeenCalledWith(expect.any(String), {
      cmd: "sessions.get",
      sessionId: "sess-1",
    });
    expect(lines).toEqual([
      "session   sess-1",
      "agent     executor",
      "task      ci-42",
      "model     opus",
      "started   2026-09-14T15:44:12.531Z",
      "finished  2026-09-14T15:49:00.000Z",
      "result    ok",
      "cost      $0.4183",
      "turns     24",
      `log       ${join("/srv/project", ".kikimora", "logs/executor/2026-09-14/17-44-12-sess-1.log")}`,
      `jsonl     ${join("/srv/project", ".kikimora", "logs/executor/2026-09-14/17-44-12-sess-1.jsonl")}`,
    ]);
  });

  it("show marks a session with no outcome as running", async () => {
    mocks.sendControlRequest.mockResolvedValue({
      ok: true,
      data: buildRecord({
        agent: "monitor",
        taskId: undefined,
        cycle: 3,
        finishedAt: undefined,
        ok: undefined,
        costUsd: undefined,
        numTurns: undefined,
      }),
    });

    await runSessionsShow("sess-1", { projectDir: "/srv/project", write });

    expect(lines).toContain("cycle     3");
    expect(lines).toContain("result    running");
    expect(lines.some((line) => line.startsWith("finished"))).toBe(false);
  });

  it("show --log appends the readable log and complains when it is gone", async () => {
    const dir = await createTempDir();
    try {
      const logPath = join("logs", "executor", "2026-09-14", "17-44-12-sess-1.log");
      await mkdir(join(dir, ".kikimora", "logs", "executor", "2026-09-14"), {
        recursive: true,
      });
      await writeFile(join(dir, ".kikimora", logPath), "[17:44:12] hello\n", "utf8");
      mocks.sendControlRequest.mockResolvedValue({
        ok: true,
        data: buildRecord({ logPath }),
      });

      await runSessionsShow("sess-1", { projectDir: dir, log: true, write });
      expect(lines.at(-1)).toBe("[17:44:12] hello\n");

      mocks.sendControlRequest.mockResolvedValue({
        ok: true,
        data: buildRecord({ logPath: "logs/executor/gone.log" }),
      });
      await runSessionsShow("sess-1", { projectDir: dir, log: true, write });
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining("Cannot read the session log"),
      );
    } finally {
      await removeTempDir(dir);
    }
  });

  it("show rejects a blank session id locally", async () => {
    await runSessionsShow("   ", { write });

    expect(mocks.sendControlRequest).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith("The session id is empty.");
    expect(process.exitCode).toBe(1);
  });

  it("show prints JSON with --json", async () => {
    const record = buildRecord();
    mocks.sendControlRequest.mockResolvedValue({ ok: true, data: record });

    await runSessionsShow("sess-1", { json: true, write });

    expect(JSON.parse(lines.join("\n"))).toEqual(record);
  });

  it("exposes list and show as subcommands", async () => {
    mocks.sendControlRequest.mockResolvedValue({ ok: true, data: [] });
    const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const subCommands = sessionsCommand.subCommands as Record<
      string,
      { run: (ctx: unknown) => Promise<void> }
    >;

    try {
      expect(Object.keys(subCommands).sort()).toEqual(["list", "show"]);
      await subCommands.list?.run({ args: { _: [], agent: "monitor", limit: "2" } });
    } finally {
      stdoutWrite.mockRestore();
    }

    expect(mocks.sendControlRequest).toHaveBeenCalledWith(expect.any(String), {
      cmd: "sessions.list",
      agent: "monitor",
      limit: 2,
    });
  });
});
