import { describe, expect, it } from "vitest";
import type { AuthKind } from "../src/control-protocol.js";
import type { ClaudeAuthStatus } from "../src/preflight.js";
import { buildWorkerIdentity, resolveAuthKind } from "../src/worker-identity.js";
import { snapshotEnv } from "./helpers.js";

function loggedIn(overrides: Partial<ClaudeAuthStatus> = {}): ClaudeAuthStatus {
  return { loggedIn: true, authMethod: "claude.ai", ...overrides };
}

describe("resolveAuthKind", () => {
  it("prefers the API key variable over the OAuth token and the CLI report, matching Claude Code's precedence", () => {
    expect(
      resolveAuthKind(loggedIn({ authMethod: "oauth_token" }), {
        CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-x",
        ANTHROPIC_API_KEY: "sk-ant-api03-x",
      }),
    ).toBe("apiKey");
  });

  it("reports the OAuth token variable before the CLI report", () => {
    expect(
      resolveAuthKind(loggedIn(), { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-x" }),
    ).toBe("oauth");
  });

  it("treats blank variables as unset", () => {
    expect(
      resolveAuthKind(loggedIn(), {
        CLAUDE_CODE_OAUTH_TOKEN: "  ",
        ANTHROPIC_API_KEY: "",
      }),
    ).toBe("claude.ai");
  });

  const reported: [ClaudeAuthStatus | null, AuthKind][] = [
    [loggedIn({ authMethod: "claude.ai" }), "claude.ai"],
    [loggedIn({ authMethod: "oauth_token" }), "oauth"],
    [loggedIn({ authMethod: "claude.ai", apiKeySource: "apiKeyHelper" }), "apiKey"],
    [loggedIn({ authMethod: "api_key" }), "apiKey"],
    [loggedIn({ authMethod: "console" }), "unknown"],
    [{ loggedIn: false, authMethod: "none" }, "unknown"],
    [{ loggedIn: true }, "unknown"],
    [null, "unknown"],
  ];

  it.each(reported)(
    "maps the CLI report %j to %s without credential variables",
    (status, expected) => {
      expect(resolveAuthKind(status, {})).toBe(expected);
    },
  );

  it("reads process.env when no environment is given", () => {
    const restoreEnv = snapshotEnv();
    try {
      delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
      process.env.ANTHROPIC_API_KEY = "sk-ant-api03-x";
      expect(resolveAuthKind(null)).toBe("apiKey");
    } finally {
      restoreEnv();
    }
  });
});

describe("buildWorkerIdentity", () => {
  const input = {
    version: "1.2.3",
    claude: { version: "2.1.268", auth: loggedIn() },
    nodeVersion: "22.16.0",
    pid: 4242,
    startedAt: Date.parse("2026-07-08T08:00:00.000Z"),
    projectDir: "/srv/project",
    env: {},
  };

  it("maps the versions, the process facts and the auth kind", () => {
    expect(buildWorkerIdentity(input)).toEqual({
      version: "1.2.3",
      claudeVersion: "2.1.268",
      nodeVersion: "22.16.0",
      pid: 4242,
      startedAt: "2026-07-08T08:00:00.000Z",
      projectDir: "/srv/project",
      authKind: "claude.ai",
    });
  });

  it("omits claudeVersion when the CLI version is unknown", () => {
    const identity = buildWorkerIdentity({
      ...input,
      claude: { version: null, auth: null },
    });

    expect(identity).not.toHaveProperty("claudeVersion");
    expect(JSON.parse(JSON.stringify(identity))).not.toHaveProperty("claudeVersion");
    expect(identity.authKind).toBe("unknown");
  });

  it("resolves the auth kind from the given environment", () => {
    expect(
      buildWorkerIdentity({ ...input, env: { CLAUDE_CODE_OAUTH_TOKEN: "x" } }).authKind,
    ).toBe("oauth");
  });
});
