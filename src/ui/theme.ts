export const theme = {
  ok: "green",
  warn: "yellow",
  error: "red",
  info: "cyan",
  muted: "gray",
} as const;

export type Tone = "ok" | "warn" | "error" | "info" | "muted";

export function toneColor(tone: Tone): string {
  return theme[tone];
}

export const glyphs = {
  ok: "✔",
  error: "✖",
  warn: "⚠",
  paused: "‖",
  idle: "○",
  active: "●",
  retry: "↻",
  summary: "✎",
  update: "↑",
  uptime: "↑",
  drain: "⏏",
  stop: "⏹",
  prompt: "❯",
  bullet: "⏺",
  result: "⎿",
  rule: "─",
} as const;

export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
