import { readFile } from "node:fs/promises";
import { detectAuthFailure } from "./auth-gate.js";
import { createContextFileAccess } from "./context-file.js";
import type { AgentController } from "./control.js";
import type { LoopGates } from "./gates.js";
import { writeMcpConfig } from "./mcp-config.js";
import type { TaskSummarizer } from "./memory/summarizer.js";
import { composePrompt } from "./prompt-compose.js";
import { runSession } from "./runner.js";
import type { SessionRecorder } from "./sessions/index.js";
import type { ExecutorReporter } from "./status.js";
import type { TaskStore } from "./tasks.js";
import type { SessionResult, Task, WorkerConfig } from "./types.js";
import { detectUsageLimit } from "./usage-limit.js";
import type { Waker } from "./waker.js";

const TRANSIENT_RESULT_PATTERN =
  /API Error|Connection (closed|error|reset)|ECONNRESET|ETIMEDOUT|ENOTFOUND|EPIPE|socket hang up|overloaded|rate.?limit|Request timed out/i;

export function isTransientFailure(result: SessionResult): boolean {
  if (result.failureReason === "timeout") return true;
  if (result.failureReason !== "isError") return false;
  return TRANSIENT_RESULT_PATTERN.test(result.resultText ?? "");
}

export function composeTaskPrompt(prompt: string, task: Task): string {
  return `${prompt.trimEnd()}

## Task to complete

ID: ${task.id}
Title: ${task.title}
Description:
${task.description}
`;
}

export async function runExecutorLoop(
  config: WorkerConfig,
  store: TaskStore,
  waker: Waker,
  reporter: ExecutorReporter,
  summarizer: TaskSummarizer,
  controller: AgentController,
  gates: LoopGates,
  signal: AbortSignal,
  sessions?: SessionRecorder,
): Promise<void> {
  const { executor } = config;
  const contextFile = createContextFileAccess(config.contextFilePath);
  const aborted = (): boolean => signal.aborted;

  while (!aborted()) {
    const authBlock = gates.auth.blocked;
    if (authBlock !== null) reporter.authBlocked(authBlock);
    await controller.gate(signal);
    if (aborted()) break;

    const limitWaitMs = gates.limit.msRemaining(Date.now());
    if (limitWaitMs > 0) {
      reporter.usageLimit(new Date(Date.now() + limitWaitMs));
      await controller.sleep(limitWaitMs, signal);
      continue;
    }

    const task = await store.takeNext();
    if (!task) {
      reporter.waiting();
      await Promise.race([waker.wait(signal), controller.pauseRequested(signal)]);
      continue;
    }

    const start = Date.now();
    const sessionInputs = Promise.all([
      readFile(executor.promptPath, "utf8"),
      readFile(executor.systemPromptPath, "utf8"),
      contextFile.read(),
      writeMcpConfig(config.dataDir, {
        role: "executor",
        servers: config.mcpServers,
        selected: executor.mcpServers,
        browser: config.browser,
        memoryDbPath: config.memoryDbPath,
        playwrightOutputDir: config.playwrightOutputDir,
      }),
    ]);
    await sessionInputs.catch(() => undefined);
    if (aborted()) break;
    if (controller.state !== "running") {
      await store.release(task.id);
      continue;
    }

    reporter.taskStarted(task);

    try {
      const [prompt, systemPrompt, context, mcpConfigPath] = await sessionInputs;

      const result = await runSession(
        {
          command: config.command,
          model: executor.model,
          effort: executor.effort,
          systemPrompt,
          prompt: composeTaskPrompt(composePrompt(prompt, context), task),
          sessionTimeoutMs: executor.sessionTimeoutMs,
          streamPartial: config.streamPartial,
          mcpConfigPath,
          cwd: config.cwd,
          events: reporter.session,
          meta: { agent: "executor", taskId: task.id },
          index: sessions,
        },
        signal,
      );

      if (aborted()) break;

      if (result.ok) {
        await store.complete(task.id);
        reporter.taskFinished({
          taskId: task.id,
          title: task.title,
          ok: true,
          durationMs: result.durationMs,
          costUsd: result.costUsd,
          numTurns: result.numTurns,
          sessionId: result.sessionId,
        });
        await summarizer
          .summarize(task, result, { willRetry: false }, signal)
          .catch(() => undefined);
      } else {
        const error = result.error ?? "unknown error";
        const auth = detectAuthFailure(result);
        if (auth) {
          gates.auth.engage(auth);
          await store.release(task.id, "authentication failed");
          reporter.taskFinished({
            taskId: task.id,
            title: task.title,
            ok: false,
            durationMs: result.durationMs,
            costUsd: result.costUsd,
            numTurns: result.numTurns,
            error: "authentication failed — task requeued",
            willRetry: true,
            sessionId: result.sessionId,
          });
          continue;
        }
        const limit = detectUsageLimit(result);
        if (limit) {
          gates.limit.engage(limit, Date.now());
          await store.release(task.id, "usage limit reached");
          reporter.taskFinished({
            taskId: task.id,
            title: task.title,
            ok: false,
            durationMs: result.durationMs,
            costUsd: result.costUsd,
            numTurns: result.numTurns,
            error: "usage limit reached — task requeued",
            willRetry: true,
            sessionId: result.sessionId,
          });
          continue;
        }
        const willRetry =
          isTransientFailure(result) && task.attempts < executor.maxTaskAttempts;
        if (willRetry) {
          await store.requeue(task.id, error);
        } else {
          await store.fail(task.id, error);
        }
        reporter.taskFinished({
          taskId: task.id,
          title: task.title,
          ok: false,
          durationMs: result.durationMs,
          costUsd: result.costUsd,
          numTurns: result.numTurns,
          error,
          willRetry,
          attempt: task.attempts,
          maxAttempts: executor.maxTaskAttempts,
          sessionId: result.sessionId,
        });
        await summarizer
          .summarize(task, result, { willRetry }, signal)
          .catch(() => undefined);
        if (willRetry && executor.retryDelayMs > 0) {
          reporter.retryScheduled(task, new Date(Date.now() + executor.retryDelayMs));
          await controller.sleep(executor.retryDelayMs, signal);
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await store.fail(task.id, message);
      reporter.taskFinished({
        taskId: task.id,
        title: task.title,
        ok: false,
        durationMs: Date.now() - start,
        error: message,
      });
    }
  }
}
