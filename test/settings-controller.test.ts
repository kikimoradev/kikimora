import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseSettings } from "../src/config.js";
import {
  applySettings,
  createSettingsController,
  parseConfigAgent,
  supportsEffort,
  type SettingsController,
} from "../src/settings-controller.js";
import type { WorkerConfig } from "../src/types.js";
import { buildConfig, createTempDir, removeTempDir } from "./helpers.js";

describe("parseConfigAgent", () => {
  it("accepts the three configurable agents", () => {
    expect(parseConfigAgent("monitor")).toBe("monitor");
    expect(parseConfigAgent("executor")).toBe("executor");
    expect(parseConfigAgent("summarizer")).toBe("summarizer");
  });

  it("rejects unknown agents with the allowed list", () => {
    expect(() => parseConfigAgent("worker")).toThrow(
      'unknown agent "worker" — use monitor, executor, summarizer',
    );
  });
});

describe("supportsEffort", () => {
  it("declines only models without an effort level", () => {
    expect(supportsEffort("haiku")).toBe(false);
    expect(supportsEffort("sonnet")).toBe(true);
    expect(supportsEffort("opus")).toBe(true);
    expect(supportsEffort("fable")).toBe(true);
  });
});

describe("applySettings", () => {
  it("mutates the config sub-objects in place", () => {
    const config = buildConfig();
    const monitor = config.monitor;
    const executor = config.executor;
    const summarizer = config.summarizer;
    applySettings(
      config,
      parseSettings({
        monitor: {
          model: "sonnet",
          effort: "low",
          intervalMinutes: 2,
          activeHours: "08:00-18:00",
        },
        executor: { model: "haiku", maxTaskAttempts: 5, retryDelayMs: 1000 },
        summarizer: { model: "opus", effort: "max" },
        streamPartial: false,
      }),
    );
    expect(config.monitor).toBe(monitor);
    expect(config.executor).toBe(executor);
    expect(config.summarizer).toBe(summarizer);
    expect(monitor).toMatchObject({
      model: "sonnet",
      effort: "low",
      intervalMs: 120_000,
      schedule: { startMinute: 480, endMinute: 1080 },
    });
    expect(executor).toMatchObject({
      model: "haiku",
      maxTaskAttempts: 5,
      retryDelayMs: 1000,
    });
    expect(summarizer).toMatchObject({ model: "opus", effort: "max" });
    expect(config.streamPartial).toBe(false);
  });

  it("applies the MCP catalogue, the per-agent lists and the browser switch", () => {
    const config = buildConfig();
    const monitor = config.monitor;
    const executor = config.executor;
    applySettings(
      config,
      parseSettings({
        browser: true,
        mcpServers: { linter: { command: "run-linter" } },
        monitor: { mcpServers: ["linter"] },
        executor: { mcpServers: ["linter"] },
      }),
    );
    expect(config.browser).toBe(true);
    expect(config.mcpServers).toEqual({
      linter: { command: "run-linter", args: [], env: {} },
    });
    expect(monitor.mcpServers).toEqual(["linter"]);
    expect(executor.mcpServers).toEqual(["linter"]);
  });

  it("applies the shutdown grace so the next signal uses it, and resets it to 0", () => {
    const config = buildConfig();

    applySettings(config, parseSettings({ shutdownGraceMs: 120_000 }));
    expect(config.shutdownGraceMs).toBe(120_000);

    applySettings(config, parseSettings({}));
    expect(config.shutdownGraceMs).toBe(0);
  });

  it("preserves prompt paths and resets the mcp wiring to its defaults", () => {
    const config = buildConfig({ browser: true });
    config.executor = { ...config.executor, mcpServers: ["linter"] };
    applySettings(config, parseSettings({}));
    expect(config.browser).toBe(false);
    expect(config.mcpServers).toEqual({});
    expect(config.executor.mcpServers).toEqual([]);
    expect(config.monitor.promptPath).toBe("/dev/null");
    expect(config.monitor.systemPromptPath).toBe("/dev/null");
  });
});

describe("createSettingsController", () => {
  let dir: string;
  let settingsFile: string;
  let config: WorkerConfig;
  let controller: SettingsController;

  beforeEach(async () => {
    dir = await createTempDir();
    settingsFile = join(dir, "settings.json");
    await writeFile(settingsFile, "{}\n", "utf8");
    config = buildConfig({ settingsFilePath: settingsFile });
    controller = createSettingsController({ config, settingsFile });
  });

  afterEach(async () => {
    await removeTempDir(dir);
  });

  async function persisted(): Promise<Record<string, unknown>> {
    return JSON.parse(await readFile(settingsFile, "utf8")) as Record<string, unknown>;
  }

  it("current returns the effective settings with defaults filled in", async () => {
    await writeFile(settingsFile, '{"monitor":{"model":"opus"}}\n', "utf8");
    const settings = await controller.current();
    expect(settings.monitor.model).toBe("opus");
    expect(settings.monitor.intervalMinutes).toBe(15);
    expect(settings.executor.model).toBe("opus");
    expect(settings.streamPartial).toBe(true);
  });

  it("patch merges nested keys, applies them live and returns the result", async () => {
    const monitor = config.monitor;
    const settings = await controller.patch({
      monitor: { intervalMinutes: 5, activeHours: "09:00-17:00" },
      executor: { maxTaskAttempts: 7 },
      streamPartial: false,
    });
    expect(config.monitor).toBe(monitor);
    expect(monitor.intervalMs).toBe(300_000);
    expect(monitor.schedule).not.toBeNull();
    expect(config.executor.maxTaskAttempts).toBe(7);
    expect(config.streamPartial).toBe(false);
    expect(settings.executor.maxTaskAttempts).toBe(7);
    expect(await persisted()).toEqual({
      monitor: { intervalMinutes: 5, activeHours: "09:00-17:00" },
      executor: { maxTaskAttempts: 7 },
      streamPartial: false,
    });
  });

  it("patch deletes a key on null and falls back to the schema default", async () => {
    await controller.patch({ monitor: { model: "opus", activeHours: "09:00-17:00" } });
    await controller.patch({ monitor: { model: null, activeHours: null } });
    expect(config.monitor.model).toBe("haiku");
    expect(config.monitor.schedule).toBeNull();
    expect(await persisted()).toEqual({ monitor: {} });
  });

  it("patch rejects invalid values with the named path and leaves the file untouched", async () => {
    await writeFile(
      settingsFile,
      '{\n  "monitor": {\n    "model": "haiku"\n  }\n}\n',
      "utf8",
    );
    const before = await readFile(settingsFile, "utf8");
    await expect(controller.patch({ monitor: { intervalMinutes: -1 } })).rejects.toThrow(
      /monitor\.intervalMinutes/,
    );
    await expect(controller.patch({ montior: {} })).rejects.toThrow(/montior/);
    expect(await readFile(settingsFile, "utf8")).toBe(before);
    expect(config.monitor.intervalMs).toBe(300_000);
  });

  it("setModel persists and applies to the live config", async () => {
    const monitor = config.monitor;
    await controller.setModel("monitor", "opus");
    expect(config.monitor).toBe(monitor);
    expect(monitor.model).toBe("opus");
    expect(await persisted()).toEqual({ monitor: { model: "opus" } });
  });

  it("setModel resets the other leaves to schema defaults", async () => {
    config.executor.model = "sonnet";
    await controller.setModel("summarizer", "haiku");
    expect(config.summarizer.model).toBe("haiku");
    expect(config.executor.model).toBe("opus");
  });

  it("setModel rejects unknown models without touching anything", async () => {
    await expect(controller.setModel("monitor", "gpt")).rejects.toThrow(
      'unknown model "gpt" — use haiku, sonnet, opus, fable',
    );
    expect(config.monitor.model).toBe("haiku");
    expect(await persisted()).toEqual({});
  });

  it("setModel accepts fable and keeps its effort levels available", async () => {
    await controller.setModel("executor", "fable");
    expect(config.executor.model).toBe("fable");
    await controller.setEffort("executor", "max");
    expect(config.executor.effort).toBe("max");
    expect(await persisted()).toEqual({ executor: { model: "fable", effort: "max" } });
  });

  it("setEffort persists and applies", async () => {
    await controller.setEffort("executor", "max");
    expect(config.executor.effort).toBe("max");
    expect(await persisted()).toEqual({ executor: { effort: "max" } });
  });

  it("setEffort rejects unknown levels", async () => {
    await expect(controller.setEffort("executor", "ultra")).rejects.toThrow(
      'unknown effort "ultra" — use low, medium, high, xhigh, max',
    );
  });

  it("setEffort rejects models without an effort level", async () => {
    await expect(controller.setEffort("monitor", "high")).rejects.toThrow(
      "haiku has no reasoning effort level — switch the monitor model first",
    );
    expect(await persisted()).toEqual({});
  });

  it("setIntervalMinutes converts to milliseconds on the live config", async () => {
    await controller.setIntervalMinutes(2.5);
    expect(config.monitor.intervalMs).toBe(150_000);
    expect(await persisted()).toEqual({ monitor: { intervalMinutes: 2.5 } });
  });

  it("setIntervalMinutes rejects non-positive values", async () => {
    await expect(controller.setIntervalMinutes(0)).rejects.toThrow(
      "interval must be a positive number of minutes",
    );
    await expect(controller.setIntervalMinutes(Number.NaN)).rejects.toThrow(
      "interval must be a positive number of minutes",
    );
  });

  it("setActiveHours builds the live schedule and clears it with null", async () => {
    await controller.setActiveHours("08:00-18:00");
    expect(config.monitor.schedule).toMatchObject({
      startMinute: 480,
      endMinute: 1080,
    });
    expect(await persisted()).toEqual({ monitor: { activeHours: "08:00-18:00" } });

    await controller.setActiveHours(null);
    expect(config.monitor.schedule).toBeNull();
    expect(await persisted()).toEqual({ monitor: {} });
  });

  it("setActiveHours rejects invalid windows before persisting", async () => {
    await expect(controller.setActiveHours("25:00-26:00")).rejects.toThrow(
      /working hours out of range/,
    );
    expect(await persisted()).toEqual({});
  });

  it("setActiveDays builds the live schedule and combines with hours", async () => {
    await controller.setActiveHours("08:00-18:00");
    await controller.setActiveDays("mon-fri");
    expect(config.monitor.schedule).toEqual({
      startMinute: 480,
      endMinute: 1080,
      days: [1, 2, 3, 4, 5],
    });

    await controller.setActiveHours(null);
    expect(config.monitor.schedule).toEqual({
      startMinute: 0,
      endMinute: 1440,
      days: [1, 2, 3, 4, 5],
    });

    await controller.setActiveDays(null);
    expect(config.monitor.schedule).toBeNull();
  });

  it("setActiveDays rejects unknown day tokens", async () => {
    await expect(controller.setActiveDays("someday")).rejects.toThrow(/unknown day/);
    expect(await persisted()).toEqual({});
  });

  it("leaves the live config untouched when persisting fails", async () => {
    await writeFile(settingsFile, '{"unknownKey": true}\n', "utf8");
    await expect(controller.setModel("monitor", "opus")).rejects.toThrow(/unknownKey/);
    expect(config.monitor.model).toBe("haiku");
  });
});
