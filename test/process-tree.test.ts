import type { ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ execFile: vi.fn() }));

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  execFile: mocks.execFile,
}));

const { leadsOwnProcessGroup, terminateProcessTree } =
  await import("../src/process-tree.js");

type ExecFileCallback = (error: Error | null) => void;

function fakeChild(
  pid: number | undefined,
): ChildProcess & { kill: ReturnType<typeof vi.fn> } {
  return { pid, kill: vi.fn() } as unknown as ChildProcess & {
    kill: ReturnType<typeof vi.fn>;
  };
}

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

function groupSignals(): {
  signals: (string | number | undefined)[];
  alive: { value: boolean };
} {
  const alive = { value: true };
  const signals: (string | number | undefined)[] = [];
  vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
    if (pid !== -123) throw new Error(`unexpected pid ${String(pid)}`);
    if (signal === 0) {
      if (!alive.value) throw errno("ESRCH");
      return true;
    }
    signals.push(signal);
    return true;
  });
  return { signals, alive };
}

afterEach(() => {
  vi.restoreAllMocks();
  mocks.execFile.mockReset();
});

describe("leadsOwnProcessGroup", () => {
  it("gives sessions their own process group everywhere but Windows", () => {
    expect(leadsOwnProcessGroup("linux")).toBe(true);
    expect(leadsOwnProcessGroup("darwin")).toBe(true);
    expect(leadsOwnProcessGroup("win32")).toBe(false);
  });
});

describe("terminateProcessTree on POSIX", () => {
  it("does nothing for a process that never started", async () => {
    const kill = vi.spyOn(process, "kill");
    const child = fakeChild(undefined);

    await terminateProcessTree(child, 1000, "linux");

    expect(kill).not.toHaveBeenCalled();
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("stops at SIGTERM when the whole group exits within the grace", async () => {
    const { signals, alive } = groupSignals();
    setTimeout(() => {
      alive.value = false;
    }, 120);

    await terminateProcessTree(fakeChild(123), 5000, "linux");

    expect(signals).toEqual(["SIGTERM"]);
  });

  it("sends SIGKILL to the group when something outlives the grace", async () => {
    const { signals, alive } = groupSignals();
    setTimeout(() => {
      alive.value = false;
    }, 200);

    await terminateProcessTree(fakeChild(123), 60, "darwin");

    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("falls back to the process itself when its group cannot be signalled", async () => {
    vi.spyOn(process, "kill").mockImplementation((_pid, signal) => {
      if (signal === 0) throw errno("ESRCH");
      throw errno("EPERM");
    });
    const child = fakeChild(123);

    await terminateProcessTree(child, 1000, "linux");

    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("treats a group it may not signal as still running", async () => {
    let probes = 0;
    vi.spyOn(process, "kill").mockImplementation((_pid, signal) => {
      if (signal !== 0) return true;
      probes += 1;
      if (probes === 1) throw errno("EPERM");
      throw errno("ESRCH");
    });

    await terminateProcessTree(fakeChild(123), 1000, "linux");

    expect(probes).toBe(2);
  });
});

describe("terminateProcessTree on Windows", () => {
  it("ends the whole tree with taskkill", async () => {
    mocks.execFile.mockImplementation(
      (_file: string, _args: string[], _options: object, callback: ExecFileCallback) => {
        callback(null);
      },
    );
    const child = fakeChild(4321);

    await terminateProcessTree(child, 5000, "win32");

    expect(mocks.execFile).toHaveBeenCalledWith(
      expect.stringMatching(/taskkill\.exe$/i),
      ["/PID", "4321", "/T", "/F"],
      { windowsHide: true },
      expect.any(Function),
    );
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("kills the session process itself when taskkill fails", async () => {
    mocks.execFile.mockImplementation(
      (_file: string, _args: string[], _options: object, callback: ExecFileCallback) => {
        callback(new Error("taskkill exited with 128"));
      },
    );
    const child = fakeChild(4321);

    await terminateProcessTree(child, 5000, "win32");

    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  });
});
