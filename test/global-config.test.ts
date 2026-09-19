import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isAutoUpdaterDisabled, loadGlobalConfig } from "../src/global-config.js";
import { createTempDir, removeTempDir } from "./helpers.js";

describe("loadGlobalConfig", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await createTempDir();
  });

  afterEach(async () => {
    await removeTempDir(dir);
  });

  const configFile = () => join(dir, "config.json");

  it("returns defaults when the file is missing", async () => {
    expect(await loadGlobalConfig(configFile())).toEqual({ autoUpdate: true });
  });

  it("reads a valid config", async () => {
    await writeFile(configFile(), JSON.stringify({ autoUpdate: false }), "utf8");
    expect(await loadGlobalConfig(configFile())).toEqual({ autoUpdate: false });
  });

  it("falls back to defaults on invalid JSON", async () => {
    await writeFile(configFile(), "{ not json", "utf8");
    expect(await loadGlobalConfig(configFile())).toEqual({ autoUpdate: true });
  });

  it("falls back to defaults when an unknown key is present", async () => {
    await writeFile(configFile(), JSON.stringify({ nope: 1 }), "utf8");
    expect(await loadGlobalConfig(configFile())).toEqual({ autoUpdate: true });
  });
});

describe("isAutoUpdaterDisabled", () => {
  it("is true for 1/true and false otherwise", () => {
    expect(isAutoUpdaterDisabled({ KIKIMORA_DISABLE_AUTOUPDATER: "1" })).toBe(true);
    expect(isAutoUpdaterDisabled({ KIKIMORA_DISABLE_AUTOUPDATER: "true" })).toBe(true);
    expect(isAutoUpdaterDisabled({ KIKIMORA_DISABLE_AUTOUPDATER: "TRUE" })).toBe(true);
    expect(isAutoUpdaterDisabled({ KIKIMORA_DISABLE_AUTOUPDATER: "0" })).toBe(false);
    expect(isAutoUpdaterDisabled({})).toBe(false);
  });
});
