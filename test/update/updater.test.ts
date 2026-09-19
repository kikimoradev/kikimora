import { describe, expect, it, vi } from "vitest";
import type { InstallMethod, InstallResult } from "../../src/update/install.js";
import {
  checkForUpdate,
  performUpdate,
  type UpdateDeps,
} from "../../src/update/updater.js";

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

describe("checkForUpdate", () => {
  it("reports a newer version", async () => {
    const check = await checkForUpdate(buildDeps());
    expect(check).toEqual({
      current: "0.2.0",
      latest: "0.3.0",
      newer: true,
      method: "npm",
    });
  });

  it("reports no update when already current", async () => {
    const check = await checkForUpdate(
      buildDeps({ fetchLatest: vi.fn().mockResolvedValue("0.2.0") }),
    );
    expect(check.newer).toBe(false);
  });

  it("carries a null latest when the registry is unreachable", async () => {
    const check = await checkForUpdate(
      buildDeps({ fetchLatest: vi.fn().mockResolvedValue(null) }),
    );
    expect(check.latest).toBeNull();
    expect(check.newer).toBe(false);
  });
});

describe("performUpdate", () => {
  it("installs when newer and install is requested", async () => {
    const deps = buildDeps();
    const outcome = await performUpdate(deps, { install: true });
    expect(outcome).toMatchObject({ status: "updated", from: "0.2.0", to: "0.3.0" });
    expect(deps.install).toHaveBeenCalledWith("npm", "@kikimoradev/kikimora");
  });

  it("reports availability without installing in check mode", async () => {
    const deps = buildDeps();
    const outcome = await performUpdate(deps, { install: false });
    expect(outcome.status).toBe("available");
    expect(deps.install).not.toHaveBeenCalled();
  });

  it("returns up-to-date when versions match", async () => {
    const outcome = await performUpdate(
      buildDeps({ fetchLatest: vi.fn().mockResolvedValue("0.2.0") }),
      { install: true },
    );
    expect(outcome.status).toBe("up-to-date");
  });

  it("returns unreachable when the registry gives no version", async () => {
    const outcome = await performUpdate(
      buildDeps({ fetchLatest: vi.fn().mockResolvedValue(null) }),
      { install: true },
    );
    expect(outcome.status).toBe("unreachable");
  });

  it("returns unmanaged when the install method is unknown", async () => {
    const deps = buildDeps({ detect: vi.fn().mockReturnValue("unknown") });
    const outcome = await performUpdate(deps, { install: true });
    expect(outcome.status).toBe("unmanaged");
    expect(deps.install).not.toHaveBeenCalled();
  });

  it("returns failed when the install exits non-zero", async () => {
    const deps = buildDeps({
      install: vi.fn().mockResolvedValue({ ok: false, output: "nope" }),
    });
    const outcome = await performUpdate(deps, { install: true });
    expect(outcome).toMatchObject({ status: "failed", output: "nope" });
  });
});
