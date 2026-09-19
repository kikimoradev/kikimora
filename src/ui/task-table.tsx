import { Box, Text } from "ink";
import type { JSX } from "react";
import type { Task, TaskStatus } from "../types.js";
import { formatAge } from "./format.js";
import { theme } from "./theme.js";

const STATUS_ORDER: Record<TaskStatus, number> = {
  in_progress: 0,
  pending: 1,
  done: 2,
  failed: 2,
  cancelled: 2,
};

const STATUS_LABELS: Record<TaskStatus, string> = {
  pending: "pending",
  in_progress: "in progress",
  done: "done",
  failed: "failed",
  cancelled: "cancelled",
};

const STATUS_COLORS: Record<TaskStatus, string> = {
  pending: theme.warn,
  in_progress: theme.info,
  done: theme.ok,
  failed: theme.error,
  cancelled: theme.muted,
};

function sortTasks(tasks: readonly Task[]): Task[] {
  return [...tasks].sort((a, b) => {
    const order = STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
    if (order !== 0) return order;
    return b.updatedAt.localeCompare(a.updatedAt);
  });
}

function countByStatus(tasks: readonly Task[], status: TaskStatus): number {
  return tasks.filter((task) => task.status === status).length;
}

function taskMeta(task: Task, now: number): string {
  const parts = [formatAge(task.updatedAt, now)];
  if (task.attempts > 1) parts.push(`attempts ${task.attempts}`);
  return parts.filter((part) => part !== "").join(" · ");
}

export interface TaskTableProps {
  tasks: readonly Task[];
  height: number;
  now: number;
}

interface StatusCountProps {
  tasks: readonly Task[];
  status: TaskStatus;
  label: string;
}

function StatusCount({ tasks, status, label }: StatusCountProps): JSX.Element {
  const count = countByStatus(tasks, status);
  return count === 0 ? (
    <Text color={theme.muted}>{`${label}: 0`}</Text>
  ) : (
    <Text color={STATUS_COLORS[status]}>{`${label}: ${String(count)}`}</Text>
  );
}

export function TaskTable({ tasks, height, now }: TaskTableProps): JSX.Element {
  const maxRows = Math.max(1, height - 3);
  const sorted = sortTasks(tasks);
  const overflow = sorted.length > maxRows ? sorted.length - (maxRows - 1) : 0;
  const visible = overflow > 0 ? sorted.slice(0, maxRows - 1) : sorted;
  return (
    <Box
      borderStyle="round"
      borderColor={theme.muted}
      flexDirection="column"
      paddingX={1}
      height={height}
      overflow="hidden"
    >
      <Text bold wrap="truncate-end">
        {"Tasks  "}
        <StatusCount tasks={tasks} status="pending" label="pending" />
        {" · "}
        <StatusCount tasks={tasks} status="in_progress" label="in progress" />
        {" · "}
        <StatusCount tasks={tasks} status="done" label="done" />
        {" · "}
        <StatusCount tasks={tasks} status="failed" label="failed" />
      </Text>
      {tasks.length === 0 ? <Text dimColor>no tasks</Text> : null}
      {visible.map((task) => {
        const meta = taskMeta(task, now);
        return (
          <Text key={task.id} wrap="truncate-end">
            <Text color={STATUS_COLORS[task.status]}>
              {STATUS_LABELS[task.status].padEnd(11)}
            </Text>
            {`${task.id} · ${task.title}${task.error === undefined ? "" : ` — ${task.error}`}`}
            {meta === "" ? null : <Text dimColor>{` · ${meta}`}</Text>}
          </Text>
        );
      })}
      {overflow > 0 ? <Text dimColor>… and {overflow} more</Text> : null}
    </Box>
  );
}
