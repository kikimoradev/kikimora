import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SignalPolicy } from "../src/shutdown.js";
import type { StartWorkerOptions } from "../src/start.js";
import { packageVersion } from "../src/paths.js";
import type { ExecutorReporter, MonitorReporter } from "../src/status.js";
import { buildConfig, createTempDir, removeTempDir, snapshotEnv } from "./helpers.js";

const mocks = vi.hoisted(() => ({
  ensureReady: vi.fn(),
  loadWorkerConfig: vi.fn(),
  runMonitorLoop: vi.fn(),
  runExecutorLoop: vi.fn(),
  abortOnSignals: vi.fn(),
  taskStoreOpen: vi.fn(),
  memoryStoreOpen: vi.fn(),
  memoryStoreClose: vi.fn(),
  mountDashboard: vi.fn(),
  dashboardUnmount: vi.fn(),
  dashboardWaitUntilExit: vi.fn(),
  startControlServer: vi.fn(),
  controlServerClose: vi.fn(),
  sessionIndexOn: vi.fn(),
  sessionStarted: vi.fn(),
  sessionFinished: vi.fn(),
  sessionList: vi.fn(),
  sessionGet: vi.fn(),
}));

vi.mock("../src/preflight.js", () => ({ ensureReady: mocks.ensureReady }));
vi.mock("../src/config.js", () => ({ loadWorkerConfig: mocks.loadWorkerConfig }));
vi.mock("../src/monitor.js", () => ({ runMonitorLoop: mocks.runMonitorLoop }));
vi.mock("../src/executor.js", () => ({ runExecutorLoop: mocks.runExecutorLoop }));
vi.mock("../src/shutdown.js", () => ({ abortOnSignals: mocks.abortOnSignals }));
vi.mock("../src/tasks.js", () => ({ TaskStore: { open: mocks.taskStoreOpen } }));
vi.mock("../src/memory/store.js", () => ({
  MemoryStore: { open: mocks.memoryStoreOpen },
}));
vi.mock("../src/sessions/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/sessions/index.js")>()),
  SessionIndex: { on: mocks.sessionIndexOn },
}));
vi.mock("../src/ui/mount.js", () => ({ mountDashboard: mocks.mountDashboard }));
vi.mock("../src/control-server.js", () => ({
  startControlServer: mocks.startControlServer,
}));
vi.mock("../src/logger.js", async () =>
  (await import("./helpers.js")).loggerModuleMock(),
);

const { startWorker } = await import("../src/start.js");
const { AgentController } = await import("../src/control.js");
const { DrainController } = await import("../src/drain.js");
const { Waker } = await import("../src/waker.js");
const { WorkerStatusStore } = await import("../src/status.js");
const { UsageLimitGate } = await import("../src/usage-limit.js");
const { AuthGate } = await import("../src/auth-gate.js");
const { SessionSummarizer } = await import("../src/memory/summarizer.js");
const { logger } = await import("../src/logger.js");

function runStart(options?: StartWorkerOptions): Promise<void> {
  return startWorker(options);
}

function verifiedPaths(dir: string) {
  return {
    monitor: {
      promptPath: join(dir, "monitor.prompt.md"),
      systemPromptPath: join(dir, "monitor.system.md"),
    },
    executor: {
      promptPath: join(dir, "executor.prompt.md"),
      systemPromptPath: join(dir, "executor.system.md"),
    },
  };
}

function preflightResult(dir: string) {
  return {
    paths: verifiedPaths(dir),
    claude: { version: "2.1.268", auth: { loggedIn: true, authMethod: "claude.ai" } },
  };
}

interface JsonSink {
  write(chunk: string): boolean;
  events(): Record<string, unknown>[];
}

function jsonSink(): JsonSink {
  const lines: string[] = [];
  return {
    write(chunk: string) {
      lines.push(chunk);
      return true;
    },
    events: () =>
      lines.map((line) => JSON.parse(line.trimEnd()) as Record<string, unknown>),
  };
}

type Controller = InstanceType<typeof AgentController>;

function untilAborted(signal: AbortSignal): Promise<void> {
  return new Promise((resolvePromise) => {
    if (signal.aborted) resolvePromise();
    else signal.addEventListener("abort", () => resolvePromise(), { once: true });
  });
}

async function idleLoop(controller: Controller, signal: AbortSignal): Promise<void> {
  while (!signal.aborted) {
    await controller.pauseRequested(signal);
    await controller.gate(signal);
  }
}

function monitorLoopArgs(args: unknown[]): [Controller, AbortSignal] {
  return [args[4] as Controller, args[6] as AbortSignal];
}

function executorLoopArgs(args: unknown[]): [Controller, AbortSignal] {
  return [args[5] as Controller, args[7] as AbortSignal];
}

interface SignalsHarness {
  policy(): SignalPolicy;
  deliver(signalName: NodeJS.Signals): void;
}

function captureSignals(): SignalsHarness {
  const shutdown = new AbortController();
  const captured: { policy?: SignalPolicy; draining: boolean } = { draining: false };
  mocks.abortOnSignals.mockImplementation((policy: SignalPolicy) => {
    captured.policy = policy;
    return shutdown.signal;
  });
  const policy = (): SignalPolicy => {
    if (captured.policy === undefined) throw new Error("abortOnSignals was not called");
    return captured.policy;
  };
  return {
    policy,
    deliver: (signalName) => {
      const graceMs = captured.draining ? 0 : policy().graceMsFor(signalName);
      if (graceMs > 0) {
        captured.draining = true;
        policy().onDrain(signalName, graceMs);
        return;
      }
      policy().onAbort(signalName);
      shutdown.abort();
    },
  };
}

describe("startWorker", () => {
  let dir: string;
  let savedExitCode: typeof process.exitCode;
  let stdinTty: boolean;
  let stdoutTty: boolean;

  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.dashboardWaitUntilExit.mockResolvedValue(undefined);
    mocks.mountDashboard.mockReturnValue({
      unmount: mocks.dashboardUnmount,
      waitUntilExit: mocks.dashboardWaitUntilExit,
    });
    mocks.memoryStoreOpen.mockReturnValue({
      close: mocks.memoryStoreClose,
      connection: {},
    });
    mocks.sessionIndexOn.mockReturnValue({
      started: mocks.sessionStarted,
      finished: mocks.sessionFinished,
      list: mocks.sessionList,
      get: mocks.sessionGet,
    });
    mocks.controlServerClose.mockResolvedValue(undefined);
    mocks.startControlServer.mockResolvedValue({ close: mocks.controlServerClose });
    dir = await createTempDir();
    savedExitCode = process.exitCode;
    stdinTty = process.stdin.isTTY;
    stdoutTty = process.stdout.isTTY;
    process.stdin.isTTY = false;
    process.stdout.isTTY = false;
  });

  afterEach(async () => {
    process.exitCode = savedExitCode;
    process.stdin.isTTY = stdinTty;
    process.stdout.isTTY = stdoutTty;
    await removeTempDir(dir);
  });

  function stubHappyPath(config = buildConfig()) {
    const signal = new AbortController().signal;
    const store = { pendingCount: () => 0, list: () => [], onChange: vi.fn() };
    mocks.ensureReady.mockResolvedValue(preflightResult(dir));
    mocks.loadWorkerConfig.mockResolvedValue(config);
    mocks.abortOnSignals.mockReturnValue(signal);
    mocks.taskStoreOpen.mockResolvedValue(store);
    mocks.runMonitorLoop.mockResolvedValue(undefined);
    mocks.runExecutorLoop.mockResolvedValue(undefined);
    return { signal, store, config };
  }

  it("passes preflight, builds config, opens the store and starts both loops", async () => {
    const config = buildConfig({
      cwd: dir,
      tasksFilePath: join(dir, ".kikimora", "data", "tasks.json"),
    });
    const { store } = stubHappyPath(config);

    await runStart({ stdout: jsonSink() });

    expect(mocks.ensureReady).toHaveBeenCalledWith();
    expect(mocks.loadWorkerConfig).toHaveBeenCalledWith({}, verifiedPaths(dir));
    expect(mocks.taskStoreOpen).toHaveBeenCalledWith(config.tasksFilePath);
    expect(mocks.runMonitorLoop).toHaveBeenCalledWith(
      config,
      store,
      expect.any(Waker),
      expect.objectContaining({ cycleStarted: expect.any(Function) as unknown }),
      expect.any(AgentController),
      expect.objectContaining({
        limit: expect.any(UsageLimitGate) as unknown,
        auth: expect.any(AuthGate) as unknown,
      }),
      expect.any(AbortSignal),
      expect.objectContaining({ started: expect.any(Function) as unknown }),
    );
    expect(mocks.memoryStoreOpen).toHaveBeenCalledWith(config.memoryDbPath);
    expect(mocks.runExecutorLoop).toHaveBeenCalledWith(
      config,
      store,
      expect.any(Waker),
      expect.objectContaining({ taskStarted: expect.any(Function) as unknown }),
      expect.any(SessionSummarizer),
      expect.any(AgentController),
      expect.objectContaining({
        limit: expect.any(UsageLimitGate) as unknown,
        auth: expect.any(AuthGate) as unknown,
      }),
      expect.any(AbortSignal),
      expect.objectContaining({ started: expect.any(Function) as unknown }),
    );
    const monitorController = mocks.runMonitorLoop.mock.calls[0]?.[4] as InstanceType<
      typeof AgentController
    >;
    const executorController = mocks.runExecutorLoop.mock.calls[0]?.[5] as InstanceType<
      typeof AgentController
    >;
    expect(monitorController).not.toBe(executorController);
    expect(monitorController.state).toBe("running");
    expect(executorController.state).toBe("running");
    const monitorWaker = mocks.runMonitorLoop.mock.calls[0]?.[2] as unknown;
    const executorWaker = mocks.runExecutorLoop.mock.calls[0]?.[2] as unknown;
    expect(monitorWaker).toBe(executorWaker);
    const monitorGate = mocks.runMonitorLoop.mock.calls[0]?.[5] as unknown;
    const executorGate = mocks.runExecutorLoop.mock.calls[0]?.[6] as unknown;
    expect(monitorGate).toBe(executorGate);
    const monitorSignal = mocks.runMonitorLoop.mock.calls[0]?.[6] as unknown;
    const executorSignal = mocks.runExecutorLoop.mock.calls[0]?.[7] as unknown;
    expect(monitorSignal).toBe(executorSignal);
    expect(store.onChange).toHaveBeenCalledWith(expect.any(Function));
    expect(mocks.memoryStoreClose).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBe(savedExitCode);
    expect(mocks.startControlServer).toHaveBeenCalledWith(
      expect.objectContaining({
        socketPath: expect.stringContaining("kikimora-") as unknown,
        controls: { monitor: monitorController, executor: executorController },
        buildStatus: expect.any(Function) as unknown,
        tasks: store,
        memory: expect.objectContaining({
          close: expect.any(Function) as unknown,
        }) as unknown,
        settings: expect.objectContaining({
          current: expect.any(Function) as unknown,
          patch: expect.any(Function) as unknown,
        }) as unknown,
        prompts: expect.objectContaining({
          read: expect.any(Function) as unknown,
          write: expect.any(Function) as unknown,
        }) as unknown,
        context: expect.objectContaining({
          read: expect.any(Function) as unknown,
          write: expect.any(Function) as unknown,
        }) as unknown,
        waker: expect.any(Waker) as unknown,
        sessions: expect.objectContaining({
          list: expect.any(Function) as unknown,
        }) as unknown,
        drain: expect.any(DrainController) as unknown,
        signal: monitorSignal,
      }),
    );
    expect(mocks.controlServerClose).toHaveBeenCalledTimes(1);
    const serverDeps = mocks.startControlServer.mock.calls[0]?.[0] as {
      buildStatus: () => Record<string, unknown>;
    };
    expect(serverDeps.buildStatus()).toMatchObject({
      pid: process.pid,
      projectDir: dir,
      headless: true,
      taskCounts: expect.objectContaining({ pending: 0 }) as unknown,
    });
  });

  it("hands the control server an identity built from preflight, the process and the credential variables", async () => {
    stubHappyPath(buildConfig({ cwd: dir }));
    const restoreEnv = snapshotEnv();
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "test-token";
    delete process.env.ANTHROPIC_API_KEY;

    try {
      await runStart({ stdout: jsonSink() });
    } finally {
      restoreEnv();
    }

    const serverDeps = mocks.startControlServer.mock.calls[0]?.[0] as {
      identity: Record<string, unknown>;
      buildStatus: () => Record<string, unknown>;
    };
    expect(serverDeps.identity).toEqual({
      version: packageVersion(),
      claudeVersion: "2.1.268",
      nodeVersion: process.versions.node,
      pid: process.pid,
      startedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T.*Z$/) as unknown,
      projectDir: dir,
      authKind: "oauth",
    });
    expect(serverDeps.buildStatus()).toMatchObject({
      ...serverDeps.identity,
      headless: true,
    });
  });

  it("an auth failure pauses both controllers and resume clears the gate", async () => {
    stubHappyPath(buildConfig({ cwd: dir }));
    const sink = jsonSink();

    await runStart({ logFormat: "json", stdout: sink });

    const gates = mocks.runMonitorLoop.mock.calls[0]?.[5] as {
      auth: { engage(failure: { reason: string }): void; blocked: unknown };
    };
    const monitorController = mocks.runMonitorLoop.mock.calls[0]?.[4] as InstanceType<
      typeof AgentController
    >;
    const executorController = mocks.runExecutorLoop.mock.calls[0]?.[5] as InstanceType<
      typeof AgentController
    >;

    gates.auth.engage({ reason: "Not logged in" });

    expect(monitorController.state).toBe("pausing");
    expect(executorController.state).toBe("pausing");
    const pausing = sink
      .events()
      .filter((event) => event.event === "control.changed" && event.state === "pausing");
    expect(pausing.map((event) => event.agent).sort()).toEqual(["executor", "monitor"]);

    monitorController.resume();

    expect(gates.auth.blocked).toBeNull();
    expect(monitorController.state).toBe("running");
    expect(executorController.state).toBe("pausing");
  });

  describe("signals", () => {
    function blockUntilAborted(): void {
      mocks.runMonitorLoop.mockImplementation((...args: unknown[]) =>
        untilAborted(monitorLoopArgs(args)[1]),
      );
      mocks.runExecutorLoop.mockImplementation((...args: unknown[]) =>
        untilAborted(executorLoopArgs(args)[1]),
      );
    }

    it("SIGTERM without a shutdown grace stops the loops at once and names the signal", async () => {
      stubHappyPath(buildConfig({ cwd: dir }));
      const signals = captureSignals();
      blockUntilAborted();
      const sink = jsonSink();

      const worker = runStart({ logFormat: "json", stdout: sink });
      await vi.waitFor(() => expect(mocks.runExecutorLoop).toHaveBeenCalled());
      expect(signals.policy().graceMsFor("SIGTERM")).toBe(0);
      signals.deliver("SIGTERM");
      await worker;

      expect(sink.events().map((event) => event.event)).not.toContain("worker.draining");
      const stopped = sink.events().at(-1);
      expect(stopped).toMatchObject({ event: "worker.stopped", signal: "SIGTERM" });
      expect(stopped).not.toHaveProperty("drained");
      expect(stopped).not.toHaveProperty("forced");
    });

    it("grants the shutdown grace to SIGTERM only, read live from the configuration", async () => {
      const config = buildConfig({ cwd: dir, shutdownGraceMs: 120_000 });
      stubHappyPath(config);
      const signals = captureSignals();

      await runStart({ logFormat: "json", stdout: jsonSink() });

      expect(signals.policy().graceMsFor("SIGTERM")).toBe(120_000);
      expect(signals.policy().graceMsFor("SIGINT")).toBe(0);
      config.shutdownGraceMs = 5_000;
      expect(signals.policy().graceMsFor("SIGTERM")).toBe(5_000);
    });

    it("SIGTERM under a grace drains with that deadline, and the worker exits drained once the agents rest", async () => {
      stubHappyPath(buildConfig({ cwd: dir, shutdownGraceMs: 120_000 }));
      const signals = captureSignals();
      let finishSession: () => void = () => undefined;
      const session = new Promise<void>((resolvePromise) => {
        finishSession = resolvePromise;
      });
      mocks.runMonitorLoop.mockImplementation((...args: unknown[]) =>
        idleLoop(...monitorLoopArgs(args)),
      );
      mocks.runExecutorLoop.mockImplementation(async (...args: unknown[]) => {
        const [controller, signal] = executorLoopArgs(args);
        await session;
        await idleLoop(controller, signal);
      });
      const sink = jsonSink();

      const worker = runStart({ logFormat: "json", stdout: sink });
      await vi.waitFor(() => expect(mocks.runExecutorLoop).toHaveBeenCalled());
      signals.deliver("SIGTERM");

      expect(sink.events()).toContainEqual(
        expect.objectContaining({
          event: "worker.draining",
          reason: "SIGTERM",
          timeoutMs: 120_000,
        }),
      );
      const deps = mocks.startControlServer.mock.calls[0]?.[0] as {
        buildStatus: () => { drain?: { reason: string; since: string; until: string } };
      };
      const drain = deps.buildStatus().drain;
      expect(drain?.reason).toBe("SIGTERM");
      expect(Date.parse(drain?.until ?? "") - Date.parse(drain?.since ?? "")).toBe(
        120_000,
      );
      expect(signals.policy().graceMsFor("SIGTERM")).toBe(0);

      finishSession();
      await worker;

      const stopped = sink.events().at(-1);
      expect(stopped).toMatchObject({
        event: "worker.stopped",
        signal: "SIGTERM",
        drained: true,
      });
      expect(stopped).not.toHaveProperty("forced");
    });

    it("a second signal during the grace stops at once and says forced", async () => {
      stubHappyPath(buildConfig({ cwd: dir, shutdownGraceMs: 120_000 }));
      const signals = captureSignals();
      blockUntilAborted();
      const sink = jsonSink();

      const worker = runStart({ logFormat: "json", stdout: sink });
      await vi.waitFor(() => expect(mocks.runExecutorLoop).toHaveBeenCalled());
      signals.deliver("SIGTERM");
      signals.deliver("SIGINT");
      await worker;

      const stopped = sink.events().at(-1);
      expect(stopped).toMatchObject({
        event: "worker.stopped",
        signal: "SIGINT",
        drained: true,
        forced: true,
      });
    });

    it("a signal during kikimora drain stops at once, whatever the grace", async () => {
      stubHappyPath(buildConfig({ cwd: dir, shutdownGraceMs: 120_000 }));
      const signals = captureSignals();
      blockUntilAborted();
      const sink = jsonSink();

      const worker = runStart({ logFormat: "json", stdout: sink });
      await vi.waitFor(() => expect(mocks.runExecutorLoop).toHaveBeenCalled());
      const deps = mocks.startControlServer.mock.calls[0]?.[0] as {
        drain: InstanceType<typeof DrainController>;
      };
      deps.drain.request("drain", undefined);
      signals.deliver("SIGTERM");
      await worker;

      expect(
        sink.events().filter((event) => event.event === "worker.draining"),
      ).toHaveLength(1);
      expect(sink.events().at(-1)).toMatchObject({
        event: "worker.stopped",
        signal: "SIGTERM",
        drained: true,
        forced: true,
      });
    });

    it("a signal after the drain finished does not change how the worker says it stopped", async () => {
      stubHappyPath(buildConfig({ cwd: dir }));
      const signals = captureSignals();
      mocks.runMonitorLoop.mockImplementation((...args: unknown[]) =>
        idleLoop(...monitorLoopArgs(args)),
      );
      mocks.runExecutorLoop.mockImplementation((...args: unknown[]) =>
        idleLoop(...executorLoopArgs(args)),
      );
      mocks.controlServerClose.mockImplementation(() => {
        signals.deliver("SIGTERM");
        return Promise.resolve();
      });
      const sink = jsonSink();

      const worker = runStart({ logFormat: "json", stdout: sink });
      await vi.waitFor(() => expect(mocks.runExecutorLoop).toHaveBeenCalled());
      const deps = mocks.startControlServer.mock.calls[0]?.[0] as {
        drain: InstanceType<typeof DrainController>;
      };
      deps.drain.request("drain", undefined);
      await worker;

      const stopped = sink.events().at(-1);
      expect(stopped).toMatchObject({ event: "worker.stopped", drained: true });
      expect(stopped).not.toHaveProperty("signal");
      expect(stopped).not.toHaveProperty("forced");
    });
  });

  describe("drain", () => {
    function serverDrain(): InstanceType<typeof DrainController> {
      const deps = mocks.startControlServer.mock.calls[0]?.[0] as {
        drain: InstanceType<typeof DrainController>;
      };
      return deps.drain;
    }

    function serverStatus(): Record<string, unknown> {
      const deps = mocks.startControlServer.mock.calls[0]?.[0] as {
        buildStatus: () => Record<string, unknown>;
      };
      return deps.buildStatus();
    }

    function eventNames(sink: JsonSink): string[] {
      return sink
        .events()
        .map((event) =>
          event.event === "control.changed"
            ? `${String(event.agent)} ${String(event.state)}`
            : String(event.event),
        );
    }

    it("lets the session in flight finish, exits once both agents rest, and says drained after the logs close", async () => {
      stubHappyPath(buildConfig({ cwd: dir }));
      const sink = jsonSink();
      let finishSession: () => void = () => undefined;
      const session = new Promise<void>((resolvePromise) => {
        finishSession = resolvePromise;
      });
      mocks.runMonitorLoop.mockImplementation((...args: unknown[]) =>
        idleLoop(...monitorLoopArgs(args)),
      );
      mocks.runExecutorLoop.mockImplementation(async (...args: unknown[]) => {
        const [controller, signal] = executorLoopArgs(args);
        await session;
        await idleLoop(controller, signal);
      });
      let stoppedBeforeServerClosed = false;
      mocks.controlServerClose.mockImplementation(() => {
        stoppedBeforeServerClosed = eventNames(sink).includes("worker.stopped");
        return Promise.resolve();
      });

      const worker = runStart({ logFormat: "json", stdout: sink });
      await vi.waitFor(() => expect(mocks.runExecutorLoop).toHaveBeenCalled());
      const drain = serverDrain();
      const ack = drain.request("drain", undefined);
      await vi.waitFor(() => expect(eventNames(sink)).toContain("monitor paused"));

      expect(sink.events()).toContainEqual(
        expect.objectContaining({
          level: "info",
          event: "worker.draining",
          reason: "drain",
        }),
      );
      expect(
        sink.events().find((event) => event.event === "worker.draining"),
      ).not.toHaveProperty("timeoutMs");
      expect(serverStatus()).toMatchObject({
        drain: { since: new Date(ack.since).toISOString(), reason: "drain" },
      });
      expect(eventNames(sink)).not.toContain("worker.stopped");

      finishSession();
      await worker;

      expect(eventNames(sink).slice(1)).toEqual([
        "worker.draining",
        "monitor pausing",
        "executor pausing",
        "monitor paused",
        "executor paused",
        "worker.stopped",
      ]);
      const stopped = sink.events().at(-1);
      expect(stopped).toMatchObject({
        level: "info",
        event: "worker.stopped",
        drained: true,
      });
      expect(stopped).not.toHaveProperty("forced");
      expect(stopped).not.toHaveProperty("signal");
      expect(drain.settled).toBe(true);
      expect(stoppedBeforeServerClosed).toBe(false);
      expect(process.exitCode).toBe(savedExitCode);
    });

    it("exits once the monitor finishes its cycle when the executor was idle", async () => {
      stubHappyPath(buildConfig({ cwd: dir }));
      const sink = jsonSink();
      let finishCycle: () => void = () => undefined;
      const cycle = new Promise<void>((resolvePromise) => {
        finishCycle = resolvePromise;
      });
      mocks.runMonitorLoop.mockImplementation(async (...args: unknown[]) => {
        const [controller, signal] = monitorLoopArgs(args);
        await cycle;
        await idleLoop(controller, signal);
      });
      mocks.runExecutorLoop.mockImplementation((...args: unknown[]) =>
        idleLoop(...executorLoopArgs(args)),
      );

      const worker = runStart({ logFormat: "json", stdout: sink });
      await vi.waitFor(() => expect(mocks.runExecutorLoop).toHaveBeenCalled());
      serverDrain().request("drain", undefined);
      await vi.waitFor(() => expect(eventNames(sink)).toContain("executor paused"));
      expect(eventNames(sink)).not.toContain("worker.stopped");

      finishCycle();
      await vi.waitFor(() => expect(eventNames(sink)).toContain("worker.stopped"), {
        timeout: 2_000,
      });
      await worker;

      expect(eventNames(sink).slice(-3)).toEqual([
        "executor paused",
        "monitor paused",
        "worker.stopped",
      ]);
      expect(sink.events().at(-1)).toMatchObject({ drained: true });
      expect(sink.events().at(-1)).not.toHaveProperty("forced");
    });

    it("a drain deadline cuts the session short and says forced", async () => {
      stubHappyPath(buildConfig({ cwd: dir }));
      const sink = jsonSink();
      mocks.runMonitorLoop.mockImplementation((...args: unknown[]) =>
        idleLoop(...monitorLoopArgs(args)),
      );
      mocks.runExecutorLoop.mockImplementation((...args: unknown[]) =>
        untilAborted(executorLoopArgs(args)[1]),
      );

      const worker = runStart({ logFormat: "json", stdout: sink });
      await vi.waitFor(() => expect(mocks.runExecutorLoop).toHaveBeenCalled());
      serverDrain().request("drain", 50);
      await worker;

      expect(sink.events()).toContainEqual(
        expect.objectContaining({
          event: "worker.draining",
          reason: "drain",
          timeoutMs: 50,
        }),
      );
      expect(sink.events().at(-1)).toMatchObject({
        level: "info",
        event: "worker.stopped",
        drained: true,
        forced: true,
      });
    });
  });

  it("exits with code 1 when another worker already owns the control socket", async () => {
    stubHappyPath(buildConfig({ cwd: dir }));
    mocks.startControlServer.mockRejectedValue(
      new Error("kikimora is already running in this project (pid 123)."),
    );

    await runStart({ stdout: jsonSink() });

    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("already running"));
    expect(process.exitCode).toBe(1);
    expect(mocks.runMonitorLoop).not.toHaveBeenCalled();
    expect(mocks.runExecutorLoop).not.toHaveBeenCalled();
    expect(mocks.memoryStoreClose).toHaveBeenCalledTimes(1);
  });

  it("headless without a TTY: skips the dashboard and logs the worker lifecycle with its identity", async () => {
    stubHappyPath(buildConfig({ cwd: dir }));
    const sink = jsonSink();
    const restoreEnv = snapshotEnv();
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    delete process.env.ANTHROPIC_API_KEY;

    try {
      await runStart({ logFormat: "json", stdout: sink });
    } finally {
      restoreEnv();
    }

    expect(mocks.mountDashboard).not.toHaveBeenCalled();
    expect(mocks.dashboardUnmount).not.toHaveBeenCalled();
    const events = sink.events();
    expect(events[0]).toMatchObject({
      event: "worker.started",
      version: packageVersion(),
      claudeVersion: "2.1.268",
      nodeVersion: process.versions.node,
      authKind: "claude.ai",
      pid: process.pid,
      projectDir: dir,
    });
    expect(events[0]).not.toHaveProperty("paused");
    expect(events.at(-1)).toMatchObject({ event: "worker.stopped" });
    expect(events.at(-1)).not.toHaveProperty("signal");
  });

  it("the paused option boots headless controllers paused and says so in worker.started", async () => {
    stubHappyPath(buildConfig({ cwd: dir }));
    const sink = jsonSink();

    await runStart({ paused: true, logFormat: "json", stdout: sink });

    const monitorController = mocks.runMonitorLoop.mock.calls[0]?.[4] as InstanceType<
      typeof AgentController
    >;
    const executorController = mocks.runExecutorLoop.mock.calls[0]?.[5] as InstanceType<
      typeof AgentController
    >;
    expect(monitorController.state).toBe("paused");
    expect(executorController.state).toBe("paused");
    expect(sink.events()[0]).toMatchObject({ event: "worker.started", paused: true });
    const serverDeps = mocks.startControlServer.mock.calls[0]?.[0] as {
      buildStatus: () => {
        agents: { monitor: { control: string }; executor: { control: string } };
      };
    };
    const agents = serverDeps.buildStatus().agents;
    expect(agents.monitor.control).toBe("paused");
    expect(agents.executor.control).toBe("paused");
  });

  it("headless: tees loop reporters into the status store and the log sink", async () => {
    stubHappyPath(buildConfig({ cwd: dir }));
    const sink = jsonSink();

    await runStart({ logFormat: "json", stdout: sink });

    const monitorReporter = mocks.runMonitorLoop.mock.calls[0]?.[3] as MonitorReporter;
    const executorReporter = mocks.runExecutorLoop.mock.calls[0]?.[3] as ExecutorReporter;
    monitorReporter.cycleStarted(9);
    executorReporter.waiting();

    const events = sink.events();
    expect(events).toContainEqual(
      expect.objectContaining({ event: "cycle.started", agent: "monitor", cycle: 9 }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({ event: "executor.waiting", agent: "executor" }),
    );
  });

  it("headless: emits control.changed when a controller changes state", async () => {
    stubHappyPath(buildConfig({ cwd: dir }));
    const sink = jsonSink();

    await runStart({ logFormat: "json", stdout: sink });

    const monitorController = mocks.runMonitorLoop.mock.calls[0]?.[4] as InstanceType<
      typeof AgentController
    >;
    monitorController.pause();

    expect(sink.events()).toContainEqual(
      expect.objectContaining({
        event: "control.changed",
        agent: "monitor",
        state: "pausing",
      }),
    );
  });

  it("the --headless flag forces headless mode even with a TTY", async () => {
    process.stdin.isTTY = true;
    process.stdout.isTTY = true;
    stubHappyPath(buildConfig({ cwd: dir }));
    const sink = jsonSink();

    await runStart({ headless: true, logFormat: "json", stdout: sink });

    expect(mocks.mountDashboard).not.toHaveBeenCalled();
    const monitorController = mocks.runMonitorLoop.mock.calls[0]?.[4] as InstanceType<
      typeof AgentController
    >;
    expect(monitorController.state).toBe("running");
    expect(sink.events()[0]).toMatchObject({ event: "worker.started" });
  });

  it("interactive: mounts the dashboard, boots paused and stays silent on stdout", async () => {
    process.stdin.isTTY = true;
    process.stdout.isTTY = true;
    const { store } = stubHappyPath(buildConfig({ cwd: dir }));
    const sink = jsonSink();

    await runStart({ stdout: sink });

    expect(sink.events()).toEqual([]);
    const monitorController = mocks.runMonitorLoop.mock.calls[0]?.[4] as InstanceType<
      typeof AgentController
    >;
    const executorController = mocks.runExecutorLoop.mock.calls[0]?.[5] as InstanceType<
      typeof AgentController
    >;
    expect(monitorController.state).toBe("paused");
    expect(executorController.state).toBe("paused");
    expect(mocks.mountDashboard).toHaveBeenCalledWith(
      expect.objectContaining({
        store: expect.any(WorkerStatusStore) as unknown,
        version: expect.any(String) as unknown,
        controls: {
          monitor: expect.any(AgentController) as unknown,
          executor: expect.any(AgentController) as unknown,
        },
        tasks: store,
        settings: expect.objectContaining({
          setModel: expect.any(Function) as unknown,
        }) as unknown,
        prompts: expect.objectContaining({
          read: expect.any(Function) as unknown,
          write: expect.any(Function) as unknown,
        }) as unknown,
        context: expect.objectContaining({
          read: expect.any(Function) as unknown,
          write: expect.any(Function) as unknown,
        }) as unknown,
        waker: expect.any(Waker) as unknown,
        drain: expect.any(DrainController) as unknown,
        requestExit: expect.any(Function) as unknown,
      }),
    );
    const mountProps = mocks.mountDashboard.mock.calls[0]?.[0] as {
      store: InstanceType<typeof WorkerStatusStore>;
      controls: { monitor: unknown; executor: unknown };
      version: string;
      settings: unknown;
      prompts: unknown;
      context: unknown;
      waker: unknown;
      drain: unknown;
    };
    expect(mountProps.controls.monitor).toBe(monitorController);
    expect(mountProps.controls.executor).toBe(executorController);
    const serverDeps = mocks.startControlServer.mock.calls[0]?.[0] as {
      settings: unknown;
      prompts: unknown;
      context: unknown;
      waker: unknown;
      drain: unknown;
    };
    expect(serverDeps.drain).toBe(mountProps.drain);
    expect(serverDeps.settings).toBe(mountProps.settings);
    expect(serverDeps.prompts).toBe(mountProps.prompts);
    expect(serverDeps.context).toBe(mountProps.context);
    expect(serverDeps.waker).toBe(mountProps.waker);
    expect(mountProps.version).not.toBe("unknown");
    mountProps.store.flush();
    expect(mountProps.store.getSnapshot().monitor.control).toBe("paused");
    expect(mountProps.store.getSnapshot().executor.control).toBe("paused");
    const asRecord = (value: unknown): Record<string, unknown> =>
      value as Record<string, unknown>;
    const monitorReporter = asRecord(mocks.runMonitorLoop.mock.calls[0]?.[3]);
    const executorReporter = asRecord(mocks.runExecutorLoop.mock.calls[0]?.[3]);
    const monitor = asRecord(mountProps.store.monitor);
    const executor = asRecord(mountProps.store.executor);
    expect(monitorReporter.cycleStarted).toBe(monitor.cycleStarted);
    expect(monitorReporter.session).not.toBe(monitor.session);
    expect(executorReporter.taskStarted).toBe(executor.taskStarted);
    expect(executorReporter.session).not.toBe(executor.session);
    expect(mocks.dashboardUnmount).toHaveBeenCalledTimes(1);
    expect(mocks.dashboardWaitUntilExit).toHaveBeenCalledTimes(1);
  });

  it("loop error: unmounts the dashboard, logs and sets exitCode=1", async () => {
    process.stdin.isTTY = true;
    process.stdout.isTTY = true;
    stubHappyPath(buildConfig({ cwd: dir }));
    mocks.runMonitorLoop.mockRejectedValue(new Error("loop failure"));

    await runStart();

    expect(mocks.dashboardUnmount).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith("loop failure");
    expect(process.exitCode).toBe(1);
  });

  it("preflight error: logs, sets exitCode=1 and does not start the loops", async () => {
    mocks.ensureReady.mockRejectedValue(new Error("Preflight failed"));

    await runStart();

    expect(logger.error).toHaveBeenCalledWith("Preflight failed");
    expect(process.exitCode).toBe(1);
    expect(mocks.loadWorkerConfig).not.toHaveBeenCalled();
    expect(mocks.runMonitorLoop).not.toHaveBeenCalled();
    expect(mocks.runExecutorLoop).not.toHaveBeenCalled();
  });

  it("config loading error: logs, sets exitCode=1 and does not start the loops", async () => {
    mocks.ensureReady.mockResolvedValue(preflightResult(dir));
    mocks.loadWorkerConfig.mockRejectedValue(
      new Error("Invalid configuration (.kikimora/settings.json)"),
    );

    await runStart();

    expect(logger.error).toHaveBeenCalledWith(
      "Invalid configuration (.kikimora/settings.json)",
    );
    expect(process.exitCode).toBe(1);
    expect(mocks.runMonitorLoop).not.toHaveBeenCalled();
  });

  it("corrupted task store: logs, sets exitCode=1 and does not start the loops", async () => {
    mocks.ensureReady.mockResolvedValue(preflightResult(dir));
    mocks.loadWorkerConfig.mockResolvedValue(buildConfig({ cwd: dir }));
    mocks.taskStoreOpen.mockRejectedValue(new Error("Corrupted task store file (x)"));

    await runStart();

    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("Corrupted task store file"),
    );
    expect(process.exitCode).toBe(1);
    expect(mocks.runMonitorLoop).not.toHaveBeenCalled();
    expect(mocks.runExecutorLoop).not.toHaveBeenCalled();
  });
});
