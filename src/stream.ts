import { truncate, type SessionEventSink } from "./session-events.js";
import type { ApiErrorInfo, RateLimitInfo, SessionSummary } from "./types.js";

interface ContentBlock {
  type: string;
  text?: string;
  name?: string;
  input?: unknown;
  content?: unknown;
  is_error?: boolean;
}

function blockText(block: unknown): string {
  if (typeof block !== "object" || block === null || !("text" in block)) return "";
  const { text } = block;
  return typeof text === "string" ? text : "";
}

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map(blockText).filter(Boolean).join("\n");
  }
  return content == null ? "" : JSON.stringify(content);
}

function unescapeNewlines(text: string): string {
  return text.includes("\n") ? text : text.replaceAll("\\n", "\n");
}

const MAX_RESULT_LINES = 20;
const MAX_RESULT_LINE_LENGTH = 300;

interface StreamEvent {
  type: string;
  subtype?: string;
  session_id?: string;
  model?: string;
  tools?: string[];
  message?: { content?: ContentBlock[] };
  event?: {
    type?: string;
    delta?: { type?: string; text?: string };
  };
  duration_ms?: number;
  is_error?: boolean;
  num_turns?: number;
  total_cost_usd?: number;
  result?: string;
  terminal_reason?: string;
  error_status?: number;
  error?: string;
  rate_limit_info?: {
    status?: string;
    resetsAt?: number;
    rateLimitType?: string;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseApiError(event: StreamEvent): ApiErrorInfo | undefined {
  if (typeof event.error_status !== "number") return undefined;
  return {
    status: event.error_status,
    code: typeof event.error === "string" ? event.error : undefined,
  };
}

function parseRateLimitInfo(
  info: NonNullable<StreamEvent["rate_limit_info"]>,
): RateLimitInfo | undefined {
  if (typeof info.status !== "string") return undefined;
  return {
    status: info.status,
    resetsAt: typeof info.resetsAt === "number" ? info.resetsAt : undefined,
    rateLimitType:
      typeof info.rateLimitType === "string" ? info.rateLimitType : undefined,
  };
}

export class StreamRenderer {
  private summary: SessionSummary = {};

  constructor(
    private readonly emit: SessionEventSink,
    private readonly streamPartial: boolean,
  ) {}

  handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      this.emit({ type: "raw", line: truncate(trimmed) });
      return;
    }
    this.handleEvent(parsed as StreamEvent);
    if (isRecord(parsed) && parsed.type !== "stream_event") {
      this.emit({ type: "stream", event: parsed });
    }
  }

  private handleEvent(event: StreamEvent): void {
    switch (event.type) {
      case "system":
        if (event.subtype === "init") {
          this.emit({
            type: "init",
            model: event.model ?? "?",
            sessionId: event.session_id ?? "?",
            toolCount: event.tools?.length ?? 0,
          });
        } else if (event.subtype === "api_retry") {
          this.summary.apiError = parseApiError(event) ?? this.summary.apiError;
        }
        break;

      case "assistant":
        for (const block of event.message?.content ?? []) {
          if (block.type === "text" && block.text?.trim()) {
            this.emit({ type: "text", text: block.text.trim() });
          } else if (block.type === "tool_use") {
            this.summary.toolUses = (this.summary.toolUses ?? 0) + 1;
            this.emit({
              type: "toolUse",
              name: block.name ?? "?",
              input: block.input,
            });
          }
        }
        break;

      case "user":
        for (const block of event.message?.content ?? []) {
          if (block.type === "tool_result") {
            const lines = unescapeNewlines(toolResultText(block.content))
              .split("\n")
              .map((line) => line.trim())
              .filter(Boolean);
            this.emit({
              type: "toolResult",
              isError: block.is_error ?? false,
              lines: lines
                .slice(0, MAX_RESULT_LINES)
                .map((line) => truncate(line, MAX_RESULT_LINE_LENGTH)),
              dropped: Math.max(0, lines.length - MAX_RESULT_LINES),
            });
          }
        }
        break;

      case "stream_event":
        if (
          this.streamPartial &&
          event.event?.type === "content_block_delta" &&
          event.event.delta?.type === "text_delta" &&
          event.event.delta.text
        ) {
          this.emit({ type: "partial", text: event.event.delta.text });
        }
        break;

      case "rate_limit_event":
        if (event.rate_limit_info) {
          this.summary.rateLimit =
            parseRateLimitInfo(event.rate_limit_info) ?? this.summary.rateLimit;
        }
        break;

      case "result":
        this.summary = {
          rateLimit: this.summary.rateLimit,
          apiError: this.summary.apiError,
          toolUses: this.summary.toolUses,
          isError: event.is_error,
          costUsd: event.total_cost_usd,
          numTurns: event.num_turns,
          sessionId: event.session_id,
          resultText: event.result,
          terminalReason: event.terminal_reason,
        };
        break;
    }
  }

  getSummary(): SessionSummary {
    return this.summary;
  }
}
