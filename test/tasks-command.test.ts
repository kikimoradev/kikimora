import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Task } from "../src/types.js";

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

const { runTasksAdd, runTasksCancel, runTasksList, runTasksRetry, tasksCommand } =
  await import("../src/tasks-command.js");
const { WorkerNotRunningError } = await import("../src/control-client.js");
const { logger } = await import("../src/logger.js");

function buildTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "ci-42",
    title: "Fix the build",
    description: "details",
    status: "pending",
    attempts: 1,
    createdAt: "2026-07-08T08:00:00.000Z",
    updatedAt: "2026-07-08T08:00:00.000Z",
    ...overrides,
  };
}

describe("tasks commands", () => {
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

  it("list prints one row per task", async () => {
    mocks.sendControlRequest.mockResolvedValue({
      ok: true,
      data: [buildTask(), buildTask({ id: "manual-1", status: "failed", attempts: 3 })],
    });

    await runTasksList({ write });

    expect(mocks.sendControlRequest).toHaveBeenCalledWith(expect.any(String), {
      cmd: "tasks.list",
    });
    expect(lines[0]).toMatch(/^ci-42\s+pending\s+1\s+Fix the build$/);
    expect(lines[1]).toMatch(/^manual-1\s+failed\s+3\s+Fix the build$/);
  });

  it("list forwards a status filter and prints JSON", async () => {
    const tasks = [buildTask({ status: "failed" })];
    mocks.sendControlRequest.mockResolvedValue({ ok: true, data: tasks });

    await runTasksList({ status: "failed", json: true, write });

    expect(mocks.sendControlRequest).toHaveBeenCalledWith(expect.any(String), {
      cmd: "tasks.list",
      status: "failed",
    });
    expect(JSON.parse(lines.join("\n"))).toEqual(tasks);
  });

  it("list says when the queue is empty", async () => {
    mocks.sendControlRequest.mockResolvedValue({ ok: true, data: [] });

    await runTasksList({ write });

    expect(lines).toEqual(["No tasks."]);
  });

  it("list rejects an unknown status before contacting the worker", async () => {
    await runTasksList({ status: "nope", write });

    expect(mocks.sendControlRequest).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('Unknown task status "nope"'),
    );
    expect(process.exitCode).toBe(1);
  });

  it("add sends the description with optional id and title", async () => {
    mocks.sendControlRequest.mockResolvedValue({ ok: true, data: buildTask() });

    await runTasksAdd("Fix the build", { id: "ci-42", title: "Custom", write });

    expect(mocks.sendControlRequest).toHaveBeenCalledWith(expect.any(String), {
      cmd: "tasks.add",
      description: "Fix the build",
      id: "ci-42",
      title: "Custom",
    });
    expect(logger.success).toHaveBeenCalledWith("Task ci-42 added.");
  });

  it("add omits absent options and can print the task as JSON", async () => {
    mocks.sendControlRequest.mockResolvedValue({ ok: true, data: buildTask() });

    await runTasksAdd("Fix the build", { json: true, write });

    expect(mocks.sendControlRequest).toHaveBeenCalledWith(expect.any(String), {
      cmd: "tasks.add",
      description: "Fix the build",
    });
    expect(JSON.parse(lines.join("\n"))).toEqual(buildTask());
  });

  it("add rejects an empty description locally", async () => {
    await runTasksAdd("   ", { write });

    expect(mocks.sendControlRequest).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith("The task description is empty.");
    expect(process.exitCode).toBe(1);
  });

  it("add surfaces a duplicate id from the worker", async () => {
    mocks.sendControlRequest.mockResolvedValue({
      ok: false,
      error: 'Task "ci-42" already exists.',
    });

    await runTasksAdd("Fix the build", { id: "ci-42", write });

    expect(logger.error).toHaveBeenCalledWith('Task "ci-42" already exists.');
    expect(process.exitCode).toBe(1);
  });

  it("retry reports success and a missing failed task", async () => {
    mocks.sendControlRequest.mockResolvedValueOnce({ ok: true, data: true });
    await runTasksRetry("ci-42");
    expect(logger.success).toHaveBeenCalledWith("Task ci-42 requeued.");

    mocks.sendControlRequest.mockResolvedValueOnce({ ok: true, data: false });
    await runTasksRetry("nope");
    expect(logger.error).toHaveBeenCalledWith('No failed task "nope".');
    expect(process.exitCode).toBe(1);
  });

  it("cancel reports success and a missing pending task", async () => {
    mocks.sendControlRequest.mockResolvedValueOnce({ ok: true, data: true });
    await runTasksCancel("ci-42");
    expect(logger.success).toHaveBeenCalledWith("Task ci-42 cancelled.");

    mocks.sendControlRequest.mockResolvedValueOnce({ ok: true, data: false });
    await runTasksCancel("nope");
    expect(logger.error).toHaveBeenCalledWith('No pending task "nope".');
    expect(process.exitCode).toBe(1);
  });

  it("fails cleanly when no worker is running", async () => {
    mocks.sendControlRequest.mockRejectedValue(new WorkerNotRunningError());

    await runTasksList({ write });

    expect(logger.error).toHaveBeenCalledWith(
      "No kikimora worker is running in this project.",
    );
    expect(process.exitCode).toBe(1);
    expect(lines).toEqual([]);
  });

  it("exposes list, add, retry and cancel as subcommands", async () => {
    mocks.sendControlRequest.mockResolvedValue({ ok: true, data: [] });
    const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const subCommands = tasksCommand.subCommands as Record<
      string,
      { run: (ctx: unknown) => Promise<void> }
    >;

    try {
      expect(Object.keys(subCommands).sort()).toEqual(["add", "cancel", "list", "retry"]);
      await subCommands.list?.run({ args: { _: [], json: true } });
    } finally {
      stdoutWrite.mockRestore();
    }

    expect(mocks.sendControlRequest).toHaveBeenCalledWith(expect.any(String), {
      cmd: "tasks.list",
    });
  });
});
