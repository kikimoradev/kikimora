import { readFile } from "node:fs/promises";
import { detectAuthFailure } from "./auth-gate.js";
import { createContextFileAccess } from "./context-file.js";
import type { AgentController } from "./control.js";
import type { LoopGates } from "./gates.js";
import { writeMcpConfig } from "./mcp-config.js";
import {
  clearHandoffMark,
  handoffFields,
  readHandoffMark,
  type HandoffTarget,
} from "./memory/handoff.js";
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
  TaskHandoff,
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

function withRunBaseline(
  resume: TaskResume | undefined,
  result: SessionResult,
): TaskResume | undefined {
  if (resume === undefined) return undefined;
  return { ...resume, costUsd: result.costUsd ?? resume.costUsd };
}

function workedSince(result: SessionResult, previous: TaskResume): boolean {
  if ((result.toolUses ?? 0) > 0) return true;
  return (
    result.costUsd !== undefined &&
    previous.costUsd !== undefined &&
    result.costUsd > previous.costUsd
  );
}

function resumeAfterLimit(
  previous: TaskResume | undefined,
  sessionId: string,
  result: SessionResult,
  limitedAt: Date,
): TaskResume {
  const sameSession = previous?.sessionId === sessionId ? previous : undefined;
  const progressed = sameSession === undefined || workedSince(result, sameSession);
  return {
    sessionId,
    limitedAt: progressed ? limitedAt.toISOString() : sameSession.limitedAt,
    costUsd: result.costUsd ?? sameSession?.costUsd,
  };
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

  const handBack = (task: Task, result: SessionResult, error: string): Promise<void> => {
    const resume = withRunBaseline(task.resume, result);
    return resume === undefined
      ? store.release(task.id, error)
      : store.suspend(task.id, error, resume);
  };

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
      const handoffTarget: HandoffTarget = { taskId: task.id, file: config.handoffFile };
      const settleHandoff = (): Promise<void> =>
        clearHandoffMark(config.handoffFile).catch(() => undefined);
      let handoff: TaskHandoff | undefined;
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
          handoff: handoffTarget,
          playwrightOutputDir: config.playwrightOutputDir,
        }),
        task.resume === undefined ? settleHandoff() : undefined,
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
        handoff = await readHandoffMark(handoffTarget);
        const marked = handoffFields(handoff);

        if (task.resume !== undefined && result.failureReason === "resumeFailed") {
          await store.forgetResume(task.id, "session could not be resumed");
          await settleHandoff();
          reporter.taskFinished({
            taskId: task.id,
            title: task.title,
            ok: false,
            durationMs: result.durationMs,
            error: "session could not be resumed — task requeued for a fresh session",
            failureReason: result.failureReason,
            willRetry: true,
            sessionId: result.sessionId,
            ...marked,
          });
          await summarizer
            .summarize(
              task,
              {
                ok: false,
                durationMs: result.durationMs,
                sessionId: task.resume.sessionId,
                error: "usage limit reached — session could not be resumed",
              },
              { willRetry: true, lease, handoff },
              signal,
            )
            .catch(() => undefined);
          continue;
        }

        const costUsd = attemptCostUsd(result, task.resume);
        if (result.ok) {
          await store.complete(task.id, handoff);
          await settleHandoff();
          reporter.taskFinished({
            taskId: task.id,
            title: task.title,
            ok: true,
            durationMs: result.durationMs,
            costUsd,
            numTurns: result.numTurns,
            sessionId: result.sessionId,
            ...marked,
          });
          await summarizer
            .summarize(task, result, { willRetry: false, lease, handoff }, signal)
            .catch(() => undefined);
        } else if (result.failureReason === "launcherRefused") {
          await handBack(task, result, "session launcher refused the session");
          reporter.taskFinished({
            taskId: task.id,
            title: task.title,
            ok: false,
            durationMs: result.durationMs,
            costUsd,
            error: "session launcher refused the session, task requeued",
            failureReason: result.failureReason,
            willRetry: true,
            ...marked,
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
            await handBack(task, result, "authentication failed");
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
              ...marked,
            });
            continue;
          }
          const limit = detectUsageLimit(result);
          if (limit) {
            const limitedAt = Date.now();
            gates.limit.engage(limit, limitedAt);
            if (result.sessionId === undefined) {
              await handBack(task, result, "usage limit reached");
            } else {
              await store.suspend(
                task.id,
                "usage limit reached",
                resumeAfterLimit(
                  task.resume,
                  result.sessionId,
                  result,
                  new Date(limitedAt),
                ),
              );
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
              ...marked,
            });
            continue;
          }
          const willRetry =
            isTransientFailure(result) && task.attempts < executor.maxTaskAttempts;
          if (willRetry) {
            await store.requeue(task.id, error, handoff);
          } else {
            await store.fail(task.id, error, handoff);
          }
          await settleHandoff();
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
            ...marked,
          });
          await summarizer
            .summarize(task, result, { willRetry, lease, handoff }, signal)
            .catch(() => undefined);
          if (willRetry && executor.retryDelayMs > 0) {
            backoff = { task, resumeAt: new Date(Date.now() + executor.retryDelayMs) };
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await store.fail(task.id, message, handoff);
        await settleHandoff();
        reporter.taskFinished({
          taskId: task.id,
          title: task.title,
          ok: false,
          durationMs: Date.now() - start,
          error: message,
          ...handoffFields(handoff),
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
