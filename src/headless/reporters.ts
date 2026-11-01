import type { AdmissionChange, AdmissionWait } from "../admission.js";
import type { SummaryReporter } from "../memory/summarizer.js";
import {
  boundText,
  describeToolUse,
  LIVE_FIELD_MAX,
  type SessionEventSink,
} from "../session-events.js";
import type { ExecutorReporter, MonitorReporter } from "../status.js";
import {
  compactFields,
  type HeadlessAgent,
  type HeadlessLogEmitter,
  type HeadlessLogEvent,
} from "./events.js";

export interface HeadlessReporterOptions {
  verbose?: boolean | undefined;
}

export interface HeadlessReporters {
  monitor: MonitorReporter;
  executor: ExecutorReporter;
  summarizer: SummaryReporter;
}

function toolInputFields(input: unknown): Record<string, unknown> {
  const serialized = JSON.stringify(input) as string | undefined;
  if (serialized === undefined) return {};
  const bounded = boundText(serialized, LIVE_FIELD_MAX);
  return {
    input: bounded.truncated ? bounded.text : input,
    inputTruncated: bounded.truncated,
  };
}

function sessionSink(
  emit: HeadlessLogEmitter,
  agent: HeadlessAgent,
  verbose: boolean,
): SessionEventSink {
  let sessionId: string | undefined;
  const content = (
    level: HeadlessLogEvent["level"],
    event: string,
    fields: Record<string, unknown>,
  ): void => {
    emit({ level, agent, event, fields: compactFields({ sessionId, ...fields }) });
  };
  return (event) => {
    switch (event.type) {
      case "spawned":
        sessionId = undefined;
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
        sessionId = event.sessionId;
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
          fields: compactFields({
            reason: event.reason,
            sessionId: event.sessionId,
            taskId: event.taskId,
            cycle: event.cycle,
          }),
        });
        return;
      case "text":
        if (verbose) content("info", "session.text", { text: event.text });
        return;
      case "thinking":
        if (verbose) {
          const thought = boundText(event.text, LIVE_FIELD_MAX);
          content("info", "session.thinking", {
            text: thought.text,
            truncated: thought.truncated,
          });
        }
        return;
      case "toolUse":
        if (verbose) {
          const call = describeToolUse(event.name, event.input);
          content("info", "session.tool", {
            tool: call.name,
            detail: call.detail,
            toolUseId: event.id || undefined,
            ...toolInputFields(event.input),
          });
        }
        return;
      case "toolResult":
        if (verbose) {
          const output = boundText(event.text, LIVE_FIELD_MAX);
          content(
            event.isError ? "warn" : "info",
            event.isError ? "session.toolError" : "session.toolResult",
            {
              toolUseId: event.toolUseId || undefined,
              output: output.text,
              truncated: output.truncated,
            },
          );
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
        fields: compactFields({
          taskId: task.id,
          title: task.title,
          resumedSessionId: task.resume?.sessionId,
        }),
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
          handedOff: outcome.handedOff,
          handoffReason: outcome.handoffReason,
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
