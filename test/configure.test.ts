import { existsSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTempDir, fakeStdio, removeTempDir, seedProject } from "./helpers.js";
import type { FakeStdio } from "./helpers.js";

vi.mock("../src/logger.js", async () =>
  (await import("./helpers.js")).loggerModuleMock(),
);

const { isConfigured, runConfigure } = await import("../src/configure.js");

const CTRL_D = "\u0004";
const ESCAPE = "\u001B";

async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 50));
}

async function press(io: FakeStdio, data: string): Promise<void> {
  await io.inputReady();
  io.type(data);
  await tick();
}

async function expectFrame(io: FakeStdio, text: string): Promise<void> {
  await vi.waitFor(() => {
    expect(io.lastFrame()).toContain(text);
  }, 5_000);
}

describe("runConfigure", () => {
  let dir: string;
  let io: FakeStdio;
  let settingsPath: string;
  let gitignorePath: string;
  let monitorPromptPath: string;
  let executorPromptPath: string;

  beforeEach(async () => {
    dir = await createTempDir();
    io = fakeStdio();
    settingsPath = join(dir, ".kikimora", "settings.json");
    gitignorePath = join(dir, ".kikimora", ".gitignore");
    monitorPromptPath = join(dir, ".kikimora", "prompts", "monitor.prompt.md");
    executorPromptPath = join(dir, ".kikimora", "prompts", "executor.prompt.md");
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await removeTempDir(dir);
  });

  it("writes default settings, both prompts, and the gitignore", async () => {
    const done = runConfigure(dir, io);

    await expectFrame(io, "What should the monitor watch?");
    await press(io, "watch GitHub issues");
    await press(io, CTRL_D);

    await expectFrame(io, "Who is the executor");
    await press(io, "# Role\rBe diligent\r\n- rule one");
    await press(io, CTRL_D);

    await expect(done).resolves.toBe(true);
    expect(await readFile(settingsPath, "utf8")).toBe("{}\n");
    expect(await readFile(monitorPromptPath, "utf8")).toBe("watch GitHub issues\n");
    expect(await readFile(executorPromptPath, "utf8")).toBe(
      "# Role\nBe diligent\n- rule one\n",
    );
    expect(await readFile(gitignorePath, "utf8")).toBe("data/\nlogs/\n");
  });

  it("never touches an existing settings.json or .gitignore", async () => {
    await seedProject(dir, { settings: '{"streamPartial": false}\n' });
    await writeFile(gitignorePath, "custom\n", "utf8");

    const done = runConfigure(dir, io);
    await expectFrame(io, "What should the monitor watch?");
    await press(io, CTRL_D);
    await expectFrame(io, "Who is the executor");
    await press(io, CTRL_D);

    await expect(done).resolves.toBe(true);
    expect(await readFile(settingsPath, "utf8")).toBe('{"streamPartial": false}\n');
    expect(await readFile(gitignorePath, "utf8")).toBe("custom\n");
  });

  it("pre-fills the editors with existing prompt content", async () => {
    await seedProject(dir, {
      settings: false,
      monitorPrompt: "existing monitor prompt\n",
      executorPrompt: "existing executor prompt\n",
    });

    const done = runConfigure(dir, io);

    await expectFrame(io, "existing monitor prompt");
    await press(io, CTRL_D);
    await expectFrame(io, "existing executor prompt");
    await press(io, CTRL_D);

    await expect(done).resolves.toBe(true);
    expect(await readFile(monitorPromptPath, "utf8")).toBe("existing monitor prompt\n");
    expect(await readFile(executorPromptPath, "utf8")).toBe("existing executor prompt\n");
  });

  it("cancelling the first step writes no files", async () => {
    const done = runConfigure(dir, io);
    await expectFrame(io, "What should the monitor watch?");
    await press(io, "half-typed");
    await press(io, ESCAPE);
    await tick();

    await expect(done).resolves.toBe(false);
    expect(existsSync(settingsPath)).toBe(false);
    expect(existsSync(monitorPromptPath)).toBe(false);
    expect(existsSync(executorPromptPath)).toBe(false);
  });

  it("cancelling the second step writes no files", async () => {
    const done = runConfigure(dir, io);
    await expectFrame(io, "What should the monitor watch?");
    await press(io, "watch things");
    await press(io, CTRL_D);
    await expectFrame(io, "Who is the executor");
    await press(io, ESCAPE);
    await tick();

    await expect(done).resolves.toBe(false);
    expect(existsSync(settingsPath)).toBe(false);
    expect(existsSync(monitorPromptPath)).toBe(false);
  });

  it("does not submit an empty editor", async () => {
    const done = runConfigure(dir, io);
    await expectFrame(io, "What should the monitor watch?");
    await press(io, CTRL_D);

    await expectFrame(io, "enter at least one line");
    expect(io.lastFrame()).toContain("What should the monitor watch?");

    await press(io, ESCAPE);
    await tick();
    await expect(done).resolves.toBe(false);
  });

  it("defaults to process.cwd() when no project directory is given", async () => {
    vi.spyOn(process, "cwd").mockReturnValue(dir);

    const done = runConfigure(undefined, io);
    await expectFrame(io, "What should the monitor watch?");
    await press(io, "watch");
    await press(io, CTRL_D);
    await expectFrame(io, "Who is the executor");
    await press(io, "execute");
    await press(io, CTRL_D);

    await expect(done).resolves.toBe(true);
    expect(existsSync(settingsPath)).toBe(true);
  });
});

describe("isConfigured", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await createTempDir();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await removeTempDir(dir);
  });

  it("returns true when settings.json and both prompt files exist", async () => {
    await seedProject(dir);
    expect(isConfigured(dir)).toBe(true);
  });

  it("does not count the optional context file", async () => {
    await seedProject(dir);
    expect(isConfigured(dir)).toBe(true);
    await seedProject(dir, { context: "# Workspace context\n" });
    expect(isConfigured(dir)).toBe(true);
  });

  it("returns false when settings.json is missing", async () => {
    await seedProject(dir, { settings: false });
    expect(isConfigured(dir)).toBe(false);
  });

  it("returns false when a prompt file is missing", async () => {
    await seedProject(dir);
    await rm(join(dir, ".kikimora", "prompts", "executor.prompt.md"));
    expect(isConfigured(dir)).toBe(false);
  });

  it("defaults to process.cwd() when no project directory is given", async () => {
    vi.spyOn(process, "cwd").mockReturnValue(dir);
    expect(isConfigured()).toBe(false);
    await seedProject(dir);
    expect(isConfigured()).toBe(true);
  });
});
