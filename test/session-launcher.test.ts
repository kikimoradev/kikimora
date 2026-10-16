import { describe, expect, it } from "vitest";
import {
  invalidLauncherMessage,
  launcherFailureReason,
  NO_LAUNCHER,
  parseSessionLauncher,
  sessionCommand,
  type PlacedSession,
} from "../src/session-launcher.js";

const executorSession: PlacedSession = {
  role: "executor",
  pool: "executor",
  ticket: "ticket-9",
};

describe("parseSessionLauncher", () => {
  it("means no launcher when the variable is unset or blank", () => {
    expect(parseSessionLauncher(undefined)).toBe(NO_LAUNCHER);
    expect(parseSessionLauncher("  ")).toBe(NO_LAUNCHER);
  });

  it("accepts a JSON array of non-empty strings", () => {
    expect(parseSessionLauncher('["/usr/local/bin/launch", "--pool", "x y"]')).toEqual([
      "/usr/local/bin/launch",
      "--pool",
      "x y",
    ]);
  });

  it.each([
    ["not JSON", "/usr/local/bin/launch"],
    ["an empty array", "[]"],
    ["an object", '{"command":"launch"}'],
    ["a number inside", '["launch", 1]'],
    ["an empty string inside", '["launch", ""]'],
  ])("rejects %s", (_label, raw) => {
    expect(parseSessionLauncher(raw)).toBeNull();
  });

  it("names the variable and the expected shape in the error", () => {
    expect(invalidLauncherMessage("nope")).toBe(
      'Invalid KIKIMORA_SESSION_LAUNCHER "nope": use a JSON array of non-empty strings, e.g. ["/usr/local/bin/launch","--pool"].',
    );
  });
});

describe("sessionCommand", () => {
  it("runs the command itself with the given environment when there is no launcher", () => {
    const env = { PATH: "/bin" };

    const command = sessionCommand("claude", ["-p"], NO_LAUNCHER, executorSession, env);

    expect(command).toEqual({ file: "claude", args: ["-p"], env });
    expect(command.env).toBe(env);
  });

  it("keeps an inherited environment inherited when there is no launcher", () => {
    expect(
      sessionCommand("claude", ["-p"], NO_LAUNCHER, executorSession, undefined).env,
    ).toBeUndefined();
  });

  it("prefixes the launcher and tells it the role, pool and ticket", () => {
    const command = sessionCommand(
      "claude",
      ["-p", "--model", "opus"],
      ["/opt/launch", "--wait"],
      { ...executorSession, role: "summarizer" },
      { PATH: "/bin" },
    );

    expect(command).toEqual({
      file: "/opt/launch",
      args: ["--wait", "claude", "-p", "--model", "opus"],
      env: {
        PATH: "/bin",
        KIKIMORA_SESSION_ROLE: "summarizer",
        KIKIMORA_ADMISSION_POOL: "executor",
        KIKIMORA_ADMISSION_TICKET: "ticket-9",
      },
    });
  });

  it("starts from the worker's own environment when the session inherits it", () => {
    const { env } = sessionCommand(
      "claude",
      [],
      ["/opt/launch"],
      executorSession,
      undefined,
    );

    expect(env).toEqual({
      ...process.env,
      KIKIMORA_SESSION_ROLE: "executor",
      KIKIMORA_ADMISSION_POOL: "executor",
      KIKIMORA_ADMISSION_TICKET: "ticket-9",
    });
  });

  it("unsets an inherited ticket when the session holds none", () => {
    const { env } = sessionCommand(
      "claude",
      [],
      ["/opt/launch"],
      { role: "monitor", pool: "monitor", ticket: undefined },
      { KIKIMORA_ADMISSION_TICKET: "stale" },
    );

    expect(env).toEqual({
      KIKIMORA_SESSION_ROLE: "monitor",
      KIKIMORA_ADMISSION_POOL: "monitor",
    });
  });
});

describe("launcherFailureReason", () => {
  const launcher = ["/usr/local/bin/launch"];

  it("reads a refusal from exit code 75 before Claude Code started", () => {
    expect(
      launcherFailureReason(launcher, { code: 75, signal: null, initialized: false }),
    ).toBe("launcherRefused");
  });

  it("leaves exit code 75 alone once Claude Code started", () => {
    expect(
      launcherFailureReason(launcher, { code: 75, signal: null, initialized: true }),
    ).toBeNull();
  });

  it.each([
    [
      "SIGKILL before init",
      { code: null, signal: "SIGKILL" as const, initialized: false },
    ],
    ["SIGKILL after init", { code: null, signal: "SIGKILL" as const, initialized: true }],
    ["exit code 137", { code: 137, signal: null, initialized: true }],
  ])("reads the pool memory limit from %s", (_label, exit) => {
    expect(launcherFailureReason(launcher, exit)).toBe("poolMemoryLimit");
  });

  it.each([
    ["another exit code", { code: 2, signal: null, initialized: true }],
    ["another signal", { code: null, signal: "SIGTERM" as const, initialized: true }],
  ])("has no verdict for %s", (_label, exit) => {
    expect(launcherFailureReason(launcher, exit)).toBeNull();
  });

  it.each([
    { code: 75, signal: null, initialized: false },
    { code: 137, signal: null, initialized: true },
    { code: null, signal: "SIGKILL" as const, initialized: true },
  ])("has no verdict without a launcher (%o)", (exit) => {
    expect(launcherFailureReason(NO_LAUNCHER, exit)).toBeNull();
  });
});
