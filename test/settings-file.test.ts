import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  patchSettings,
  readRawSettings,
  settingsSection,
  isPlainObject,
  mergeSettingsPatch,
} from "../src/settings-file.js";
import { createTempDir, removeTempDir } from "./helpers.js";

describe("readRawSettings", () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await createTempDir();
    file = join(dir, "settings.json");
  });

  afterEach(async () => {
    await removeTempDir(dir);
  });

  it("throws a configure hint when the file is missing", async () => {
    await expect(readRawSettings(file)).rejects.toThrow(/interactive terminal/);
  });

  it("throws a readable error on invalid JSON", async () => {
    await writeFile(file, "{", "utf8");
    await expect(readRawSettings(file)).rejects.toThrow(/Invalid JSON in/);
  });

  it("rejects non-object roots", async () => {
    await writeFile(file, "[1, 2]", "utf8");
    await expect(readRawSettings(file)).rejects.toThrow(/expected a JSON object/);
  });

  it("returns the parsed object", async () => {
    await writeFile(file, '{"monitor":{"model":"sonnet"}}', "utf8");
    await expect(readRawSettings(file)).resolves.toEqual({
      monitor: { model: "sonnet" },
    });
  });
});

describe("settingsSection", () => {
  it("returns an existing object section", () => {
    const monitor = { model: "sonnet" };
    const raw: Record<string, unknown> = { monitor };
    expect(settingsSection(raw, "monitor")).toBe(monitor);
  });

  it("creates a missing section and replaces non-object values", () => {
    const raw: Record<string, unknown> = { executor: "oops" };
    const monitor = settingsSection(raw, "monitor");
    const executor = settingsSection(raw, "executor");
    expect(raw.monitor).toBe(monitor);
    expect(raw.executor).toBe(executor);
    expect(executor).toEqual({});
  });
});

describe("mergeSettingsPatch", () => {
  it("assigns scalars, recurses into objects and deletes on null", () => {
    const raw: Record<string, unknown> = {
      monitor: { model: "haiku", activeHours: "09:00-17:00", intervalMinutes: 15 },
      streamPartial: true,
    };
    mergeSettingsPatch(raw, {
      monitor: { model: "opus", activeHours: null },
      executor: { maxTaskAttempts: 5 },
      streamPartial: null,
    });
    expect(raw).toEqual({
      monitor: { model: "opus", intervalMinutes: 15 },
      executor: { maxTaskAttempts: 5 },
    });
  });

  it("replaces a non-object section and assigns arrays as values", () => {
    const raw: Record<string, unknown> = { monitor: "oops" };
    mergeSettingsPatch(raw, { monitor: { tags: ["a", "b"] } });
    expect(raw).toEqual({ monitor: { tags: ["a", "b"] } });
  });

  it("an empty patch changes nothing", () => {
    const raw: Record<string, unknown> = { streamPartial: false };
    mergeSettingsPatch(raw, {});
    expect(raw).toEqual({ streamPartial: false });
  });
});

describe("isPlainObject", () => {
  it("accepts objects and rejects arrays, null and scalars", () => {
    expect(isPlainObject({})).toBe(true);
    expect(isPlainObject([])).toBe(false);
    expect(isPlainObject(null)).toBe(false);
    expect(isPlainObject("x")).toBe(false);
  });
});

describe("patchSettings", () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await createTempDir();
    file = join(dir, "settings.json");
  });

  afterEach(async () => {
    await removeTempDir(dir);
  });

  it("patches only the mutated keys and keeps the file sparse", async () => {
    await writeFile(file, '{\n  "streamPartial": false\n}\n', "utf8");
    const settings = await patchSettings(file, (raw) => {
      settingsSection(raw, "monitor").model = "opus";
    });
    expect(settings.monitor.model).toBe("opus");
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
      streamPartial: false,
      monitor: { model: "opus" },
    });
    expect(await readFile(file, "utf8")).toMatch(/\n$/);
  });

  it("rejects an invalid patch before writing anything", async () => {
    const original = '{\n  "monitor": {\n    "model": "haiku"\n  }\n}\n';
    await writeFile(file, original, "utf8");
    await expect(
      patchSettings(file, (raw) => {
        settingsSection(raw, "monitor").activeHours = "not-a-window";
      }),
    ).rejects.toThrow(/monitor\.activeHours/);
    expect(await readFile(file, "utf8")).toBe(original);
  });

  it("rejects unknown keys via the strict schema", async () => {
    await writeFile(file, "{}\n", "utf8");
    await expect(
      patchSettings(file, (raw) => {
        raw.montior = {};
      }),
    ).rejects.toThrow(/montior/);
  });

  it("accepts an MCP catalogue, per-agent lists and the browser switch", async () => {
    await writeFile(file, "{}\n", "utf8");
    const settings = await patchSettings(file, (raw) => {
      mergeSettingsPatch(raw, {
        browser: true,
        mcpServers: { linter: { command: "run-linter" } },
        executor: { mcpServers: ["linter"] },
      });
    });

    expect(settings.browser).toBe(true);
    expect(settings.executor.mcpServers).toEqual(["linter"]);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
      browser: true,
      mcpServers: { linter: { command: "run-linter" } },
      executor: { mcpServers: ["linter"] },
    });
  });

  it("replaces an agent list wholesale and deletes a server with null", async () => {
    await writeFile(
      file,
      JSON.stringify({
        mcpServers: { linter: { command: "run-linter" }, docs: { command: "run-docs" } },
        executor: { mcpServers: ["linter", "docs"] },
      }),
      "utf8",
    );
    const settings = await patchSettings(file, (raw) => {
      mergeSettingsPatch(raw, {
        mcpServers: { docs: null },
        executor: { mcpServers: ["linter"] },
      });
    });

    expect(Object.keys(settings.mcpServers)).toEqual(["linter"]);
    expect(settings.executor.mcpServers).toEqual(["linter"]);
  });

  it("rejects a reserved server name before writing anything", async () => {
    const original = "{}\n";
    await writeFile(file, original, "utf8");
    await expect(
      patchSettings(file, (raw) => {
        mergeSettingsPatch(raw, { mcpServers: { playwright: { command: "x" } } });
      }),
    ).rejects.toThrow(/mcpServers\.playwright: "playwright" is reserved/);
    expect(await readFile(file, "utf8")).toBe(original);
  });

  it("rejects an unknown server name in an agent list, naming the index", async () => {
    await writeFile(file, "{}\n", "utf8");
    await expect(
      patchSettings(file, (raw) => {
        mergeSettingsPatch(raw, { executor: { mcpServers: ["missing"] } });
      }),
    ).rejects.toThrow(/executor\.mcpServers\.0: unknown MCP server "missing"/);
  });

  it("accepts a shutdown grace and rejects a negative one before writing anything", async () => {
    await writeFile(file, "{}\n", "utf8");
    const settings = await patchSettings(file, (raw) => {
      mergeSettingsPatch(raw, { shutdownGraceMs: 120_000 });
    });
    expect(settings.shutdownGraceMs).toBe(120_000);
    const written = await readFile(file, "utf8");
    expect(JSON.parse(written)).toEqual({ shutdownGraceMs: 120_000 });

    await expect(
      patchSettings(file, (raw) => {
        mergeSettingsPatch(raw, { shutdownGraceMs: -1 });
      }),
    ).rejects.toThrow(/shutdownGraceMs/);
    expect(await readFile(file, "utf8")).toBe(written);
  });

  it("leaves no temporary file behind", async () => {
    await writeFile(file, "{}\n", "utf8");
    await patchSettings(file, (raw) => {
      settingsSection(raw, "executor").model = "sonnet";
    });
    expect(await readdir(dir)).toEqual(["settings.json"]);
  });
});
