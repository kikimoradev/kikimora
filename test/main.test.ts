import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { snapshotEnv } from "./helpers.js";

const mocks = vi.hoisted(() => ({
  isConfigured: vi.fn(),
  runConfigure: vi.fn(),
  startWorker: vi.fn(),
}));

vi.mock("../src/configure.js", () => ({
  isConfigured: mocks.isConfigured,
  runConfigure: mocks.runConfigure,
}));
vi.mock("../src/start.js", () => ({ startWorker: mocks.startWorker }));
vi.mock("../src/logger.js", async () =>
  (await import("./helpers.js")).loggerModuleMock(),
);

const { mainCommand, parseStartPaused, runKikimora } = await import("../src/main.js");
const { logger } = await import("../src/logger.js");

describe("runKikimora", () => {
  let savedExitCode: typeof process.exitCode;

  beforeEach(() => {
    vi.clearAllMocks();
    savedExitCode = process.exitCode;
    mocks.startWorker.mockResolvedValue(undefined);
  });

  afterEach(() => {
    process.exitCode = savedExitCode;
  });

  it("starts the worker directly when everything is configured", async () => {
    mocks.isConfigured.mockReturnValue(true);

    await runKikimora({ interactive: true });

    expect(mocks.isConfigured).toHaveBeenCalledTimes(1);
    expect(mocks.runConfigure).not.toHaveBeenCalled();
    expect(mocks.startWorker).toHaveBeenCalledTimes(1);
  });

  it("runs the wizard before starting on first run", async () => {
    const order: string[] = [];
    mocks.isConfigured.mockReturnValue(false);
    mocks.runConfigure.mockImplementation(() => {
      order.push("configure");
      return Promise.resolve(true);
    });
    mocks.startWorker.mockImplementation(() => {
      order.push("start");
      return Promise.resolve();
    });

    await runKikimora({ interactive: true });

    expect(mocks.runConfigure).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["configure", "start"]);
  });

  it("does not start when the wizard is cancelled on first run", async () => {
    mocks.isConfigured.mockReturnValue(false);
    mocks.runConfigure.mockResolvedValue(false);

    await runKikimora({ interactive: true });

    expect(mocks.startWorker).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(savedExitCode);
  });

  it("skips the wizard without a TTY and lets preflight report the problem", async () => {
    mocks.isConfigured.mockReturnValue(false);

    await runKikimora({ interactive: false });

    expect(mocks.runConfigure).not.toHaveBeenCalled();
    expect(mocks.startWorker).toHaveBeenCalledTimes(1);
  });

  it("rejects a legacy subcommand with exit code 1", async () => {
    mocks.isConfigured.mockReturnValue(true);

    await runKikimora({ positionals: ["start"], interactive: true });

    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('Unknown command "start"'),
    );
    expect(process.exitCode).toBe(1);
    expect(mocks.runConfigure).not.toHaveBeenCalled();
    expect(mocks.startWorker).not.toHaveBeenCalled();
  });

  it("passes headless options through to the worker", async () => {
    mocks.isConfigured.mockReturnValue(true);

    await runKikimora({
      interactive: true,
      headless: true,
      logFormat: "json",
      verbose: true,
    });

    expect(mocks.startWorker).toHaveBeenCalledWith({
      headless: true,
      logFormat: "json",
      verbose: true,
      paused: false,
    });
  });

  it("passes --paused through to the worker", async () => {
    mocks.isConfigured.mockReturnValue(true);

    await runKikimora({ interactive: true, paused: true });

    expect(mocks.startWorker).toHaveBeenCalledWith(
      expect.objectContaining({ paused: true }),
    );
  });

  it("reads KIKIMORA_START_PAUSED when the flag is absent", async () => {
    const restoreEnv = snapshotEnv();
    mocks.isConfigured.mockReturnValue(true);

    try {
      process.env.KIKIMORA_START_PAUSED = "1";
      await runKikimora({ interactive: true });
      process.env.KIKIMORA_START_PAUSED = "0";
      await runKikimora({ interactive: true });
      await runKikimora({ interactive: true, paused: true });
    } finally {
      restoreEnv();
    }

    expect(
      mocks.startWorker.mock.calls.map((call) => (call[0] as { paused: boolean }).paused),
    ).toEqual([true, false, true]);
  });

  it("defaults to the pretty log format", async () => {
    mocks.isConfigured.mockReturnValue(true);

    await runKikimora({ interactive: true });

    expect(mocks.startWorker).toHaveBeenCalledWith(
      expect.objectContaining({ headless: false, logFormat: "pretty" }),
    );
  });

  it("reads the log format from KIKIMORA_LOG_FORMAT when no flag is given", async () => {
    const restoreEnv = snapshotEnv();
    process.env.KIKIMORA_LOG_FORMAT = "json";
    mocks.isConfigured.mockReturnValue(true);

    try {
      await runKikimora({ interactive: true });
    } finally {
      restoreEnv();
    }

    expect(mocks.startWorker).toHaveBeenCalledWith(
      expect.objectContaining({ logFormat: "json" }),
    );
  });

  it("rejects an invalid log format with exit code 1", async () => {
    mocks.isConfigured.mockReturnValue(true);

    await runKikimora({ interactive: true, logFormat: "logfmt" });

    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('Invalid log format "logfmt"'),
    );
    expect(process.exitCode).toBe(1);
    expect(mocks.startWorker).not.toHaveBeenCalled();
  });

  it("skips the wizard when headless is forced even on first run", async () => {
    mocks.isConfigured.mockReturnValue(false);

    await runKikimora({ interactive: true, headless: true });

    expect(mocks.runConfigure).not.toHaveBeenCalled();
    expect(mocks.startWorker).toHaveBeenCalledWith(
      expect.objectContaining({ headless: true }),
    );
  });

  it("detects interactivity from the terminal when not overridden", async () => {
    mocks.isConfigured.mockReturnValue(false);
    const stdinTty = process.stdin.isTTY;
    const stdoutTty = process.stdout.isTTY;
    process.stdin.isTTY = false;
    process.stdout.isTTY = false;

    try {
      await runKikimora();
    } finally {
      process.stdin.isTTY = stdinTty;
      process.stdout.isTTY = stdoutTty;
    }

    expect(mocks.runConfigure).not.toHaveBeenCalled();
    expect(mocks.startWorker).toHaveBeenCalledTimes(1);
  });
});

describe("parseStartPaused", () => {
  it.each([
    ["1", true],
    ["true", true],
    [" TRUE ", true],
    ["0", false],
    ["false", false],
    ["", false],
    [undefined, false],
  ])("maps %j to %s", (raw, expected) => {
    expect(parseStartPaused(raw)).toBe(expected);
  });
});

describe("mainCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.startWorker.mockResolvedValue(undefined);
  });

  it("passes parsed args to the worker flow", async () => {
    mocks.isConfigured.mockReturnValue(true);

    await (mainCommand.run as (ctx: unknown) => Promise<void>)({
      args: { _: [], paused: true },
    });

    expect(mocks.startWorker).toHaveBeenCalledWith(
      expect.objectContaining({ paused: true }),
    );
  });
});
