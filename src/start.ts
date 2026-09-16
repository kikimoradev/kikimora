import { join, relative } from "node:path";
import { AuthGate } from "./auth-gate.js";
import { loadWorkerConfig } from "./config.js";
import { createContextFileAccess } from "./context-file.js";
import { buildControlStatus } from "./control-protocol.js";
import { startControlServer } from "./control-server.js";
import { AgentController } from "./control.js";
import { DrainController } from "./drain.js";
import { runExecutorLoop } from "./executor.js";
import type { LoopGates } from "./gates.js";
import { loadGlobalConfig } from "./global-config.js";
import { compactFields } from "./headless/events.js";
import type { HeadlessLogFormat } from "./headless/format.js";
import { createHeadlessReporters } from "./headless/reporters.js";
import { createHeadlessSink } from "./headless/sink.js";
import { teeReporter } from "./headless/tee.js";
import { logger } from "./logger.js";
import { MemoryStore } from "./memory/store.js";
import { SessionSummarizer } from "./memory/summarizer.js";
import { runMonitorLoop } from "./monitor.js";
import { controlSocketPath, packageVersion, projectPaths } from "./paths.js";
import { ensureReady } from "./preflight.js";
import { createPromptFileAccess } from "./prompt-files.js";
import { SessionLog, teeSession } from "./session-log.js";
import { SessionIndex, type SessionRecorder } from "./sessions/index.js";
import { createSettingsController } from "./settings-controller.js";
import { abortOnSignals } from "./shutdown.js";
import { WorkerStatusStore } from "./status.js";
import { TaskStore } from "./tasks.js";
import { runAutoUpdateLoop } from "./update/auto-update.js";
import { defaultUpdateDeps } from "./update/updater.js";
import { mountDashboard } from "./ui/mount.js";
import { UsageLimitGate } from "./usage-limit.js";
import { Waker } from "./waker.js";
import { buildWorkerIdentity } from "./worker-identity.js";

export interface StartWorkerOptions {
  headless?: boolean | undefined;
  logFormat?: HeadlessLogFormat | undefined;
  verbose?: boolean | undefined;
  paused?: boolean | undefined;
  stdout?: { write(chunk: string): unknown } | undefined;
}

export async function startWorker(options: StartWorkerOptions = {}): Promise<void> {
  let claude;
  let config;
  let store;
  let memory;
  try {
    const preflight = await ensureReady();
    claude = preflight.claude;
    config = await loadWorkerConfig({}, preflight.paths);
    store = await TaskStore.open(config.tasksFilePath);
    memory = MemoryStore.open(config.memoryDbPath);
  } catch (err) {
    logger.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
    return;
  }

  const sessions = SessionIndex.on(memory.connection);
  const brownieDir = projectPaths(config.cwd).brownieDir;
  const recordSessionsOf = (log: SessionLog): SessionRecorder => ({
    started: (session) => {
      const paths = log.pathsFor(session.sessionId);
      if (paths === undefined) return;
      sessions.started({
        ...session,
        logPath: relative(brownieDir, paths.log),
        jsonlPath: relative(brownieDir, paths.jsonl),
      });
    },
    finished: (session) => {
      sessions.finished(session);
    },
  });

  const status = new WorkerStatusStore();
  store.onChange((tasks) => status.setTasks(tasks));
  status.setTasks(store.list());
  const identity = buildWorkerIdentity({
    version: packageVersion(),
    claude,
    nodeVersion: process.versions.node,
    pid: process.pid,
    startedAt: status.getSnapshot().startedAt,
    projectDir: config.cwd,
  });

  const interactive =
    process.stdin.isTTY && process.stdout.isTTY && options.headless !== true;
  const headlessEmit = interactive
    ? null
    : createHeadlessSink({
        format: options.logFormat ?? "pretty",
        out: options.stdout ?? process.stdout,
      });
  const headlessReporters =
    headlessEmit === null
      ? null
      : createHeadlessReporters(headlessEmit, { verbose: options.verbose });

  let shutdownSignal: string | undefined;
  const drainFinished = new AbortController();
  const signal = AbortSignal.any([
    abortOnSignals((signalName) => {
      shutdownSignal = signalName;
      status.shutdownRequested(signalName);
    }),
    drainFinished.signal,
  ]);
  const waker = new Waker();
  const gates: LoopGates = {
    limit: new UsageLimitGate(),
    auth: new AuthGate(() => {
      monitorControl.pause();
      executorControl.pause();
    }),
  };
  const initialControlState =
    interactive || options.paused === true ? "paused" : "running";
  const monitorControl = new AgentController((state) => {
    if (state === "running") gates.auth.clear();
    status.setControl("monitor", state);
    headlessEmit?.({
      level: "info",
      agent: "monitor",
      event: "control.changed",
      fields: { state },
    });
    drain.noteSettled();
  }, initialControlState);
  const executorControl = new AgentController((state) => {
    if (state === "running") gates.auth.clear();
    status.setControl("executor", state);
    headlessEmit?.({
      level: "info",
      agent: "executor",
      event: "control.changed",
      fields: { state },
    });
    drain.noteSettled();
  }, initialControlState);
  const drain = new DrainController(
    { monitor: monitorControl, executor: executorControl },
    () => {
      drainFinished.abort();
    },
    (snapshot) => {
      status.drainRequested(snapshot);
      headlessEmit?.({
        level: "info",
        event: "worker.draining",
        fields: compactFields({
          reason: snapshot.reason,
          timeoutMs:
            snapshot.until === undefined ? undefined : snapshot.until - snapshot.since,
        }),
      });
    },
  );
  status.setControl("monitor", initialControlState);
  status.setControl("executor", initialControlState);

  const settings = createSettingsController({
    config,
    settingsFile: config.settingsFilePath,
  });
  const prompts = createPromptFileAccess({
    monitor: config.monitor.promptPath,
    executor: config.executor.promptPath,
  });
  const context = createContextFileAccess(config.contextFilePath);

  let controlServer;
  try {
    controlServer = await startControlServer({
      socketPath: controlSocketPath(config.cwd),
      identity,
      controls: { monitor: monitorControl, executor: executorControl },
      drain,
      tasks: store,
      memory,
      sessions,
      settings,
      prompts,
      context,
      waker,
      buildStatus: () => {
        status.flush();
        return buildControlStatus({
          snapshot: status.getSnapshot(),
          identity,
          headless: !interactive,
        });
      },
      signal,
    });
  } catch (err) {
    logger.error(err instanceof Error ? err.message : err);
    memory.close();
    status.dispose();
    process.exitCode = 1;
    return;
  }

  const dashboard = interactive
    ? mountDashboard({
        store: status,
        config,
        version: identity.version,
        controls: { monitor: monitorControl, executor: executorControl },
        drain,
        tasks: store,
        memory,
        settings,
        prompts,
        context,
        waker,
        requestExit: () => process.kill(process.pid, "SIGINT"),
      })
    : null;

  const monitorLog = new SessionLog(join(config.logsDir, "monitor"));
  const executorLog = new SessionLog(join(config.logsDir, "executor"));
  const summarizerLog = new SessionLog(join(config.logsDir, "summarizer"));

  const monitorReporter =
    headlessReporters === null
      ? status.monitor
      : teeReporter(status.monitor, headlessReporters.monitor);
  const executorReporter =
    headlessReporters === null
      ? status.executor
      : teeReporter(status.executor, headlessReporters.executor);
  const summaryReporter =
    headlessReporters === null
      ? status.executor
      : teeReporter(status.executor, headlessReporters.summarizer);

  const summarizer = new SessionSummarizer({
    command: config.command,
    summarizer: config.summarizer,
    streamPartial: config.streamPartial,
    cwd: config.cwd,
    dataDir: config.dataDir,
    playwrightOutputDir: config.playwrightOutputDir,
    store: memory,
    resolveLogPath: async (sessionId) => {
      await executorLog.flush();
      return executorLog.pathFor(sessionId);
    },
    reporter: teeSession(summaryReporter, summarizerLog.sink),
    gates,
    sessions: recordSessionsOf(summarizerLog),
  });

  headlessEmit?.({
    level: "info",
    event: "worker.started",
    fields: compactFields({
      version: identity.version,
      claudeVersion: identity.claudeVersion,
      nodeVersion: identity.nodeVersion,
      authKind: identity.authKind,
      pid: identity.pid,
      projectDir: identity.projectDir,
      paused: initialControlState === "paused" ? true : undefined,
    }),
  });

  const globalConfig = await loadGlobalConfig();

  let loopError: unknown;
  try {
    await Promise.all([
      runMonitorLoop(
        config,
        store,
        waker,
        teeSession(monitorReporter, monitorLog.sink),
        monitorControl,
        gates,
        signal,
        recordSessionsOf(monitorLog),
      ),
      runExecutorLoop(
        config,
        store,
        waker,
        teeSession(executorReporter, executorLog.sink),
        summarizer,
        executorControl,
        gates,
        signal,
        recordSessionsOf(executorLog),
      ),
      runAutoUpdateLoop({
        globalConfig,
        deps: defaultUpdateDeps(),
        setUpdateStatus: (info) => status.setUpdateStatus(info),
        emit: headlessEmit,
        signal,
      }),
    ]);
  } catch (err) {
    loopError = err;
  } finally {
    drain.dispose();
    await controlServer.close();
    await Promise.all([monitorLog.close(), executorLog.close(), summarizerLog.close()]);
    dashboard?.unmount();
    await dashboard?.waitUntilExit();
    const drained = drain.snapshot !== undefined;
    headlessEmit?.({
      level: "info",
      event: "worker.stopped",
      fields: compactFields({
        signal: shutdownSignal,
        drained: drained ? true : undefined,
        forced: drained && !drain.settled ? true : undefined,
      }),
    });
    memory.close();
    status.dispose();
  }

  if (loopError !== undefined) {
    logger.error(loopError instanceof Error ? loopError.message : loopError);
    process.exitCode = 1;
  }
}
