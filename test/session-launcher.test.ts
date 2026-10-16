import { describe, expect, it } from "vitest";
import {
  invalidLauncherMessage,
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
