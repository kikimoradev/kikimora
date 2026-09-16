import { chmod, mkdir, unlink } from "node:fs/promises";
import { connect, createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";
import type { ContextFileAccess } from "./context-file.js";
import type { AgentController } from "./control.js";
import {
  buildDrainAck,
  parseControlRequest,
  type ControlRequest,
  type ControlResponse,
  type ControlStatus,
  type ControlTarget,
  type WorkerIdentity,
} from "./control-protocol.js";
import type { DrainController } from "./drain.js";
import { CONTROL_SOCKET_ENV } from "./paths.js";
import type { PromptAgent, PromptFileAccess } from "./prompt-files.js";
import type { SettingsController } from "./settings-controller.js";
import { buildManualTask } from "./tasks.js";
import type { NewTask } from "./types.js";
import type { Waker } from "./waker.js";
import type { MemoryReader, SessionReader, TaskControls } from "./worker-controls.js";

const CONNECTION_TIMEOUT_MS = 5_000;
const MAX_REQUEST_BYTES = 1_048_576;
const REQUEST_TOO_LARGE = "Control request too large.";
export const RESUME_WHILE_DRAINING =
  "The worker is draining — it exits after the current session and cannot resume.";

export class AlreadyRunningError extends Error {
  constructor(pid: number | undefined) {
    super(
      pid === undefined
        ? "brownie is already running in this project."
        : `brownie is already running in this project (pid ${String(pid)}).`,
    );
    this.name = "AlreadyRunningError";
  }
}

export interface ControlServerDeps {
  socketPath: string;
  identity: WorkerIdentity;
  buildStatus(): ControlStatus;
  controls: {
    monitor: Pick<AgentController, "pause" | "resume">;
    executor: Pick<AgentController, "pause" | "resume">;
  };
  drain: Pick<DrainController, "request" | "snapshot">;
  tasks: TaskControls;
  memory: MemoryReader;
  sessions: SessionReader;
  settings: Pick<SettingsController, "current" | "patch">;
  prompts: PromptFileAccess;
  context: ContextFileAccess;
  waker: Pick<Waker, "notify">;
  signal: AbortSignal;
}

export interface ControlServerHandle {
  close(): Promise<void>;
}

interface WorkerProbe {
  running: boolean;
  pid?: number | undefined;
}

function probeExistingWorker(socketPath: string): Promise<WorkerProbe> {
  return new Promise((resolve) => {
    const socket = connect(socketPath);
    let buffer = "";
    let connected = false;
    const finish = (pid?: number): void => {
      socket.destroy();
      resolve({ running: connected, pid });
    };
    socket.setTimeout(CONNECTION_TIMEOUT_MS, () => {
      finish();
    });
    socket.on("error", () => {
      finish();
    });
    socket.on("close", () => {
      finish();
    });
    socket.on("connect", () => {
      connected = true;
      socket.write(`${JSON.stringify({ cmd: "status" })}\n`);
    });
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      try {
        const response = JSON.parse(
          buffer.slice(0, newline),
        ) as ControlResponse<"status">;
        finish(response.ok ? response.data.pid : undefined);
      } catch {
        finish();
      }
    });
  });
}

function applyControl(
  deps: ControlServerDeps,
  action: "pause" | "resume",
  target: ControlTarget,
): void {
  const agents =
    target === "all" ? (["monitor", "executor"] as const) : ([target] as const);
  for (const agent of agents) deps.controls[agent][action]();
}

function isMissingFile(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

async function readPrompt(deps: ControlServerDeps, agent: PromptAgent): Promise<string> {
  try {
    return await deps.prompts.read(agent);
  } catch (error) {
    if (isMissingFile(error)) {
      throw new Error(`Prompt file for ${agent} is missing — run brownie init.`, {
        cause: error,
      });
    }
    throw error;
  }
}

async function addTask(
  deps: ControlServerDeps,
  request: Extract<ControlRequest, { cmd: "tasks.add" }>,
): Promise<ControlResponse<"tasks.add">> {
  const base = buildManualTask(request.description);
  const candidate: NewTask = {
    id: request.id ?? base.id,
    title: request.title ?? base.title,
    description: request.description,
  };
  const [added] = await deps.tasks.addTasks([candidate]);
  if (added === undefined) {
    return { ok: false, error: `Task "${candidate.id}" already exists.` };
  }
  deps.waker.notify();
  return { ok: true, data: added };
}

async function handleRequest(
  deps: ControlServerDeps,
  request: ControlRequest,
): Promise<ControlResponse> {
  switch (request.cmd) {
    case "status":
      return { ok: true, data: deps.buildStatus() };
    case "version":
      return { ok: true, data: deps.identity };
    case "pause":
      applyControl(deps, request.cmd, request.agent);
      return { ok: true, data: undefined };
    case "resume":
      if (deps.drain.snapshot !== undefined) {
        return { ok: false, error: RESUME_WHILE_DRAINING };
      }
      applyControl(deps, request.cmd, request.agent);
      return { ok: true, data: undefined };
    case "drain":
      return {
        ok: true,
        data: buildDrainAck(deps.drain.request("drain", request.timeoutMs)),
      };
    case "settings.get":
      return { ok: true, data: await deps.settings.current() };
    case "settings.patch":
      return { ok: true, data: await deps.settings.patch(request.patch) };
    case "tasks.list": {
      const tasks = deps.tasks.list();
      const { status } = request;
      return {
        ok: true,
        data:
          status === undefined ? tasks : tasks.filter((task) => task.status === status),
      };
    }
    case "tasks.add":
      return addTask(deps, request);
    case "tasks.retry": {
      const retried = await deps.tasks.retry(request.id);
      if (retried) deps.waker.notify();
      return { ok: true, data: retried };
    }
    case "tasks.cancel":
      return { ok: true, data: await deps.tasks.cancel(request.id) };
    case "memory.search":
      return { ok: true, data: deps.memory.search(request.query, request.limit) };
    case "memory.recent":
      return { ok: true, data: deps.memory.recent(request.limit) };
    case "prompt.get":
      return {
        ok: true,
        data: { agent: request.agent, content: await readPrompt(deps, request.agent) },
      };
    case "prompt.set":
      await deps.prompts.write(request.agent, request.content);
      return { ok: true, data: undefined };
    case "context.get":
      return { ok: true, data: { content: await deps.context.read() } };
    case "context.set":
      await deps.context.write(request.content);
      return { ok: true, data: undefined };
    case "sessions.list":
      return {
        ok: true,
        data: deps.sessions.list({
          agent: request.agent,
          taskId: request.taskId,
          before: request.before,
          limit: request.limit,
        }),
      };
    case "sessions.get": {
      const session = deps.sessions.get(request.sessionId);
      return session === undefined
        ? { ok: false, error: `Session "${request.sessionId}" is not indexed.` }
        : { ok: true, data: session };
    }
  }
}

async function respond(deps: ControlServerDeps, line: string): Promise<ControlResponse> {
  const parsed = parseControlRequest(line);
  if (!parsed.ok) return parsed;
  try {
    return await handleRequest(deps, parsed.request);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function serveConnection(deps: ControlServerDeps, socket: Socket): void {
  let buffer = "";
  let handled = false;
  const reply = (response: ControlResponse): void => {
    if (socket.destroyed) return;
    socket.end(`${JSON.stringify(response)}\n`);
  };
  socket.setTimeout(CONNECTION_TIMEOUT_MS, () => {
    socket.destroy();
  });
  socket.on("error", () => {
    socket.destroy();
  });
  socket.on("data", (chunk) => {
    if (handled) return;
    buffer += chunk.toString("utf8");
    if (Buffer.byteLength(buffer, "utf8") > MAX_REQUEST_BYTES) {
      handled = true;
      reply({ ok: false, error: REQUEST_TOO_LARGE });
      return;
    }
    const newline = buffer.indexOf("\n");
    if (newline === -1) return;
    handled = true;
    void respond(deps, buffer.slice(0, newline)).then(reply);
  });
}

async function removeStaleSocket(socketPath: string): Promise<void> {
  if (process.platform === "win32") return;
  await unlink(socketPath).catch(() => undefined);
}

async function ensureSocketDirectory(socketPath: string): Promise<void> {
  if (process.platform === "win32") return;
  await mkdir(dirname(socketPath), { recursive: true }).catch(() => undefined);
}

function describeListenError(socketPath: string, error: Error): Error {
  return new Error(
    `Cannot open the control socket ${socketPath} (${error.message}) — check that its directory exists and is writable, or point ${CONTROL_SOCKET_ENV} elsewhere.`,
  );
}

export async function startControlServer(
  deps: ControlServerDeps,
): Promise<ControlServerHandle> {
  const existing = await probeExistingWorker(deps.socketPath);
  if (existing.running) throw new AlreadyRunningError(existing.pid);
  await removeStaleSocket(deps.socketPath);

  const server: Server = createServer((socket) => {
    serveConnection(deps, socket);
  });

  await ensureSocketDirectory(deps.socketPath);
  await new Promise<void>((resolve, reject) => {
    server.once("error", (error) => {
      reject(describeListenError(deps.socketPath, error));
    });
    server.listen(deps.socketPath, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  if (process.platform !== "win32") {
    await chmod(deps.socketPath, 0o600).catch(() => undefined);
  }

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
    await removeStaleSocket(deps.socketPath);
  };

  deps.signal.addEventListener("abort", () => void close(), { once: true });

  return { close };
}
