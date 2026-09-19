import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

const { flattenSettings, runSettingsGet, runSettingsPatch, settingsCommand } =
  await import("../src/settings-command.js");
const { logger } = await import("../src/logger.js");

const settings = {
  monitor: { model: "haiku", effort: "medium", intervalMinutes: 15 },
  executor: { model: "opus", effort: "high", maxTaskAttempts: 3, retryDelayMs: 30000 },
  summarizer: { model: "sonnet", effort: "medium", sessionTimeoutMs: 300000 },
  streamPartial: true,
};

describe("settings commands", () => {
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

  it("flattenSettings renders dotted paths with JSON values", () => {
    expect(flattenSettings({ a: { b: 1, c: "x" }, d: true, e: null })).toEqual([
      ["a.b", "1"],
      ["a.c", '"x"'],
      ["d", "true"],
      ["e", "null"],
    ]);
  });

  it("get prints dotted lines", async () => {
    mocks.sendControlRequest.mockResolvedValue({ ok: true, data: settings });

    await runSettingsGet({ write });

    expect(mocks.sendControlRequest).toHaveBeenCalledWith(expect.any(String), {
      cmd: "settings.get",
    });
    expect(lines).toContain('monitor.model = "haiku"');
    expect(lines).toContain("executor.maxTaskAttempts = 3");
    expect(lines).toContain("streamPartial = true");
  });

  it("get prints JSON with --json", async () => {
    mocks.sendControlRequest.mockResolvedValue({ ok: true, data: settings });

    await runSettingsGet({ json: true, write });

    expect(JSON.parse(lines.join("\n"))).toEqual(settings);
  });

  it("patch sends the parsed object and confirms", async () => {
    mocks.sendControlRequest.mockResolvedValue({ ok: true, data: settings });

    await runSettingsPatch('{"monitor":{"intervalMinutes":5,"activeHours":null}}', {
      write,
    });

    expect(mocks.sendControlRequest).toHaveBeenCalledWith(expect.any(String), {
      cmd: "settings.patch",
      patch: { monitor: { intervalMinutes: 5, activeHours: null } },
    });
    expect(logger.success).toHaveBeenCalledWith("Settings updated.");
    expect(lines).toEqual([]);
  });

  it("patch reads the object from stdin with - and prints the result with --json", async () => {
    mocks.sendControlRequest.mockResolvedValue({ ok: true, data: settings });
    const readStdin = vi.fn().mockResolvedValue('{"streamPartial":false}');

    await runSettingsPatch("-", { json: true, write, readStdin });

    expect(readStdin).toHaveBeenCalledTimes(1);
    expect(mocks.sendControlRequest).toHaveBeenCalledWith(expect.any(String), {
      cmd: "settings.patch",
      patch: { streamPartial: false },
    });
    expect(JSON.parse(lines.join("\n"))).toEqual(settings);
  });

  it("patch rejects invalid JSON and non-objects locally", async () => {
    await runSettingsPatch("{oops", { write });
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("Invalid JSON patch"),
    );

    await runSettingsPatch("[1]", { write });
    expect(logger.error).toHaveBeenCalledWith("The patch must be a JSON object.");

    expect(mocks.sendControlRequest).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it("patch surfaces a validation error from the worker", async () => {
    mocks.sendControlRequest.mockResolvedValue({
      ok: false,
      error:
        "Invalid configuration (.kikimora/settings.json):\n  - monitor.intervalMinutes: bad",
    });

    await runSettingsPatch('{"monitor":{"intervalMinutes":-1}}', { write });

    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("monitor.intervalMinutes"),
    );
    expect(process.exitCode).toBe(1);
  });

  it("exposes get and patch as subcommands", async () => {
    mocks.sendControlRequest.mockResolvedValue({ ok: true, data: settings });
    const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const subCommands = settingsCommand.subCommands as Record<
      string,
      { run: (ctx: unknown) => Promise<void> }
    >;

    try {
      expect(Object.keys(subCommands).sort()).toEqual(["get", "patch"]);
      await subCommands.patch?.run({ args: { _: [], patch: '{"streamPartial":false}' } });
    } finally {
      stdoutWrite.mockRestore();
    }

    expect(mocks.sendControlRequest).toHaveBeenCalledWith(expect.any(String), {
      cmd: "settings.patch",
      patch: { streamPartial: false },
    });
  });
});
