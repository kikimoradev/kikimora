import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { projectPaths } from "../src/paths.js";
import { writeProjectScaffold } from "../src/scaffold.js";
import { createTempDir, removeTempDir, seedProject } from "./helpers.js";

describe("writeProjectScaffold", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await createTempDir();
  });

  afterEach(async () => {
    await removeTempDir(dir);
  });

  it("creates settings, both prompts, and the gitignore in an empty project", async () => {
    const paths = projectPaths(dir);

    const result = await writeProjectScaffold(paths, {
      monitorPrompt: "watch issues",
      executorPrompt: "fix bugs",
    });

    expect(result.wroteSettings).toBe(true);
    expect(await readFile(paths.settingsFile, "utf8")).toBe("{}\n");
    expect(await readFile(paths.monitorPromptFile, "utf8")).toBe("watch issues\n");
    expect(await readFile(paths.executorPromptFile, "utf8")).toBe("fix bugs\n");
    expect(await readFile(paths.gitignoreFile, "utf8")).toBe("data/\nlogs/\n");
  });

  it("never touches an existing settings.json or .gitignore", async () => {
    const paths = projectPaths(dir);
    await seedProject(dir, { settings: '{"streamPartial": false}\n' });
    await writeFile(paths.gitignoreFile, "custom\n", "utf8");

    const result = await writeProjectScaffold(paths, {
      monitorPrompt: "watch",
      executorPrompt: "execute",
    });

    expect(result.wroteSettings).toBe(false);
    expect(await readFile(paths.settingsFile, "utf8")).toBe('{"streamPartial": false}\n');
    expect(await readFile(paths.gitignoreFile, "utf8")).toBe("custom\n");
  });

  it("overwrites existing prompt files", async () => {
    const paths = projectPaths(dir);
    await seedProject(dir, {
      monitorPrompt: "old monitor\n",
      executorPrompt: "old executor\n",
    });

    await writeProjectScaffold(paths, {
      monitorPrompt: "new monitor",
      executorPrompt: "new executor",
    });

    expect(await readFile(paths.monitorPromptFile, "utf8")).toBe("new monitor\n");
    expect(await readFile(paths.executorPromptFile, "utf8")).toBe("new executor\n");
  });

  it("works when only .kikimora exists without the prompts directory", async () => {
    const paths = projectPaths(join(dir, "fresh"));

    await writeProjectScaffold(paths, {
      monitorPrompt: "watch",
      executorPrompt: "execute",
    });

    expect(await readFile(paths.monitorPromptFile, "utf8")).toBe("watch\n");
  });

  it("writes the given settings document over an existing settings file", async () => {
    const paths = projectPaths(dir);
    await seedProject(dir, { settings: '{"streamPartial": false}\n' });

    const result = await writeProjectScaffold(
      paths,
      { monitorPrompt: "watch", executorPrompt: "execute" },
      { settings: { executor: { model: "fable" } } },
    );

    expect(result.wroteSettings).toBe(true);
    expect(await readFile(paths.settingsFile, "utf8")).toBe(
      '{\n  "executor": {\n    "model": "fable"\n  }\n}\n',
    );
  });

  it("writes the context file, empty content included", async () => {
    const paths = projectPaths(dir);

    await writeProjectScaffold(
      paths,
      { monitorPrompt: "watch", executorPrompt: "execute" },
      { context: "two repositories\n\n" },
    );
    expect(await readFile(paths.contextFile, "utf8")).toBe("two repositories\n");

    await writeProjectScaffold(
      paths,
      { monitorPrompt: "watch", executorPrompt: "execute" },
      { context: "" },
    );
    expect(await readFile(paths.contextFile, "utf8")).toBe("");
  });

  it("writes only the extras when there are no prompts", async () => {
    const paths = projectPaths(dir);

    await writeProjectScaffold(paths, null, {
      settings: { browser: true },
      context: "one repository",
    });

    expect(await readFile(paths.settingsFile, "utf8")).toBe('{\n  "browser": true\n}\n');
    expect(await readFile(paths.contextFile, "utf8")).toBe("one repository\n");
    expect(existsSync(paths.monitorPromptFile)).toBe(false);
    expect(existsSync(paths.executorPromptFile)).toBe(false);
  });
});
