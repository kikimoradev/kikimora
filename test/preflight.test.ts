import { existsSync } from "node:fs";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createTempDir,
  removeTempDir,
  seedProject,
  seedSystemPrompts,
  snapshotEnv,
} from "./helpers.js";

vi.mock("../src/logger.js", async () =>
  (await import("./helpers.js")).loggerModuleMock(),
);

const sqliteProbe = vi.hoisted(() => ({ error: undefined as Error | undefined }));

vi.mock("node:sqlite", () => ({
  DatabaseSync: class {
    exec(): void {
      if (sqliteProbe.error) throw sqliteProbe.error;
    }
    close = (): undefined => undefined;
  },
}));

const { ensureReady, parseClaudeAuthStatus, parseClaudeVersion } =
  await import("../src/preflight.js");
const { logger } = await import("../src/logger.js");

describe("ensureReady", () => {
  let dir: string;
  let binDir: string;
  let systemPromptsDir: string;
  let restoreEnv: () => void;

  async function stubClaude(body: string): Promise<void> {
    const claude = join(binDir, "claude");
    await writeFile(claude, `#!/bin/sh\n${body}\n`, "utf8");
    await chmod(claude, 0o755);
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    dir = await createTempDir();
    binDir = join(dir, "bin");
    restoreEnv = snapshotEnv();

    await mkdir(binDir, { recursive: true });
    await stubClaude("exit 0");

    await seedProject(dir);
    systemPromptsDir = await seedSystemPrompts(dir);

    process.env.PATH = binDir;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    restoreEnv();
    sqliteProbe.error = undefined;
    await removeTempDir(dir);
  });

  function dirs() {
    return { projectDir: dir, systemPromptsDir };
  }

  it("passes and returns verified prompt paths and the Claude CLI facts", async () => {
    await stubClaude(
      `case "$1" in --version) echo "2.1.268 (Claude Code)";; *) echo '{"loggedIn":true,"authMethod":"claude.ai"}';; esac`,
    );
    await expect(ensureReady(dirs())).resolves.toEqual({
      paths: {
        monitor: {
          promptPath: join(dir, ".kikimora", "prompts", "monitor.prompt.md"),
          systemPromptPath: join(systemPromptsDir, "monitor.system.md"),
        },
        executor: {
          promptPath: join(dir, ".kikimora", "prompts", "executor.prompt.md"),
          systemPromptPath: join(systemPromptsDir, "executor.system.md"),
        },
        summarizer: {
          systemPromptPath: join(systemPromptsDir, "summarizer.system.md"),
        },
        contextPath: join(dir, ".kikimora", "prompts", "context.md"),
      },
      claude: {
        version: "2.1.268",
        auth: { loggedIn: true, authMethod: "claude.ai", apiKeySource: undefined },
      },
    });
    expect(logger.success).toHaveBeenCalledWith("Claude Code 2.1.268 (claude)");
    expect(logger.success).toHaveBeenCalledWith("Claude Code login (claude.ai)");
    expect(logger.error).not.toHaveBeenCalled();
    expect(existsSync(join(dir, ".kikimora", "prompts", "context.md"))).toBe(false);
  });

  it("reports an unknown CLI version and login when claude prints nothing", async () => {
    await expect(ensureReady(dirs())).resolves.toMatchObject({
      claude: { version: null, auth: null },
    });
    expect(logger.success).toHaveBeenCalledWith("Claude Code (claude)");
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it("throws with an install hint when claude is missing from PATH", async () => {
    process.env.PATH = join(dir, "empty");
    await expect(ensureReady(dirs())).rejects.toThrow(/Preflight failed[\s\S]*PATH/);
  });

  it("does not probe the login when claude is missing", async () => {
    process.env.PATH = join(dir, "empty");
    await expect(ensureReady(dirs())).rejects.not.toThrow(/not logged in/);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("passes when claude auth status reports a login and names the method", async () => {
    await stubClaude(
      `echo '{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty"}'`,
    );
    await expect(ensureReady(dirs())).resolves.toBeDefined();
    expect(logger.success).toHaveBeenCalledWith("Claude Code login (claude.ai)");
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("names the API key source when one is in use", async () => {
    await stubClaude(
      `echo '{"loggedIn":true,"authMethod":"oauth_token","apiKeySource":"ANTHROPIC_API_KEY"}'`,
    );
    await expect(ensureReady(dirs())).resolves.toBeDefined();
    expect(logger.success).toHaveBeenCalledWith("Claude Code login (ANTHROPIC_API_KEY)");
  });

  it("throws with a login hint when claude is not logged in", async () => {
    await stubClaude(`echo '{"loggedIn":false,"authMethod":"none"}'; exit 1`);
    await expect(ensureReady(dirs())).rejects.toThrow(
      /Preflight failed[\s\S]*not logged in[\s\S]*claude auth login[\s\S]*ANTHROPIC_API_KEY/,
    );
  });

  it("warns and passes when the CLI does not know auth status", async () => {
    await stubClaude(`echo "error: unknown command 'auth'" >&2; exit 1`);
    await expect(ensureReady(dirs())).resolves.toBeDefined();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("Could not verify"));
  });

  it("warns and passes when auth status prints no JSON", async () => {
    await stubClaude("echo not json");
    await expect(ensureReady(dirs())).resolves.toBeDefined();
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it("warns and passes when auth status hangs past the timeout", async () => {
    await stubClaude("sleep 5");
    await expect(ensureReady(dirs(), { claudeTimeoutMs: 100 })).resolves.toMatchObject({
      claude: { version: null, auth: null },
    });
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it("throws with a configure hint when a prompt file is missing", async () => {
    await removeTempDir(join(dir, ".kikimora", "prompts"));
    await expect(ensureReady(dirs())).rejects.toThrow(/interactive terminal/);
  });

  it("throws with a Node build hint when SQLite lacks FTS5", async () => {
    sqliteProbe.error = new Error("no such module: fts5");
    await expect(ensureReady(dirs())).rejects.toThrow(
      /Preflight failed[\s\S]*FTS5[\s\S]*nodejs\.org/,
    );
  });

  it("throws when the settings file is missing", async () => {
    await removeTempDir(join(dir, ".kikimora", "settings.json"));
    await expect(ensureReady(dirs())).rejects.toThrow(
      /Preflight failed[\s\S]*interactive terminal/,
    );
  });

  it("does not look for playwright-mcp while browser is off", async () => {
    await expect(ensureReady(dirs())).resolves.toBeDefined();
    expect(logger.success).not.toHaveBeenCalledWith(
      expect.stringContaining("playwright-mcp"),
    );
  });

  it("throws with an image hint when browser: true finds no playwright-mcp", async () => {
    await seedProject(dir, { settings: { browser: true } });
    await expect(ensureReady(dirs())).rejects.toThrow(
      /Preflight failed[\s\S]*playwright-mcp[\s\S]*-browser image/,
    );
  });

  it("passes when browser: true finds playwright-mcp on PATH", async () => {
    await seedProject(dir, { settings: { browser: true } });
    const playwright = join(binDir, "playwright-mcp");
    await writeFile(playwright, "#!/bin/sh\nexit 0\n", "utf8");
    await chmod(playwright, 0o755);

    await expect(ensureReady(dirs())).resolves.toBeDefined();
    expect(logger.success).toHaveBeenCalledWith("Playwright MCP (playwright-mcp)");
  });
});

describe("parseClaudeAuthStatus", () => {
  it("parses the JSON document", () => {
    expect(
      parseClaudeAuthStatus(
        '{"loggedIn":true,"authMethod":"claude.ai","apiKeySource":"ANTHROPIC_API_KEY"}\n',
      ),
    ).toEqual({
      loggedIn: true,
      authMethod: "claude.ai",
      apiKeySource: "ANTHROPIC_API_KEY",
    });
  });

  it("skips noise printed before and after the document", () => {
    expect(
      parseClaudeAuthStatus('warning: something\n{"loggedIn":false}\ntrailing'),
    ).toEqual({ loggedIn: false, authMethod: undefined, apiKeySource: undefined });
  });

  it.each(["", "not json", "{broken", '{"authMethod":"none"}', "[1,2]", '"text"'])(
    "returns null for %j",
    (output) => {
      expect(parseClaudeAuthStatus(output)).toBeNull();
    },
  );
});

describe("parseClaudeVersion", () => {
  it.each([
    ["2.1.268 (Claude Code)\n", "2.1.268"],
    ["v1.0.0", "1.0.0"],
    ["Claude Code 2.2.0-beta.1+build.7", "2.2.0-beta.1+build.7"],
    ["warning: something\n2.1.300 (Claude Code)", "2.1.300"],
    ["Using node 22.22.0\n2.1.268 (Claude Code)\n", "2.1.268"],
    ["Claude Code 2.2.0 is available\n2.1.268 (Claude Code)", "2.1.268"],
  ])("extracts the version from %j", (output, expected) => {
    expect(parseClaudeVersion(output)).toBe(expected);
  });

  it.each(["", "Claude Code", "2.1", "error: unknown option '--version'"])(
    "returns null for %j",
    (output) => {
      expect(parseClaudeVersion(output)).toBeNull();
    },
  );
});
