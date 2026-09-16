export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;

export type EffortLevel = (typeof EFFORT_LEVELS)[number];

export const MODELS = ["haiku", "sonnet", "opus", "fable"] as const;

export const MODELS_WITHOUT_EFFORT: ReadonlySet<string> = new Set(["haiku"]);

export interface StdioMcpServer {
  type?: "stdio" | undefined;
  command: string;
  args?: string[] | undefined;
  env?: Record<string, string> | undefined;
}

export interface HttpMcpServer {
  type: "http" | "sse";
  url: string;
  headers?: Record<string, string> | undefined;
}

export type McpServer = StdioMcpServer | HttpMcpServer;

export interface AgentConfig {
  model: string;
  effort: EffortLevel;
  promptPath: string;
  systemPromptPath: string;
  sessionTimeoutMs?: number | undefined;
  mcpServers: string[];
}

export interface MonitorSchedule {
  startMinute: number;
  endMinute: number;
  days: readonly number[];
}

export interface MonitorConfig extends AgentConfig {
  intervalMs: number;
  schedule: MonitorSchedule | null;
}

export interface ExecutorConfig extends AgentConfig {
  maxTaskAttempts: number;
  retryDelayMs: number;
}

export type SummarizerConfig = Omit<AgentConfig, "promptPath" | "mcpServers">;

export interface WorkerConfig {
  command: string;
  monitor: MonitorConfig;
  executor: ExecutorConfig;
  summarizer: SummarizerConfig;
  streamPartial: boolean;
  browser: boolean;
  shutdownGraceMs: number;
  mcpServers: Record<string, McpServer>;
  cwd: string;
  settingsFilePath: string;
  contextFilePath: string;
  tasksFilePath: string;
  memoryDbPath: string;
  dataDir: string;
  playwrightOutputDir: string;
  logsDir: string;
}

export const SESSION_FAILURE_REASONS = [
  "timeout",
  "abort",
  "isError",
  "exit",
  "spawn",
] as const;

export type SessionFailureReason = (typeof SESSION_FAILURE_REASONS)[number];

export interface RateLimitInfo {
  status: string;
  resetsAt?: number | undefined;
  rateLimitType?: string | undefined;
}

export interface ApiErrorInfo {
  status: number;
  code?: string | undefined;
}

export interface SessionResult {
  ok: boolean;
  durationMs: number;
  costUsd?: number | undefined;
  numTurns?: number | undefined;
  sessionId?: string | undefined;
  resultText?: string | undefined;
  error?: string | undefined;
  failureReason?: SessionFailureReason | undefined;
  rateLimit?: RateLimitInfo | undefined;
  apiError?: ApiErrorInfo | undefined;
  terminalReason?: string | undefined;
}

export interface SessionSummary {
  costUsd?: number | undefined;
  numTurns?: number | undefined;
  sessionId?: string | undefined;
  isError?: boolean | undefined;
  resultText?: string | undefined;
  rateLimit?: RateLimitInfo | undefined;
  apiError?: ApiErrorInfo | undefined;
  terminalReason?: string | undefined;
}

export const TASK_STATUSES = [
  "pending",
  "in_progress",
  "done",
  "failed",
  "cancelled",
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

export interface Task {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  attempts: number;
  createdAt: string;
  updatedAt: string;
  error?: string | undefined;
}

export type NewTask = Pick<Task, "id" | "title" | "description">;
