import type { AdmissionRole } from "./admission.js";
import type { SessionRole } from "./session-launcher.js";

export type SessionEvent =
  | {
      type: "spawned";
      pid: number;
      role: SessionRole;
      pool: AdmissionRole;
      ticket?: string | undefined;
      seq?: number | undefined;
    }
  | {
      type: "init";
      model: string;
      sessionId: string;
      toolCount: number;
      taskId?: string | undefined;
      cycle?: number | undefined;
    }
  | { type: "text"; text: string }
  | { type: "toolUse"; name: string; input: unknown }
  | { type: "toolResult"; isError: boolean; lines: string[]; dropped: number }
  | { type: "partial"; text: string }
  | { type: "stream"; event: Record<string, unknown> }
  | { type: "raw"; line: string }
  | { type: "stderr"; line: string }
  | { type: "killing"; reason: "timeout" | "abort" }
  | { type: "procError"; message: string };

export type SessionEventSink = (event: SessionEvent) => void;

export function truncate(value: unknown, max = 500): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (!text) return "";
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

export interface ToolCallView {
  name: string;
  detail: string;
}

const PRIMARY_INPUT_KEY: Readonly<Record<string, string>> = {
  Bash: "command",
  Read: "file_path",
  Write: "file_path",
  Edit: "file_path",
  MultiEdit: "file_path",
  NotebookEdit: "notebook_path",
  Grep: "pattern",
  Glob: "pattern",
  WebFetch: "url",
  WebSearch: "query",
  Task: "description",
  Agent: "description",
  Skill: "skill",
};

const TOOL_DETAIL_MAX = 300;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stripCwd(value: string, cwd: string): string {
  const prefix = cwd.endsWith("/") ? cwd : `${cwd}/`;
  return value.startsWith(prefix) ? value.slice(prefix.length) : value;
}

export function describeToolUse(
  name: string,
  input: unknown,
  cwd: string = process.cwd(),
): ToolCallView {
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
  const displayName = mcp ? `${mcp[1] ?? ""}:${mcp[2] ?? ""}` : name;
  if (isRecord(input)) {
    if (name === "TodoWrite" && Array.isArray(input.todos)) {
      return { name: displayName, detail: `${String(input.todos.length)} items` };
    }
    const key = PRIMARY_INPUT_KEY[name];
    const value = key === undefined ? undefined : input[key];
    if (typeof value === "string" && value.trim()) {
      return {
        name: displayName,
        detail: truncate(stripCwd(value, cwd), TOOL_DETAIL_MAX),
      };
    }
  }
  return { name: displayName, detail: truncate(input, TOOL_DETAIL_MAX) };
}

export function formatToolCount(count: number): string {
  return `${String(count)} ${count === 1 ? "tool" : "tools"}`;
}

export function formatDroppedLines(dropped: number): string {
  return ` … +${String(dropped)} ${dropped === 1 ? "line" : "lines"}`;
}

export function formatSessionEvent(
  event: Exclude<SessionEvent, { type: "partial" | "stream" | "spawned" }>,
): string {
  switch (event.type) {
    case "init":
      return `session started · model ${event.model} · ${formatToolCount(event.toolCount)} · ${event.sessionId}`;
    case "text":
      return event.text;
    case "toolUse": {
      const call = describeToolUse(event.name, event.input);
      return `⏺ ${call.name}(${call.detail})`;
    }
    case "toolResult": {
      const [first, ...rest] = event.lines;
      const head = `  ⎿ ${event.isError ? "error: " : ""}${first ?? "(no output)"}`;
      const body = [head, ...rest.map((line) => `    ${line}`)].join("\n");
      return event.dropped > 0 ? `${body}${formatDroppedLines(event.dropped)}` : body;
    }
    case "raw":
      return `(non-JSON) ${event.line}`;
    case "stderr":
      return `stderr: ${event.line}`;
    case "killing":
      return `⏹ Stopping session (${event.reason})…`;
    case "procError":
      return `✖ ${event.message}`;
  }
}
