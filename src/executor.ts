import { readFile } from "node:fs/promises";
import { detectAuthFailure } from "./auth-gate.js";
import { createContextFileAccess } from "./context-file.js";
import type { AgentController } from "./control.js";
import type { LoopGates } from "./gates.js";
import { writeMcpConfig } from "./mcp-config.js";
import type { TaskSummarizer } from "./memory/summarizer.js";
import { composePrompt } from "./prompt-compose.js";
import { runSession } from "./runner.js";
import { LAUNCHER_REFUSAL_BACKOFF_MS } from "./session-launcher.js";
import type { SessionRecorder } from "./sessions/index.js";
import type { ExecutorReporter } from "./status.js";
import type { TaskStore } from "./tasks.js";
import type {
  SessionFailureReason,
  SessionResult,
  Task,
  TaskResume,
  WorkerConfig,
} from "./types.js";
import { formatUptime } from "./units.js";
import { detectUsageLimit } from "./usage-limit.js";
import type { Waker } from "./waker.js";

const TRANSIENT_RESULT_PATTERN =
  /API Error|Connection (closed|error|reset)|ECONNRESET|ETIMEDOUT|ENOTFOUND|EPIPE|socket hang up|overloaded|rate.?limit|Request timed out/i;

const TRANSIENT_FAILURE_REASONS: ReadonlySet<SessionFailureReason | undefined> = new Set([
  "timeout",
  "launcherRefused",
  "poolMemoryLimit",
]);

export function isTransientFailure(result: SessionResult): boolean {
  if (TRANSIENT_FAILURE_REASONS.has(result.failureReason)) return true;
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

export function composeResumePrompt(task: Task, resume: TaskResume, now: Date): string {
  const waitedMs = now.getTime() - Date.parse(resume.limitedAt);
  return `## Session resumed

The Claude usage limit stopped this session at ${resume.limitedAt}. Kikimora waited ${formatUptime(waitedMs)} for the limit to reset and resumed the session at ${now.toISOString()}.

The repository, the issue tracker, the pull request, /tmp and other files outside the workspace may have changed during the wait, and subagents the limit stopped did not finish. Re-check the state your next step depends on before you act.

Continue task ${task.id} where you left off.
`;
}

export function attemptCostUsd(
  result: SessionResult,
  resume: TaskResume | undefined,
): number | undefined {
  if (result.costUsd === undefined || resume?.costUsd === undefined) {
    return result.costUsd;
  }
  return Math.max(0, result.costUsd - resume.costUsd);
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
  const readyAfterAdmission = (): boolean =>
    controller.state === "running" &&
    gates.auth.blocked === null &&
    gates.limit.msRemaining(Date.now()) === 0;

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

    const next = store.peekNext();
    if (!next) {
      reporter.waiting();
      await Promise.race([waker.wait(signal), controller.pauseRequested(signal)]);
      continue;
    }

    const lease = await gates.admission.acquire("executor", {
      signal,
      interrupted: (until) => controller.pauseRequested(AbortSignal.any([signal, until])),
      taskId: next.id,
      onWait: (wait) => {
        reporter.admissionWait(wait, next);
      },
    });
    if (lease === null) continue;

    let backoff: { task: Task; resumeAt: Date } | undefined;
    try {
      if (aborted()) break;
      if (!readyAfterAdmission()) continue;
      const task = await store.takeNext();
      if (!task) continue;

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
            launcher: config.launcher,
            placement: { pool: "executor", lease },
            model: executor.model,
            effort: executor.effort,
            systemPrompt,
            prompt:
              task.resume === undefined
                ? composeTaskPrompt(composePrompt(prompt, context), task)
                : composeResumePrompt(task, task.resume, new Date()),
            resume: task.resume?.sessionId,
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

        if (result.failureReason === "resumeFailed") {
          await store.forgetResume(task.id, "session could not be resumed");
          reporter.taskFinished({
            taskId: task.id,
            title: task.title,
            ok: false,
            durationMs: result.durationMs,
            error: "session could not be resumed — task requeued for a fresh session",
            failureReason: result.failureReason,
            willRetry: true,
            sessionId: result.sessionId,
          });
          continue;
        }

        const costUsd = attemptCostUsd(result, task.resume);
        if (result.ok) {
          await store.complete(task.id);
          reporter.taskFinished({
            taskId: task.id,
            title: task.title,
            ok: true,
            durationMs: result.durationMs,
            costUsd,
            numTurns: result.numTurns,
            sessionId: result.sessionId,
          });
          await summarizer
            .summarize(task, result, { willRetry: false, lease }, signal)
            .catch(() => undefined);
        } else if (result.failureReason === "launcherRefused") {
          await store.release(task.id, "session launcher refused the session");
          reporter.taskFinished({
            taskId: task.id,
            title: task.title,
            ok: false,
            durationMs: result.durationMs,
            error: "session launcher refused the session, task requeued",
            failureReason: result.failureReason,
            willRetry: true,
          });
          backoff = {
            task,
            resumeAt: new Date(Date.now() + LAUNCHER_REFUSAL_BACKOFF_MS),
          };
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
              costUsd,
              numTurns: result.numTurns,
              error: "authentication failed — task requeued",
              failureReason: result.failureReason,
              willRetry: true,
              sessionId: result.sessionId,
            });
            continue;
          }
          const limit = detectUsageLimit(result);
          if (limit) {
            const limitedAt = Date.now();
            gates.limit.engage(limit, limitedAt);
            if (result.sessionId === undefined) {
              await store.release(task.id, "usage limit reached");
            } else {
              await store.suspend(task.id, "usage limit reached", {
                sessionId: result.sessionId,
                limitedAt: new Date(limitedAt).toISOString(),
                costUsd: result.costUsd,
              });
            }
            reporter.taskFinished({
              taskId: task.id,
              title: task.title,
              ok: false,
              durationMs: result.durationMs,
              costUsd,
              numTurns: result.numTurns,
              error:
                result.sessionId === undefined
                  ? "usage limit reached — task requeued"
                  : "usage limit reached — session resumes after the reset",
              failureReason: result.failureReason,
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
            costUsd,
            numTurns: result.numTurns,
            error,
            failureReason: result.failureReason,
            willRetry,
            attempt: task.attempts,
            maxAttempts: executor.maxTaskAttempts,
            sessionId: result.sessionId,
          });
          await summarizer
            .summarize(task, result, { willRetry, lease }, signal)
            .catch(() => undefined);
          if (willRetry && executor.retryDelayMs > 0) {
            backoff = { task, resumeAt: new Date(Date.now() + executor.retryDelayMs) };
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
    } finally {
      lease.release();
    }

    if (backoff !== undefined) {
      reporter.retryScheduled(backoff.task, backoff.resumeAt);
      await controller.sleep(backoff.resumeAt.getTime() - Date.now(), signal);
    }
  }
}
