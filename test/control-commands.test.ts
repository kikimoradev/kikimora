import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ControlStatus, WorkerIdentity } from "../src/control-protocol.js";
import { snapshotEnv } from "./helpers.js";

const mocks = vi.hoisted(() => ({
  sendControlRequest: vi.fn(),
}));

vi.mock("../src/control-client.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/control-client.js")>();
  return {
    WorkerNotRunningError: original.WorkerNotRunningError,
    sendControlRequest: mocks.sendControlRequest,
  };
});
vi.mock("../src/logger.js", async () =>
  (await import("./helpers.js")).loggerModuleMock(),
);

const {
  drainCommand,
  readStdinText,
  requestControl,
  runControlAction,
  runDrain,
  runStatus,
  runVersion,
  statusCommand,
  versionCommand,
} = await import("../src/control-commands.js");
const { WorkerNotRunningError } = await import("../src/control-client.js");
const { logger } = await import("../src/logger.js");

function buildIdentity(overrides: Partial<WorkerIdentity> = {}): WorkerIdentity {
  return {
    version: "1.0.0",
    claudeVersion: "2.1.268",
    nodeVersion: "22.16.0",
    pid: 4242,
    startedAt: new Date(Date.now() - 90 * 60_000).toISOString(),
    projectDir: "/srv/project",
    authKind: "oauth",
    ...overrides,
  };
}

function buildStatus(overrides: Partial<ControlStatus> = {}): ControlStatus {
  return {
    ...buildIdentity(),
    headless: true,
    agents: {
      monitor: {
        phase: { kind: "sleeping", until: "2026-07-08T09:15:00.000Z" },
        control: "running",
        recentOutcomes: [],
      },
      executor: {
        phase: { kind: "session", taskId: "t-1", title: "Fix", since: "x" },
        control: "running",
        recentOutcomes: [],
      },
    },
    stats: { cycles: 12, tasksSucceeded: 5, tasksFailed: 1, totalCostUsd: 1.2345 },
    taskCounts: { pending: 2, in_progress: 1, done: 5, failed: 1, cancelled: 0 },
    ...overrides,
  };
}

describe("runStatus", () => {
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

  it("prints a human-readable summary", async () => {
    mocks.sendControlRequest.mockResolvedValue({ ok: true, data: buildStatus() });

    await runStatus({ write });

    expect(mocks.sendControlRequest).toHaveBeenCalledWith(
      expect.stringContaining("brownie-"),
      { cmd: "status" },
    );
    const output = lines.join("\n");
    expect(lines[0]).toBe(
      "brownie 1.0.0 · claude 2.1.268 · auth oauth · pid 4242 · up 1h 30m · headless",
    );
    expect(output).toContain("project   /srv/project");
    expect(output).toContain("monitor   running  sleeping · until");
    expect(output).toContain("executor  running  session · t-1");
    expect(output).toContain(
      "tasks     pending 2 · in_progress 1 · done 5 · failed 1 · cancelled 0",
    );
    expect(output).toContain(
      "stats     cycles 12 · tasks ok 5 · tasks failed 1 · cost $1.2345",
    );
  });

  it("shows the auth block reason next to the phase", async () => {
    mocks.sendControlRequest.mockResolvedValue({
      ok: true,
      data: buildStatus({
        agents: {
          monitor: {
            phase: { kind: "authBlocked", since: "x", reason: "Not logged in" },
            control: "paused",
            recentOutcomes: [],
          },
          executor: {
            phase: { kind: "authBlocked", since: "x", reason: "HTTP 401" },
            control: "paused",
            recentOutcomes: [],
          },
        },
      }),
    });

    await runStatus({ write });

    const output = lines.join("\n");
    expect(output).toContain("monitor   paused   authBlocked · Not logged in");
    expect(output).toContain("executor  paused   authBlocked · HTTP 401");
  });

  it("adds a drain line while the worker drains", async () => {
    const since = "2026-07-08T09:00:00.000Z";
    const until = "2026-07-08T09:15:00.000Z";
    mocks.sendControlRequest.mockResolvedValue({
      ok: true,
      data: buildStatus({ drain: { since, until, reason: "SIGTERM" } }),
    });

    await runStatus({ write });

    expect(lines).toHaveLength(7);
    expect(lines[6]).toBe(
      `draining  since ${new Date(since).toLocaleTimeString()} · until ${new Date(until).toLocaleTimeString()} · SIGTERM`,
    );
  });

  it("shows a drain without a deadline", async () => {
    const since = "2026-07-08T09:00:00.000Z";
    mocks.sendControlRequest.mockResolvedValue({
      ok: true,
      data: buildStatus({ drain: { since, reason: "drain" } }),
    });

    await runStatus({ write });

    expect(lines[6]).toBe(
      `draining  since ${new Date(since).toLocaleTimeString()} · drain`,
    );
  });

  it("shows claude unknown when the worker could not read the CLI version", async () => {
    mocks.sendControlRequest.mockResolvedValue({
      ok: true,
      data: buildStatus({ claudeVersion: undefined, authKind: "unknown" }),
    });

    await runStatus({ write });

    expect(lines[0]).toContain(
      "brownie 1.0.0 · claude unknown · auth unknown · pid 4242",
    );
  });

  it("renders a status document from an older worker that predates the identity fields", async () => {
    const { version, pid, startedAt, projectDir, headless, agents, stats, taskCounts } =
      buildStatus();
    mocks.sendControlRequest.mockResolvedValue({
      ok: true,
      data: { version, pid, startedAt, projectDir, headless, agents, stats, taskCounts },
    });

    await runStatus({ write });

    expect(lines[0]).toBe(
      "brownie 1.0.0 · claude unknown · auth unknown · pid 4242 · up 1h 30m · headless",
    );
    expect(lines).toHaveLength(6);
  });

  it("prints raw JSON with --json", async () => {
    const status = buildStatus();
    mocks.sendControlRequest.mockResolvedValue({ ok: true, data: status });

    await runStatus({ json: true, write });

    expect(JSON.parse(lines.join("\n"))).toEqual(status);
  });

  it("fails with exit code 1 when no worker is running", async () => {
    mocks.sendControlRequest.mockRejectedValue(new WorkerNotRunningError());

    await runStatus({ write });

    expect(logger.error).toHaveBeenCalledWith(
      "No brownie worker is running in this project.",
    );
    expect(process.exitCode).toBe(1);
    expect(lines).toEqual([]);
  });

  it("fails when the worker returns an error response", async () => {
    mocks.sendControlRequest.mockResolvedValue({ ok: false, error: "broken" });

    await runStatus({ write });

    expect(logger.error).toHaveBeenCalledWith("broken");
    expect(process.exitCode).toBe(1);
  });

  it("talks to the socket named by BROWNIE_CONTROL_SOCKET", async () => {
    const restoreEnv = snapshotEnv();
    process.env.BROWNIE_CONTROL_SOCKET = "/run/brownie/control.sock";
    mocks.sendControlRequest.mockResolvedValue({ ok: true, data: buildStatus() });

    try {
      await runStatus({ write });
    } finally {
      restoreEnv();
    }

    expect(mocks.sendControlRequest).toHaveBeenCalledWith("/run/brownie/control.sock", {
      cmd: "status",
    });
  });

  it("rejects an invalid BROWNIE_CONTROL_SOCKET before contacting the worker", async () => {
    const restoreEnv = snapshotEnv();
    process.env.BROWNIE_CONTROL_SOCKET = "relative/control.sock";

    try {
      await runStatus({ write });
    } finally {
      restoreEnv();
    }

    expect(mocks.sendControlRequest).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("BROWNIE_CONTROL_SOCKET must be an absolute path"),
    );
    expect(process.exitCode).toBe(1);
  });

  it("statusCommand.run forwards the json flag", async () => {
    mocks.sendControlRequest.mockResolvedValue({ ok: true, data: buildStatus() });
    const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    try {
      await (statusCommand.run as (ctx: unknown) => Promise<void>)({
        args: { json: true, _: [] },
      });
    } finally {
      stdoutWrite.mockRestore();
    }

    expect(mocks.sendControlRequest).toHaveBeenCalledWith(expect.any(String), {
      cmd: "status",
    });
  });
});

describe("runVersion", () => {
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

  it("prints one labelled line per identity field", async () => {
    const identity = buildIdentity({
      authKind: "apiKey",
      startedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    });
    mocks.sendControlRequest.mockResolvedValue({ ok: true, data: identity });

    await runVersion({ write });

    expect(mocks.sendControlRequest).toHaveBeenCalledWith(expect.any(String), {
      cmd: "version",
    });
    expect(lines).toEqual([
      "brownie   1.0.0",
      "claude    2.1.268",
      "node      22.16.0",
      "auth      apiKey",
      "pid       4242",
      `started   ${identity.startedAt} · up 5m`,
      "project   /srv/project",
    ]);
  });

  it("prints claude unknown when the worker could not read the CLI version", async () => {
    mocks.sendControlRequest.mockResolvedValue({
      ok: true,
      data: buildIdentity({ claudeVersion: undefined }),
    });

    await runVersion({ write });

    expect(lines).toContain("claude    unknown");
  });

  it("prints raw JSON with --json", async () => {
    const identity = buildIdentity();
    mocks.sendControlRequest.mockResolvedValue({ ok: true, data: identity });

    await runVersion({ json: true, write });

    expect(JSON.parse(lines.join("\n"))).toEqual(identity);
  });

  it("fails with exit code 1 when no worker is running", async () => {
    mocks.sendControlRequest.mockRejectedValue(new WorkerNotRunningError());

    await runVersion({ write });

    expect(logger.error).toHaveBeenCalledWith(
      "No brownie worker is running in this project.",
    );
    expect(process.exitCode).toBe(1);
    expect(lines).toEqual([]);
  });

  it("explains a worker that predates the version command", async () => {
    mocks.sendControlRequest.mockResolvedValue({
      ok: false,
      error: "Unrecognized control request.",
    });

    await runVersion({ write });

    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('does not support "version"'),
    );
    expect(process.exitCode).toBe(1);
    expect(lines).toEqual([]);
  });

  it("versionCommand.run forwards the json flag", async () => {
    const identity = buildIdentity();
    mocks.sendControlRequest.mockResolvedValue({ ok: true, data: identity });
    const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    try {
      await (versionCommand.run as (ctx: unknown) => Promise<void>)({
        args: { json: true, _: [] },
      });
      const written = stdoutWrite.mock.calls
        .map(([chunk]) => (typeof chunk === "string" ? chunk : ""))
        .join("");
      expect(JSON.parse(written)).toEqual(identity);
    } finally {
      stdoutWrite.mockRestore();
    }

    expect(mocks.sendControlRequest).toHaveBeenCalledWith(expect.any(String), {
      cmd: "version",
    });
  });
});

describe("requestControl", () => {
  let savedExitCode: typeof process.exitCode;

  beforeEach(() => {
    vi.clearAllMocks();
    savedExitCode = process.exitCode;
  });

  afterEach(() => {
    process.exitCode = savedExitCode;
  });

  it("returns the success response", async () => {
    mocks.sendControlRequest.mockResolvedValue({ ok: true, data: true });

    await expect(requestControl({ cmd: "tasks.retry", id: "t" }, {})).resolves.toEqual({
      ok: true,
      data: true,
    });
    expect(process.exitCode).toBe(savedExitCode);
  });

  it("logs a rejected request and returns null", async () => {
    mocks.sendControlRequest.mockResolvedValue({ ok: false, error: "nope" });

    await expect(requestControl({ cmd: "status" }, {})).resolves.toBeNull();
    expect(logger.error).toHaveBeenCalledWith("nope");
    expect(process.exitCode).toBe(1);
  });

  it("logs a transport failure and returns null", async () => {
    mocks.sendControlRequest.mockRejectedValue(new Error("Timed out"));

    await expect(requestControl({ cmd: "status" }, {})).resolves.toBeNull();
    expect(logger.error).toHaveBeenCalledWith("Timed out");
    expect(process.exitCode).toBe(1);
  });

  it("readStdinText refuses to wait on an interactive terminal", async () => {
    const wasTty = process.stdin.isTTY;
    process.stdin.isTTY = true;
    try {
      await expect(readStdinText()).rejects.toThrow(
        "Pass a file path or pipe the content",
      );
    } finally {
      process.stdin.isTTY = wasTty;
    }
  });
});

describe("runControlAction", () => {
  let savedExitCode: typeof process.exitCode;

  beforeEach(() => {
    vi.clearAllMocks();
    savedExitCode = process.exitCode;
  });

  afterEach(() => {
    process.exitCode = savedExitCode;
  });

  it("pauses both agents by default", async () => {
    mocks.sendControlRequest.mockResolvedValue({ ok: true });

    await runControlAction("pause", undefined);

    expect(mocks.sendControlRequest).toHaveBeenCalledWith(expect.any(String), {
      cmd: "pause",
      agent: "all",
    });
    expect(logger.success).toHaveBeenCalledWith("Pausing monitor and executor.");
  });

  it("resumes a single agent", async () => {
    mocks.sendControlRequest.mockResolvedValue({ ok: true });

    await runControlAction("resume", "monitor");

    expect(mocks.sendControlRequest).toHaveBeenCalledWith(expect.any(String), {
      cmd: "resume",
      agent: "monitor",
    });
    expect(logger.success).toHaveBeenCalledWith("Resumed monitor.");
  });

  it("rejects an unknown agent name", async () => {
    await runControlAction("pause", "summarizer");

    expect(mocks.sendControlRequest).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('Unknown agent "summarizer"'),
    );
    expect(process.exitCode).toBe(1);
  });

  it("rejects the literal all in favor of omitting the agent", async () => {
    await runControlAction("pause", "all");

    expect(mocks.sendControlRequest).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it("fails with exit code 1 when no worker is running", async () => {
    mocks.sendControlRequest.mockRejectedValue(new WorkerNotRunningError());

    await runControlAction("resume", undefined);

    expect(logger.error).toHaveBeenCalledWith(
      "No brownie worker is running in this project.",
    );
    expect(process.exitCode).toBe(1);
  });
});

describe("runDrain", () => {
  let lines: string[];
  let savedExitCode: typeof process.exitCode;
  const write = (line: string) => lines.push(line);
  const since = "2026-07-08T09:00:00.000Z";
  const until = "2026-07-08T09:15:00.000Z";

  beforeEach(() => {
    vi.clearAllMocks();
    lines = [];
    savedExitCode = process.exitCode;
  });

  afterEach(() => {
    process.exitCode = savedExitCode;
  });

  it("asks for a drain without a deadline and says when it started", async () => {
    mocks.sendControlRequest.mockResolvedValue({
      ok: true,
      data: { state: "draining", since },
    });

    await runDrain({ write });

    expect(mocks.sendControlRequest).toHaveBeenCalledWith(expect.any(String), {
      cmd: "drain",
    });
    expect(logger.success).toHaveBeenCalledWith(
      `Draining since ${new Date(since).toLocaleTimeString()} — the worker exits once its current sessions finish.`,
    );
    expect(lines).toEqual([]);
    expect(process.exitCode).toBe(savedExitCode);
  });

  it("passes the timeout and names the deadline", async () => {
    mocks.sendControlRequest.mockResolvedValue({
      ok: true,
      data: { state: "draining", since, until },
    });

    await runDrain({ timeout: "900000", write });

    expect(mocks.sendControlRequest).toHaveBeenCalledWith(expect.any(String), {
      cmd: "drain",
      timeoutMs: 900_000,
    });
    expect(logger.success).toHaveBeenCalledWith(
      `Draining since ${new Date(since).toLocaleTimeString()} — the worker exits once its current sessions finish, by ${new Date(until).toLocaleTimeString()} at the latest.`,
    );
  });

  it("prints the acknowledgement as JSON", async () => {
    const ack = { state: "draining", since, until };
    mocks.sendControlRequest.mockResolvedValue({ ok: true, data: ack });

    await runDrain({ json: true, write });

    expect(JSON.parse(lines.join("\n"))).toEqual(ack);
    expect(logger.success).not.toHaveBeenCalled();
  });

  it("rejects a timeout that is not a whole number of milliseconds in range", async () => {
    for (const timeout of ["0", "-5", "1.5", "soon", "", "86400001"]) {
      process.exitCode = savedExitCode;

      await runDrain({ timeout, write });

      expect(logger.error).toHaveBeenLastCalledWith(
        `Invalid timeout "${timeout}" — use a whole number of milliseconds from 1 to 86400000.`,
      );
      expect(process.exitCode).toBe(1);
    }
    expect(mocks.sendControlRequest).not.toHaveBeenCalled();
  });

  it("explains a worker that predates drain", async () => {
    mocks.sendControlRequest.mockResolvedValue({
      ok: false,
      error: "Unrecognized control request.",
    });

    await runDrain({ write });

    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('does not support "drain"'),
    );
    expect(process.exitCode).toBe(1);
  });

  it("fails with exit code 1 when no worker is running", async () => {
    mocks.sendControlRequest.mockRejectedValue(new WorkerNotRunningError());

    await runDrain({ json: true, write });

    expect(logger.error).toHaveBeenCalledWith(
      "No brownie worker is running in this project.",
    );
    expect(process.exitCode).toBe(1);
    expect(lines).toEqual([]);
  });

  it("drainCommand.run forwards the timeout and json flags", async () => {
    const ack = { state: "draining", since, until };
    mocks.sendControlRequest.mockResolvedValue({ ok: true, data: ack });
    const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    try {
      await (drainCommand.run as (ctx: unknown) => Promise<void>)({
        args: { timeout: "60000", json: true, _: [] },
      });
      const written = stdoutWrite.mock.calls
        .map(([chunk]) => (typeof chunk === "string" ? chunk : ""))
        .join("");
      expect(JSON.parse(written)).toEqual(ack);
    } finally {
      stdoutWrite.mockRestore();
    }

    expect(mocks.sendControlRequest).toHaveBeenCalledWith(expect.any(String), {
      cmd: "drain",
      timeoutMs: 60_000,
    });
  });
});
