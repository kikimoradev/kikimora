import { readFile } from "node:fs/promises";
import type { AdmissionLease } from "../admission.js";
import { detectAuthFailure } from "../auth-gate.js";
import type { LoopGates } from "../gates.js";
import { writeMcpConfig } from "../mcp-config.js";
import { runSession } from "../runner.js";
import type { SessionEventSink } from "../session-events.js";
import type { SessionLauncher } from "../session-launcher.js";
import type { SessionRecorder } from "../sessions/index.js";
import type { SummaryOutcome } from "../status.js";
import type { SessionResult, SummarizerConfig, Task } from "../types.js";
import { detectUsageLimit } from "../usage-limit.js";
import type { MemoryStore } from "./store.js";
import { composeSummaryPrompt, parseSummary, SUMMARY_JSON_SCHEMA } from "./summary.js";

export interface TaskOutcomeContext {
  willRetry: boolean;
  lease: AdmissionLease;
}

export interface TaskSummarizer {
  summarize(
    task: Task,
    result: SessionResult,
    outcome: TaskOutcomeContext,
    signal: AbortSignal,
  ): Promise<void>;
}

export interface SummaryReporter {
  summaryStarted(task: Task): void;
  summaryFinished(outcome: Omit<SummaryOutcome, "finishedAt">): void;
  session: SessionEventSink;
}

export interface SessionSummarizerDeps {
  command: string;
  launcher: SessionLauncher;
  summarizer: SummarizerConfig;
  streamPartial: boolean;
  cwd: string;
  dataDir: string;
  playwrightOutputDir: string;
  store: MemoryStore;
  resolveLogPath(sessionId: string): Promise<string | undefined>;
  reporter: SummaryReporter;
  gates: LoopGates;
  sessions?: SessionRecorder | undefined;
}

export class SessionSummarizer implements TaskSummarizer {
  constructor(private readonly deps: SessionSummarizerDeps) {}

  async summarize(
    task: Task,
    result: SessionResult,
    outcome: TaskOutcomeContext,
    signal: AbortSignal,
  ): Promise<void> {
    const aborted = (): boolean => signal.aborted;
    if (aborted()) return;
    const { reporter, store, summarizer } = this.deps;
    reporter.summaryStarted(task);
    const startedAt = Date.now();
    const finished = (
      ok: boolean,
      error?: string,
      costUsd?: number,
      sessionId?: string,
    ): void => {
      reporter.summaryFinished({
        taskId: task.id,
        ok,
        durationMs: Date.now() - startedAt,
        costUsd,
        error,
        sessionId,
      });
    };

    try {
      const sessionId = result.sessionId;
      if (sessionId === undefined) {
        finished(false, "executor session has no id — no log");
        return;
      }
      const logPath = await this.deps.resolveLogPath(sessionId);
      if (logPath === undefined) {
        finished(false, "executor session log file not found");
        return;
      }

      const [systemPrompt, mcpConfigPath] = await Promise.all([
        readFile(summarizer.systemPromptPath, "utf8"),
        writeMcpConfig(this.deps.dataDir, {
          role: "summarizer",
          servers: {},
          selected: [],
          browser: false,
          memoryDbPath: null,
          playwrightOutputDir: this.deps.playwrightOutputDir,
        }),
      ]);
      const sessionResult = await runSession(
        {
          command: this.deps.command,
          launcher: this.deps.launcher,
          placement: { pool: "executor", lease: outcome.lease },
          model: summarizer.model,
          effort: summarizer.effort,
          systemPrompt,
          prompt: composeSummaryPrompt({
            task,
            result,
            willRetry: outcome.willRetry,
            logPath,
          }),
          sessionTimeoutMs: summarizer.sessionTimeoutMs,
          streamPartial: this.deps.streamPartial,
          mcpConfigPath,
          jsonSchema: SUMMARY_JSON_SCHEMA,
          cwd: this.deps.cwd,
          events: reporter.session,
          meta: { agent: "summarizer", taskId: task.id },
          index: this.deps.sessions,
        },
        signal,
      );
      if (aborted()) return;

      if (!sessionResult.ok) {
        const auth = detectAuthFailure(sessionResult);
        if (auth) {
          this.deps.gates.auth.engage(auth);
          finished(
            false,
            `authentication failed — ${auth.reason}`,
            sessionResult.costUsd,
            sessionResult.sessionId,
          );
          return;
        }
        const limit = detectUsageLimit(sessionResult);
        if (limit) this.deps.gates.limit.engage(limit, Date.now());
        finished(
          false,
          limit
            ? "usage limit reached"
            : (sessionResult.error ?? "unknown summarizer session error"),
          sessionResult.costUsd,
          sessionResult.sessionId,
        );
        return;
      }

      const report =
        sessionResult.resultText === undefined
          ? null
          : parseSummary(sessionResult.resultText);
      if (report === null) {
        finished(
          false,
          "invalid summary report",
          sessionResult.costUsd,
          sessionResult.sessionId,
        );
        return;
      }

      store.add({
        taskId: task.id,
        attempt: task.attempts,
        ok: result.ok,
        title: task.title,
        headline: report.headline,
        summary: report.summary,
        error: result.error,
        sessionId,
        createdAt: new Date().toISOString(),
      });
      finished(true, undefined, sessionResult.costUsd, sessionResult.sessionId);
    } catch (err) {
      finished(false, err instanceof Error ? err.message : String(err));
    }
  }
}
