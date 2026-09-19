import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { projectPaths } from "../src/paths.js";
import { createTempDir, removeTempDir, seedProject } from "./helpers.js";

const mocks = vi.hoisted(() => ({
  runConfigure: vi.fn(),
}));

vi.mock("../src/configure.js", () => ({ runConfigure: mocks.runConfigure }));
vi.mock("../src/logger.js", async () =>
  (await import("./helpers.js")).loggerModuleMock(),
);

const { initCommand, runInit } = await import("../src/init-command.js");
const { logger } = await import("../src/logger.js");

describe("runInit", () => {
  let dir: string;
  let monitorSource: string;
  let executorSource: string;
  let savedExitCode: typeof process.exitCode;

  beforeEach(async () => {
    vi.clearAllMocks();
    savedExitCode = process.exitCode;
    dir = await createTempDir();
    monitorSource = join(dir, "monitor-source.md");
    executorSource = join(dir, "executor-source.md");
    await writeFile(monitorSource, "watch GitHub issues\n", "utf8");
    await writeFile(executorSource, "# Role\nBe diligent\n", "utf8");
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    process.exitCode = savedExitCode;
    await removeTempDir(dir);
  });

  it("scaffolds the project from prompt files without a TTY", async () => {
    const paths = projectPaths(dir);

    await runInit({
      monitorPromptPath: monitorSource,
      executorPromptPath: executorSource,
      projectDir: dir,
      interactive: false,
    });

    expect(process.exitCode).toBe(savedExitCode);
    expect(await readFile(paths.settingsFile, "utf8")).toBe("{}\n");
    expect(await readFile(paths.monitorPromptFile, "utf8")).toBe("watch GitHub issues\n");
    expect(await readFile(paths.executorPromptFile, "utf8")).toBe(
      "# Role\nBe diligent\n",
    );
    expect(await readFile(paths.gitignoreFile, "utf8")).toBe("data/\nlogs/\n");
    expect(logger.success).toHaveBeenCalledWith(expect.stringContaining("settings.json"));
  });

  it("keeps an existing settings.json and skips its saved message", async () => {
    await seedProject(dir, { settings: '{"streamPartial": false}\n' });
    const paths = projectPaths(dir);

    await runInit({
      monitorPromptPath: monitorSource,
      executorPromptPath: executorSource,
      projectDir: dir,
      force: true,
      interactive: false,
    });

    expect(await readFile(paths.settingsFile, "utf8")).toBe('{"streamPartial": false}\n');
    expect(logger.success).not.toHaveBeenCalledWith(
      expect.stringContaining("settings.json"),
    );
  });

  it("refuses to overwrite existing prompts without --force", async () => {
    await seedProject(dir, { monitorPrompt: "existing\n" });
    const paths = projectPaths(dir);

    await runInit({
      monitorPromptPath: monitorSource,
      executorPromptPath: executorSource,
      projectDir: dir,
      interactive: false,
    });

    expect(process.exitCode).toBe(1);
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("--force"));
    expect(await readFile(paths.monitorPromptFile, "utf8")).toBe("existing\n");
  });

  it("overwrites existing prompts with --force", async () => {
    await seedProject(dir);
    const paths = projectPaths(dir);

    await runInit({
      monitorPromptPath: monitorSource,
      executorPromptPath: executorSource,
      projectDir: dir,
      force: true,
      interactive: false,
    });

    expect(process.exitCode).toBe(savedExitCode);
    expect(await readFile(paths.monitorPromptFile, "utf8")).toBe("watch GitHub issues\n");
  });

  it("requires both prompt flags together", async () => {
    await runInit({
      monitorPromptPath: monitorSource,
      projectDir: dir,
      interactive: false,
    });

    expect(process.exitCode).toBe(1);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("required together"),
    );
    expect(existsSync(projectPaths(dir).settingsFile)).toBe(false);
  });

  it("fails without flags when there is no TTY", async () => {
    await runInit({ projectDir: dir, interactive: false });

    expect(process.exitCode).toBe(1);
    expect(mocks.runConfigure).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("--monitor-prompt"),
    );
  });

  it("delegates to the wizard without flags in a terminal", async () => {
    mocks.runConfigure.mockResolvedValue(true);

    await runInit({ projectDir: dir, interactive: true });

    expect(process.exitCode).toBe(savedExitCode);
    expect(mocks.runConfigure).toHaveBeenCalledWith(dir);
  });

  it("fails when a prompt file cannot be read", async () => {
    await runInit({
      monitorPromptPath: join(dir, "missing.md"),
      executorPromptPath: executorSource,
      projectDir: dir,
      interactive: false,
    });

    expect(process.exitCode).toBe(1);
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("missing.md"));
    expect(existsSync(projectPaths(dir).settingsFile)).toBe(false);
  });

  it("forwards CLI args from the citty command", async () => {
    vi.spyOn(process, "cwd").mockReturnValue(dir);

    await (initCommand.run as (ctx: unknown) => Promise<void>)({
      args: {
        "monitor-prompt": monitorSource,
        "executor-prompt": executorSource,
        force: false,
        _: [],
      },
    });

    expect(await readFile(projectPaths(dir).settingsFile, "utf8")).toBe("{}\n");
  });

  it("fails when a prompt file is empty", async () => {
    await writeFile(monitorSource, "\n  \n", "utf8");

    await runInit({
      monitorPromptPath: monitorSource,
      executorPromptPath: executorSource,
      projectDir: dir,
      interactive: false,
    });

    expect(process.exitCode).toBe(1);
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("is empty"));
  });

  it("writes the given settings document as it stands, without defaults", async () => {
    const paths = projectPaths(dir);
    const document = {
      executor: { mcpServers: ["sentry"] },
      mcpServers: { sentry: { type: "http", url: "https://sentry.example/mcp" } },
    };
    const settingsSource = join(dir, "settings-source.json");
    await writeFile(settingsSource, JSON.stringify(document), "utf8");

    await runInit({
      monitorPromptPath: monitorSource,
      executorPromptPath: executorSource,
      settingsPath: settingsSource,
      projectDir: dir,
      interactive: false,
    });

    expect(process.exitCode).toBe(savedExitCode);
    expect(await readFile(paths.settingsFile, "utf8")).toBe(
      `${JSON.stringify(document, null, 2)}\n`,
    );
    expect(logger.success).toHaveBeenCalledWith(expect.stringContaining("settings.json"));
  });

  it("fails on a settings file that is not JSON", async () => {
    const settingsSource = join(dir, "settings-source.json");
    await writeFile(settingsSource, '{"browser": tru', "utf8");

    await runInit({
      monitorPromptPath: monitorSource,
      executorPromptPath: executorSource,
      settingsPath: settingsSource,
      projectDir: dir,
      interactive: false,
    });

    expect(process.exitCode).toBe(1);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining(`Invalid JSON in ${settingsSource}`),
    );
    expect(existsSync(projectPaths(dir).settingsFile)).toBe(false);
  });

  it("leaves every file untouched when the settings document is rejected", async () => {
    await seedProject(dir, { settings: '{"streamPartial": false}\n' });
    const paths = projectPaths(dir);
    const settingsSource = join(dir, "settings-source.json");
    await writeFile(
      settingsSource,
      JSON.stringify({ executor: { mcpServers: ["sentry"] } }),
      "utf8",
    );

    await runInit({
      monitorPromptPath: monitorSource,
      executorPromptPath: executorSource,
      settingsPath: settingsSource,
      projectDir: dir,
      force: true,
      interactive: false,
    });

    expect(process.exitCode).toBe(1);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("Invalid configuration (.kikimora/settings.json):"),
    );
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('executor.mcpServers.0: unknown MCP server "sentry"'),
    );
    expect(await readFile(paths.settingsFile, "utf8")).toBe('{"streamPartial": false}\n');
    expect(await readFile(paths.monitorPromptFile, "utf8")).toBe("observe\n");
  });

  it("writes the context file and accepts an empty one", async () => {
    const paths = projectPaths(dir);
    const contextSource = join(dir, "context-source.md");
    await writeFile(contextSource, "# Workspace\nTwo repositories\n\n", "utf8");

    await runInit({
      monitorPromptPath: monitorSource,
      executorPromptPath: executorSource,
      contextPath: contextSource,
      projectDir: dir,
      interactive: false,
    });

    expect(process.exitCode).toBe(savedExitCode);
    expect(await readFile(paths.contextFile, "utf8")).toBe(
      "# Workspace\nTwo repositories\n",
    );
    expect(logger.success).toHaveBeenCalledWith(expect.stringContaining("context.md"));

    await writeFile(contextSource, "\n  \n", "utf8");
    await runInit({
      monitorPromptPath: monitorSource,
      executorPromptPath: executorSource,
      contextPath: contextSource,
      projectDir: dir,
      force: true,
      interactive: false,
    });

    expect(process.exitCode).toBe(savedExitCode);
    expect(await readFile(paths.contextFile, "utf8")).toBe("");
  });

  it("refuses to overwrite the settings and context files without --force", async () => {
    await seedProject(dir, { settings: '{"streamPartial": false}\n', context: "old\n" });
    const paths = projectPaths(dir);
    const settingsSource = join(dir, "settings-source.json");
    const contextSource = join(dir, "context-source.md");
    await writeFile(settingsSource, "{}", "utf8");
    await writeFile(contextSource, "new\n", "utf8");

    await runInit({
      settingsPath: settingsSource,
      contextPath: contextSource,
      projectDir: dir,
      interactive: false,
    });

    expect(process.exitCode).toBe(1);
    const [message] = vi.mocked(logger.error).mock.calls[0] as [string];
    expect(message).toContain(paths.settingsFile);
    expect(message).toContain(paths.contextFile);
    expect(message).not.toContain(paths.monitorPromptFile);
    expect(await readFile(paths.settingsFile, "utf8")).toBe('{"streamPartial": false}\n');
    expect(await readFile(paths.contextFile, "utf8")).toBe("old\n");
  });

  it("overwrites the settings and context files with --force", async () => {
    await seedProject(dir, { settings: '{"streamPartial": false}\n', context: "old\n" });
    const paths = projectPaths(dir);
    const settingsSource = join(dir, "settings-source.json");
    const contextSource = join(dir, "context-source.md");
    await writeFile(settingsSource, '{"browser": true}', "utf8");
    await writeFile(contextSource, "new\n", "utf8");

    await runInit({
      monitorPromptPath: monitorSource,
      executorPromptPath: executorSource,
      settingsPath: settingsSource,
      contextPath: contextSource,
      projectDir: dir,
      force: true,
      interactive: false,
    });

    expect(process.exitCode).toBe(savedExitCode);
    expect(await readFile(paths.settingsFile, "utf8")).toBe('{\n  "browser": true\n}\n');
    expect(await readFile(paths.contextFile, "utf8")).toBe("new\n");
    expect(await readFile(paths.monitorPromptFile, "utf8")).toBe("watch GitHub issues\n");
  });

  it("updates settings and context without touching the prompts", async () => {
    const paths = projectPaths(dir);
    const settingsSource = join(dir, "settings-source.json");
    const contextSource = join(dir, "context-source.md");
    await writeFile(settingsSource, '{"browser": true}', "utf8");
    await writeFile(contextSource, "one repository\n", "utf8");

    await runInit({
      settingsPath: settingsSource,
      contextPath: contextSource,
      projectDir: dir,
      interactive: false,
    });

    expect(process.exitCode).toBe(savedExitCode);
    expect(await readFile(paths.settingsFile, "utf8")).toBe('{\n  "browser": true\n}\n');
    expect(await readFile(paths.contextFile, "utf8")).toBe("one repository\n");
    expect(existsSync(paths.monitorPromptFile)).toBe(false);
    expect(existsSync(paths.executorPromptFile)).toBe(false);
    expect(mocks.runConfigure).not.toHaveBeenCalled();
  });

  it("forwards the settings and context args from the citty command", async () => {
    vi.spyOn(process, "cwd").mockReturnValue(dir);
    const settingsSource = join(dir, "settings-source.json");
    const contextSource = join(dir, "context-source.md");
    await writeFile(settingsSource, '{"browser": true}', "utf8");
    await writeFile(contextSource, "one repository\n", "utf8");

    await (initCommand.run as (ctx: unknown) => Promise<void>)({
      args: {
        settings: settingsSource,
        context: contextSource,
        force: false,
        _: [],
      },
    });

    const paths = projectPaths(dir);
    expect(await readFile(paths.settingsFile, "utf8")).toBe('{\n  "browser": true\n}\n');
    expect(await readFile(paths.contextFile, "utf8")).toBe("one repository\n");
  });

  it("fails when the context file cannot be read", async () => {
    await runInit({
      contextPath: join(dir, "missing-context.md"),
      projectDir: dir,
      interactive: false,
    });

    expect(process.exitCode).toBe(1);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("Cannot read context file"),
    );
    expect(existsSync(projectPaths(dir).contextFile)).toBe(false);
  });
});
