import type { AdmissionChange, AdmissionWait } from "../admission.js";
import type { SummaryReporter } from "../memory/summarizer.js";
import { describeToolUse, type SessionEventSink } from "../session-events.js";
import type { ExecutorReporter, MonitorReporter } from "../status.js";
import { compactFields, type HeadlessAgent, type HeadlessLogEmitter } from "./events.js";

export interface HeadlessReporterOptions {
  verbose?: boolean | undefined;
}

export interface HeadlessReporters {
  monitor: MonitorReporter;
  executor: ExecutorReporter;
  summarizer: SummaryReporter;
}

function sessionSink(
  emit: HeadlessLogEmitter,
  agent: HeadlessAgent,
  verbose: boolean,
): SessionEventSink {
  return (event) => {
    switch (event.type) {
      case "spawned":
        emit({
          level: "info",
          agent,
          event: "session.spawned",
          fields: compactFields({
            pid: event.pid,
            role: event.role,
            pool: event.pool,
            ticket: event.ticket,
            seq: event.seq,
          }),
        });
        return;
      case "init":
        emit({
          level: "info",
          agent,
          event: "session.init",
          fields: compactFields({
            model: event.model,
            sessionId: event.sessionId,
            taskId: event.taskId,
            cycle: event.cycle,
          }),
        });
        return;
      case "stderr":
        emit({
          level: "warn",
          agent,
          event: "session.stderr",
          fields: { line: event.line },
        });
        return;
      case "procError":
        emit({
          level: "error",
          agent,
          event: "session.procError",
          fields: { message: event.message },
        });
        return;
      case "killing":
        emit({
          level: "warn",
          agent,
          event: "session.killed",
          fields: { reason: event.reason },
        });
        return;
      case "text":
        if (verbose) {
          emit({
            level: "info",
            agent,
            event: "session.text",
            fields: { text: event.text },
          });
        }
        return;
      case "toolUse":
        if (verbose) {
          const call = describeToolUse(event.name, event.input);
          emit({
            level: "info",
            agent,
            event: "session.tool",
            fields: { tool: call.name, detail: call.detail },
          });
        }
        return;
      case "toolResult":
        if (verbose && event.isError) {
          emit({
            level: "warn",
            agent,
            event: "session.toolError",
            fields: { output: event.lines.join("\n") },
          });
        }
        return;
      case "partial":
      case "stream":
      case "raw":
        return;
    }
  };
}

function admissionWaitFields(wait: AdmissionWait): Record<string, unknown> {
  return {
    ticket: wait.ticket,
    since: new Date(wait.since).toISOString(),
    seq: wait.seq,
  };
}

export function createHeadlessReporters(
  emit: HeadlessLogEmitter,
  options: HeadlessReporterOptions = {},
): HeadlessReporters {
  const verbose = options.verbose === true;

  const monitor: MonitorReporter = {
    offHours: (resumeAt) => {
      emit({
        level: "info",
        agent: "monitor",
        event: "monitor.offHours",
        fields: { resumeAt: resumeAt.toISOString() },
      });
    },
    usageLimit: (resumeAt) => {
      emit({
        level: "warn",
        agent: "monitor",
        event: "monitor.limitWait",
        fields: { resumeAt: resumeAt.toISOString() },
      });
    },
    authBlocked: (failure) => {
      emit({
        level: "error",
        agent: "monitor",
        event: "monitor.authBlocked",
        fields: { reason: failure.reason },
      });
    },
    admissionWait: (wait) => {
      emit({
        level: "info",
        agent: "monitor",
        event: "monitor.admissionWait",
        fields: admissionWaitFields(wait),
      });
    },
    cycleStarted: (cycle) => {
      emit({
        level: "info",
        agent: "monitor",
        event: "cycle.started",
        fields: { cycle },
      });
    },
    cycleFinished: (outcome) => {
      emit({
        level: outcome.ok ? "info" : "error",
        agent: "monitor",
        event: "cycle.finished",
        fields: compactFields({
          cycle: outcome.cycle,
          ok: outcome.ok,
          durationMs: outcome.durationMs,
          costUsd: outcome.costUsd,
          addedTasks: outcome.addedTasks,
          skippedDuplicates: outcome.skippedDuplicates,
          error: outcome.error,
          failureReason: outcome.failureReason,
          sessionId: outcome.sessionId,
        }),
      });
    },
    sleepUntil: (nextCycleAt) => {
      emit({
        level: "info",
        agent: "monitor",
        event: "monitor.sleeping",
        fields: { nextCycleAt: nextCycleAt.toISOString() },
      });
    },
    session: sessionSink(emit, "monitor", verbose),
  };

  const executor: ExecutorReporter = {
    taskStarted: (task) => {
      emit({
        level: "info",
        agent: "executor",
        event: "task.started",
        fields: { taskId: task.id, title: task.title },
      });
    },
    taskFinished: (outcome) => {
      emit({
        level: outcome.ok ? "info" : outcome.willRetry === true ? "warn" : "error",
        agent: "executor",
        event: "task.finished",
        fields: compactFields({
          taskId: outcome.taskId,
          title: outcome.title,
          ok: outcome.ok,
          durationMs: outcome.durationMs,
          costUsd: outcome.costUsd,
          numTurns: outcome.numTurns,
          willRetry: outcome.willRetry,
          attempt: outcome.attempt,
          maxAttempts: outcome.maxAttempts,
          error: outcome.error,
          failureReason: outcome.failureReason,
          sessionId: outcome.sessionId,
        }),
      });
    },
    retryScheduled: (task, resumeAt) => {
      emit({
        level: "warn",
        agent: "executor",
        event: "task.retryScheduled",
        fields: { taskId: task.id, resumeAt: resumeAt.toISOString() },
      });
    },
    usageLimit: (resumeAt) => {
      emit({
        level: "warn",
        agent: "executor",
        event: "executor.limitWait",
        fields: { resumeAt: resumeAt.toISOString() },
      });
    },
    authBlocked: (failure) => {
      emit({
        level: "error",
        agent: "executor",
        event: "executor.authBlocked",
        fields: { reason: failure.reason },
      });
    },
    admissionWait: (wait, task) => {
      emit({
        level: "info",
        agent: "executor",
        event: "executor.admissionWait",
        fields: { ...admissionWaitFields(wait), taskId: task.id },
      });
    },
    waiting: () => {
      emit({
        level: "info",
        agent: "executor",
        event: "executor.waiting",
        fields: {},
      });
    },
    summaryStarted: () => undefined,
    summaryFinished: () => undefined,
    session: sessionSink(emit, "executor", verbose),
  };

  const summarizer: SummaryReporter = {
    summaryStarted: (task) => {
      emit({
        level: "info",
        agent: "summarizer",
        event: "summary.started",
        fields: { taskId: task.id },
      });
    },
    summaryFinished: (outcome) => {
      emit({
        level: outcome.ok ? "info" : "error",
        agent: "summarizer",
        event: "summary.finished",
        fields: compactFields({
          taskId: outcome.taskId,
          ok: outcome.ok,
          durationMs: outcome.durationMs,
          costUsd: outcome.costUsd,
          error: outcome.error,
          failureReason: outcome.failureReason,
          sessionId: outcome.sessionId,
        }),
      });
    },
    session: sessionSink(emit, "summarizer", verbose),
  };

  return { monitor, executor, summarizer };
}

export function emitAdmissionChange(
  emit: HeadlessLogEmitter,
  change: AdmissionChange,
): void {
  emit({
    level: "info",
    agent: change.role,
    event: `admission.${change.kind}`,
    fields: { ticket: change.ticket, seq: change.seq },
  });
}
