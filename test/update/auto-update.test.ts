import { describe, expect, it, vi, type Mock } from "vitest";
import type { GlobalConfig } from "../../src/global-config.js";
import type { HeadlessLogEmitter } from "../../src/headless/events.js";
import type { UpdateStatus } from "../../src/status.js";
import type { InstallMethod, InstallResult } from "../../src/update/install.js";
import { runAutoUpdateLoop } from "../../src/update/auto-update.js";
import type { UpdateDeps } from "../../src/update/updater.js";

interface Harness {
  deps: UpdateDeps;
  fetchLatest: Mock;
  install: Mock;
  setUpdateStatus: Mock<(info: UpdateStatus) => void>;
  emit: Mock<HeadlessLogEmitter>;
  controller: AbortController;
}

function harness(options: {
  latest?: string | null;
  method?: InstallMethod;
  installResult?: InstallResult;
  abortAfterFetches?: number;
}): Harness {
  const {
    latest = "0.3.0",
    method = "npm",
    installResult = { ok: true, output: "done" },
    abortAfterFetches = 2,
  } = options;
  const controller = new AbortController();
  let fetches = 0;
  const fetchLatest = vi.fn().mockImplementation(() => {
    fetches += 1;
    if (fetches >= abortAfterFetches) controller.abort();
    return Promise.resolve(latest);
  });
  const install = vi.fn().mockResolvedValue(installResult);
  return {
    fetchLatest,
    install,
    setUpdateStatus: vi.fn<(info: UpdateStatus) => void>(),
    emit: vi.fn<HeadlessLogEmitter>(),
    controller,
    deps: {
      name: "@kikimoradev/kikimora",
      current: "0.2.0",
      fetchLatest,
      detect: vi.fn<() => InstallMethod>().mockReturnValue(method),
      install,
    },
  };
}

const AUTO_ON: GlobalConfig = { autoUpdate: true };
const AUTO_OFF: GlobalConfig = { autoUpdate: false };

describe("runAutoUpdateLoop", () => {
  it("installs a newer version once and reports it", async () => {
    const h = harness({ abortAfterFetches: 3 });

    await runAutoUpdateLoop({
      globalConfig: AUTO_ON,
      deps: h.deps,
      setUpdateStatus: h.setUpdateStatus,
      emit: h.emit,
      signal: h.controller.signal,
      intervalMs: 1,
      env: {},
    });

    expect(h.install).toHaveBeenCalledTimes(1);
    expect(h.setUpdateStatus).toHaveBeenCalledWith({
      state: "installed",
      from: "0.2.0",
      to: "0.3.0",
    });
    expect(h.emit).toHaveBeenCalledWith(
      expect.objectContaining({ event: "update.installed" }),
    );
  });

  it("only notifies when auto-update is off", async () => {
    const h = harness({ abortAfterFetches: 2 });

    await runAutoUpdateLoop({
      globalConfig: AUTO_OFF,
      deps: h.deps,
      setUpdateStatus: h.setUpdateStatus,
      emit: h.emit,
      signal: h.controller.signal,
      intervalMs: 1,
      env: {},
    });

    expect(h.install).not.toHaveBeenCalled();
    expect(h.setUpdateStatus).toHaveBeenCalledWith({
      state: "available",
      from: "0.2.0",
      to: "0.3.0",
    });
    expect(h.emit).toHaveBeenCalledWith(
      expect.objectContaining({ event: "update.available" }),
    );
  });

  it("keeps the update available when the background install fails", async () => {
    const h = harness({
      installResult: { ok: false, output: "denied" },
      abortAfterFetches: 2,
    });

    await runAutoUpdateLoop({
      globalConfig: AUTO_ON,
      deps: h.deps,
      setUpdateStatus: h.setUpdateStatus,
      emit: h.emit,
      signal: h.controller.signal,
      intervalMs: 1,
      env: {},
    });

    expect(h.setUpdateStatus).toHaveBeenCalledWith({
      state: "available",
      from: "0.2.0",
      to: "0.3.0",
      installError: "denied",
    });
  });

  it("does nothing for an unmanaged install location", async () => {
    const h = harness({ method: "unknown" });

    await runAutoUpdateLoop({
      globalConfig: AUTO_ON,
      deps: h.deps,
      setUpdateStatus: h.setUpdateStatus,
      emit: h.emit,
      signal: h.controller.signal,
      intervalMs: 1,
      env: {},
    });

    expect(h.fetchLatest).not.toHaveBeenCalled();
    expect(h.setUpdateStatus).not.toHaveBeenCalled();
  });

  it("does nothing when disabled via the environment", async () => {
    const h = harness({});

    await runAutoUpdateLoop({
      globalConfig: AUTO_ON,
      deps: h.deps,
      setUpdateStatus: h.setUpdateStatus,
      emit: h.emit,
      signal: h.controller.signal,
      intervalMs: 1,
      env: { KIKIMORA_DISABLE_AUTOUPDATER: "1" },
    });

    expect(h.fetchLatest).not.toHaveBeenCalled();
  });

  it("ignores unparseable or same versions without installing", async () => {
    const h = harness({ latest: "0.2.0", abortAfterFetches: 2 });

    await runAutoUpdateLoop({
      globalConfig: AUTO_ON,
      deps: h.deps,
      setUpdateStatus: h.setUpdateStatus,
      emit: h.emit,
      signal: h.controller.signal,
      intervalMs: 1,
      env: {},
    });

    expect(h.install).not.toHaveBeenCalled();
    expect(h.setUpdateStatus).not.toHaveBeenCalled();
  });
});
