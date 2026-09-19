import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InstallMethod, InstallResult } from "../src/update/install.js";
import type { UpdateDeps } from "../src/update/updater.js";

vi.mock("../src/logger.js", async () =>
  (await import("./helpers.js")).loggerModuleMock(),
);

const { runUpdate } = await import("../src/update-command.js");
const { logger } = await import("../src/logger.js");

function buildDeps(overrides: Partial<UpdateDeps> = {}): UpdateDeps {
  return {
    name: "@kikimoradev/kikimora",
    current: "0.2.0",
    fetchLatest: vi.fn().mockResolvedValue("0.3.0"),
    detect: vi.fn<() => InstallMethod>().mockReturnValue("npm"),
    install: vi
      .fn<() => Promise<InstallResult>>()
      .mockResolvedValue({ ok: true, output: "done" }),
    ...overrides,
  };
}

describe("runUpdate", () => {
  let savedExitCode: typeof process.exitCode;

  beforeEach(() => {
    vi.clearAllMocks();
    savedExitCode = process.exitCode;
  });

  afterEach(() => {
    process.exitCode = savedExitCode;
  });

  it("installs a newer version by default", async () => {
    const deps = buildDeps();
    await runUpdate({ deps });

    expect(deps.install).toHaveBeenCalledWith("npm", "@kikimoradev/kikimora");
    expect(logger.success).toHaveBeenCalledWith(
      expect.stringContaining("Updated kikimora 0.2.0 → 0.3.0"),
    );
    expect(process.exitCode).toBe(savedExitCode);
  });

  it("only checks in --check mode", async () => {
    const deps = buildDeps();
    await runUpdate({ check: true, deps });

    expect(deps.install).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("Update available: 0.2.0 → 0.3.0"),
    );
  });

  it("reports being up to date", async () => {
    await runUpdate({
      deps: buildDeps({ fetchLatest: vi.fn().mockResolvedValue("0.2.0") }),
    });
    expect(logger.success).toHaveBeenCalledWith(expect.stringContaining("up to date"));
  });

  it("prints a manual command and fails for an unmanaged install", async () => {
    await runUpdate({ deps: buildDeps({ detect: vi.fn().mockReturnValue("unknown") }) });

    expect(process.exitCode).toBe(1);
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("npm install -g @kikimoradev/kikimora@latest"),
    );
  });

  it("fails when the install errors", async () => {
    await runUpdate({
      deps: buildDeps({
        install: vi.fn().mockResolvedValue({ ok: false, output: "denied" }),
      }),
    });

    expect(process.exitCode).toBe(1);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("Failed to update"),
    );
  });

  it("fails when the registry is unreachable", async () => {
    await runUpdate({
      deps: buildDeps({ fetchLatest: vi.fn().mockResolvedValue(null) }),
    });

    expect(process.exitCode).toBe(1);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("Could not reach the npm registry"),
    );
  });
});
