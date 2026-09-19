import { EventEmitter } from "node:events";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { vi } from "vitest";
import { AuthGate } from "../src/auth-gate.js";
import { AgentController, type AgentControlState } from "../src/control.js";
import type { LoopGates } from "../src/gates.js";
import type { TaskSummarizer } from "../src/memory/summarizer.js";
import type { SessionSpec } from "../src/runner.js";
import type { SessionEvent, SessionEventSink } from "../src/session-events.js";
import type { ExecutorReporter, MonitorReporter } from "../src/status.js";
import type {
  AgentConfig,
  ExecutorConfig,
  MonitorConfig,
  SessionResult,
  SummarizerConfig,
  WorkerConfig,
} from "../src/types.js";
import { UsageLimitGate } from "../src/usage-limit.js";

export function createTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "claude-worker-test-"));
}

export function removeTempDir(dir: string): Promise<void> {
  return rm(dir, { recursive: true, force: true });
}

export const fixturesDir = fileURLToPath(new URL("./fixtures", import.meta.url));
export const fakeClaudePath = join(fixturesDir, "claude");

export function snapshotEnv(): () => void {
  const saved = { ...process.env };
  return () => {
    for (const key of Object.keys(process.env)) {
      if (!(key in saved)) delete process.env[key];
    }
    Object.assign(process.env, saved);
  };
}

export interface SeedProjectOptions {
  settings?: object | string | false;
  monitorPrompt?: string;
  executorPrompt?: string;
  context?: string;
}

export async function seedProject(
  dir: string,
  options: SeedProjectOptions = {},
): Promise<void> {
  const {
    settings = {},
    monitorPrompt = "observe\n",
    executorPrompt = "execute\n",
    context,
  } = options;
  const promptsDir = join(dir, ".kikimora", "prompts");
  await mkdir(promptsDir, { recursive: true });
  await writeFile(join(promptsDir, "monitor.prompt.md"), monitorPrompt, "utf8");
  await writeFile(join(promptsDir, "executor.prompt.md"), executorPrompt, "utf8");
  if (context !== undefined) {
    await writeFile(join(promptsDir, "context.md"), context, "utf8");
  }
  if (settings !== false) {
    const raw =
      typeof settings === "string" ? settings : `${JSON.stringify(settings, null, 2)}\n`;
    await writeFile(join(dir, ".kikimora", "settings.json"), raw, "utf8");
  }
}

export async function seedSystemPrompts(dir: string): Promise<string> {
  const systemDir = join(dir, "system-prompts");
  await mkdir(systemDir, { recursive: true });
  await writeFile(join(systemDir, "monitor.system.md"), "monitor system\n", "utf8");
  await writeFile(join(systemDir, "executor.system.md"), "executor system\n", "utf8");
  await writeFile(join(systemDir, "summarizer.system.md"), "summarizer system\n", "utf8");
  return systemDir;
}

export async function writeExecutable(
  dir: string,
  name: string,
  body: string,
): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, `#!/usr/bin/env node\n${body}`, "utf8");
  await chmod(path, 0o755);
  return path;
}

export function pathEnv(
  binDir: string,
  extra: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
    ...extra,
  };
}

export function fakeClaudeEnv(
  mode: string,
  extra: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  return { ...process.env, FAKE_CLAUDE_MODE: mode, ...extra };
}

export function fakeClaudeCliEnv(
  mode: string,
  extra: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: `${fixturesDir}${delimiter}${process.env.PATH ?? ""}`,
    FAKE_CLAUDE_MODE: mode,
    ...extra,
  };
}

class FakeStdin extends EventEmitter {
  isTTY = true;
  private data: string | null = null;

  constructor() {
    super();
    this.on("newListener", (eventName: string) => {
      if (eventName === "readable" && this.data !== null) {
        queueMicrotask(() => this.emit("readable"));
      }
    });
  }

  write(data: string): void {
    this.data = this.data === null ? data : this.data + data;
    this.emit("readable");
    this.emit("data", data);
  }

  read(): string | null {
    const { data } = this;
    this.data = null;
    return data;
  }

  setEncoding = (): undefined => undefined;
  setRawMode = (): undefined => undefined;
  resume = (): undefined => undefined;
  pause = (): undefined => undefined;
  ref = (): undefined => undefined;
  unref = (): undefined => undefined;
}

class FakeStdout extends EventEmitter {
  readonly columns = 100;

  readonly isTTY = true;

  frames: string[] = [];

  write = (frame: string): void => {
    this.frames.push(frame);
  };

  lastFrame(): string | undefined {
    for (let index = this.frames.length - 1; index >= 0; index -= 1) {
      const frame = this.frames[index];
      if (frame?.includes("\n") === true) return frame;
    }
    return undefined;
  }
}

export interface FakeStdio {
  stdin: NodeJS.ReadStream;
  stdout: NodeJS.WriteStream;
  type(data: string): void;
  lastFrame(): string | undefined;
  inputReady(): Promise<void>;
}

export function fakeStdio(): FakeStdio {
  const stdin = new FakeStdin();
  const stdout = new FakeStdout();
  return {
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
    type: (data) => {
      stdin.write(data);
    },
    lastFrame: () => stdout.lastFrame(),
    inputReady: () => inputReady(stdin),
  };
}

export function eventually(assertion: () => void): Promise<void> {
  return vi.waitFor(assertion, 10_000);
}

export function inputReady(stdin: {
  listenerCount(eventName: string): number;
}): Promise<void> {
  return eventually(() => {
    if (stdin.listenerCount("readable") === 0 && stdin.listenerCount("data") === 0) {
      throw new Error("input is not attached yet");
    }
  });
}

interface BufferingStdin {
  data: string | null;
  write(data: string): void;
  emit(eventName: string): boolean;
  on(eventName: string, listener: (eventName: string) => void): unknown;
}

export function makeStdinLossless(stdin: object): void {
  const target = stdin as BufferingStdin;
  const write = target.write.bind(target);
  target.write = (data: string) => {
    const pending = target.data;
    write(pending == null ? data : pending + data);
  };
  target.on("newListener", (eventName) => {
    if (eventName === "readable" && target.data != null) {
      queueMicrotask(() => target.emit("readable"));
    }
  });
}

export function loggerModuleMock(): Record<string, unknown> {
  const shared = {
    info: vi.fn(),
    log: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
    start: vi.fn(),
  };
  return { logger: shared };
}

export interface SessionEventCollector {
  events: SessionEvent[];
  sink: SessionEventSink;
}

export function createSessionEventCollector(): SessionEventCollector {
  const events: SessionEvent[] = [];
  return {
    events,
    sink: (event) => {
      events.push(event);
    },
  };
}

export interface MonitorReporterSpy {
  reporter: MonitorReporter;
  offHours: ReturnType<typeof vi.fn>;
  usageLimit: ReturnType<typeof vi.fn>;
  authBlocked: ReturnType<typeof vi.fn>;
  cycleStarted: ReturnType<typeof vi.fn>;
  cycleFinished: ReturnType<typeof vi.fn>;
  sleepUntil: ReturnType<typeof vi.fn>;
  session: ReturnType<typeof vi.fn>;
}

export function createMonitorReporterSpy(): MonitorReporterSpy {
  const spies = {
    offHours: vi.fn(),
    usageLimit: vi.fn(),
    authBlocked: vi.fn(),
    cycleStarted: vi.fn(),
    cycleFinished: vi.fn(),
    sleepUntil: vi.fn(),
    session: vi.fn(),
  };
  return { ...spies, reporter: spies };
}

export interface ExecutorReporterSpy {
  reporter: ExecutorReporter;
  taskStarted: ReturnType<typeof vi.fn>;
  taskFinished: ReturnType<typeof vi.fn>;
  retryScheduled: ReturnType<typeof vi.fn>;
  usageLimit: ReturnType<typeof vi.fn>;
  authBlocked: ReturnType<typeof vi.fn>;
  waiting: ReturnType<typeof vi.fn>;
  summaryStarted: ReturnType<typeof vi.fn>;
  summaryFinished: ReturnType<typeof vi.fn>;
  session: ReturnType<typeof vi.fn>;
}

export function createExecutorReporterSpy(): ExecutorReporterSpy {
  const spies = {
    taskStarted: vi.fn(),
    taskFinished: vi.fn(),
    retryScheduled: vi.fn(),
    usageLimit: vi.fn(),
    authBlocked: vi.fn(),
    waiting: vi.fn(),
    summaryStarted: vi.fn(),
    summaryFinished: vi.fn(),
    session: vi.fn(),
  };
  return { ...spies, reporter: spies };
}

export interface TaskSummarizerSpy {
  summarizer: TaskSummarizer;
  summarize: ReturnType<typeof vi.fn>;
}

export function createTaskSummarizerSpy(): TaskSummarizerSpy {
  const summarize = vi.fn().mockResolvedValue(undefined);
  return { summarize, summarizer: { summarize } };
}

export function noopController(): AgentController {
  return new AgentController(() => undefined);
}

export function buildGates(overrides: Partial<LoopGates> = {}): LoopGates {
  return { limit: new UsageLimitGate(), auth: new AuthGate(), ...overrides };
}

export interface AuthGateHarness {
  gates: LoopGates;
  controller: AgentController;
  partner: AgentController;
}

export function authGateHarness(): AuthGateHarness {
  const controllers: AgentController[] = [];
  const gates = buildGates({
    auth: new AuthGate(() => {
      for (const controller of controllers) controller.pause();
    }),
  });
  const clearOnResume = (state: AgentControlState): void => {
    if (state === "running") gates.auth.clear();
  };
  const controller = new AgentController(clearOnResume);
  const partner = new AgentController(clearOnResume);
  controllers.push(controller, partner);
  return { gates, controller, partner };
}

export function authFailureResult(overrides: Partial<SessionResult> = {}): SessionResult {
  return {
    ok: false,
    durationMs: 10,
    failureReason: "isError",
    error: "Session ended with an error (is_error)",
    resultText: "Not logged in · Please run /login",
    terminalReason: "api_error",
    ...overrides,
  };
}

export const testDataDir = join(tmpdir(), `kikimora-test-data-${String(process.pid)}`);

export function buildAgentConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    model: "haiku",
    effort: "medium",
    promptPath: "/dev/null",
    systemPromptPath: "/dev/null",
    sessionTimeoutMs: undefined,
    mcpServers: [],
    ...overrides,
  };
}

export function buildMonitorConfig(
  overrides: Partial<MonitorConfig> = {},
): MonitorConfig {
  return {
    ...buildAgentConfig(),
    intervalMs: 300_000,
    schedule: null,
    ...overrides,
  };
}

export function buildExecutorConfig(
  overrides: Partial<ExecutorConfig> = {},
): ExecutorConfig {
  return {
    ...buildAgentConfig({ model: "opus", effort: "high" }),
    maxTaskAttempts: 3,
    retryDelayMs: 0,
    ...overrides,
  };
}

export function buildSummarizerConfig(
  overrides: Partial<SummarizerConfig> = {},
): SummarizerConfig {
  return {
    model: "haiku",
    effort: "low",
    systemPromptPath: "/dev/null",
    sessionTimeoutMs: undefined,
    ...overrides,
  };
}

export function buildConfig(overrides: Partial<WorkerConfig> = {}): WorkerConfig {
  return {
    command: fakeClaudePath,
    monitor: buildMonitorConfig(),
    executor: buildExecutorConfig(),
    summarizer: buildSummarizerConfig(),
    streamPartial: false,
    browser: false,
    shutdownGraceMs: 0,
    mcpServers: {},
    cwd: process.cwd(),
    settingsFilePath: join(process.cwd(), ".kikimora", "settings.json"),
    contextFilePath: join(process.cwd(), ".kikimora", "prompts", "context.md"),
    tasksFilePath: join(process.cwd(), ".kikimora", "data", "tasks.json"),
    memoryDbPath: join(process.cwd(), ".kikimora", "data", "memory.db"),
    dataDir: testDataDir,
    playwrightOutputDir: join(testDataDir, "playwright"),
    logsDir: join(process.cwd(), ".kikimora", "logs"),
    ...overrides,
  };
}

export function buildSessionSpec(
  events: SessionEventSink,
  overrides: Partial<SessionSpec> = {},
): SessionSpec {
  return {
    command: fakeClaudePath,
    model: "haiku",
    effort: "medium",
    systemPrompt: "system\n",
    prompt: "task\n",
    sessionTimeoutMs: undefined,
    streamPartial: false,
    mcpConfigPath: join(testDataDir, "mcp", "session.json"),
    cwd: process.cwd(),
    events,
    meta: { agent: "monitor" },
    ...overrides,
  };
}
