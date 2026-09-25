import { Box, Text } from "ink";
import type { JSX } from "react";
import { Fragment } from "react";
import type { Task, TaskStatus } from "../types.js";
import { countTasks, formatAge } from "./format.js";
import { Panel } from "./panel.js";
import { describeWindow, listWindow, PANEL_BORDER_ROWS } from "./scroll.js";
import { Spinner } from "./spinner.js";
import { glyphs, theme } from "./theme.js";

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

const STATUS_GLYPHS: Record<TaskStatus, string> = {
  pending: glyphs.idle,
  in_progress: glyphs.active,
  done: glyphs.ok,
  failed: glyphs.error,
  cancelled: "–",
};

const STATUS_COLORS: Record<TaskStatus, string> = {
  pending: theme.warn,
  in_progress: theme.info,
  done: theme.ok,
  failed: theme.error,
  cancelled: theme.muted,
};

const COUNTED_STATUSES: readonly [TaskStatus, string][] = [
  ["in_progress", "running"],
  ["pending", "pending"],
  ["done", "done"],
  ["failed", "failed"],
];

const STATUS_COLUMN_WIDTH = 14;
const MAX_ID_WIDTH = 24;

export type TaskRow =
  { kind: "task"; task: Task } | { kind: "error"; task: Task; error: string };

function sortTasks(tasks: readonly Task[]): Task[] {
  return [...tasks].sort((a, b) => {
    const order = STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
    if (order !== 0) return order;
    return b.updatedAt.localeCompare(a.updatedAt);
  });
}

export function taskRows(tasks: readonly Task[]): TaskRow[] {
  return sortTasks(tasks).flatMap((task): TaskRow[] =>
    task.error === undefined || task.status !== "failed"
      ? [{ kind: "task", task }]
      : [
          { kind: "task", task },
          { kind: "error", task, error: task.error },
        ],
  );
}

function taskMeta(task: Task, now: number): string {
  const parts = [formatAge(task.updatedAt, now)];
  if (task.attempts > 1) parts.unshift(`attempt ${task.attempts}`);
  return parts.filter((part) => part !== "").join(" · ");
}

function StatusCell({ status }: { status: TaskStatus }): JSX.Element {
  const color = STATUS_COLORS[status];
  return (
    <Box width={STATUS_COLUMN_WIDTH} flexShrink={0}>
      <Text color={color}>
        {status === "in_progress" ? <Spinner color={color} /> : STATUS_GLYPHS[status]}
        {` ${STATUS_LABELS[status]}`}
      </Text>
    </Box>
  );
}

function TaskLine({
  row,
  idWidth,
  now,
}: {
  row: TaskRow;
  idWidth: number;
  now: number;
}): JSX.Element {
  if (row.kind === "error") {
    return (
      <Box height={1} paddingLeft={STATUS_COLUMN_WIDTH + idWidth}>
        <Text color={theme.error} wrap="truncate-end">
          {`${glyphs.result} ${row.error}`}
        </Text>
      </Box>
    );
  }
  const { task } = row;
  const finished = STATUS_ORDER[task.status] === 2;
  return (
    <Box height={1} gap={2}>
      <Box flexGrow={1} flexShrink={1} flexBasis={0} overflow="hidden">
        <StatusCell status={task.status} />
        <Box width={idWidth} flexShrink={0} overflow="hidden">
          <Text dimColor={finished} wrap="truncate-end">
            {task.id}
          </Text>
        </Box>
        <Box flexGrow={1} flexShrink={1} overflow="hidden">
          <Text dimColor={task.status === "cancelled"} wrap="truncate-end">
            {task.title}
          </Text>
        </Box>
      </Box>
      <Box flexShrink={0}>
        <Text dimColor>{taskMeta(task, now)}</Text>
      </Box>
    </Box>
  );
}

export function TaskCounts({ tasks }: { tasks: readonly Task[] }): JSX.Element {
  const counts = countTasks(tasks);
  return (
    <Text>
      {COUNTED_STATUSES.map(([status, label], index) => {
        const count = counts[status];
        return (
          <Fragment key={status}>
            {index === 0 ? null : <Text dimColor>{" · "}</Text>}
            {count === 0 ? (
              <Text dimColor>{String(count)}</Text>
            ) : (
              <Text color={STATUS_COLORS[status]}>{String(count)}</Text>
            )}
            <Text dimColor>{` ${label}`}</Text>
          </Fragment>
        );
      })}
    </Text>
  );
}

export interface TaskTableProps {
  tasks: readonly Task[];
  height: number;
  now: number;
  offset?: number | undefined;
  active?: boolean | undefined;
  scrollable?: boolean | undefined;
}

export function TaskTable({
  tasks,
  height,
  now,
  offset = 0,
  active = true,
  scrollable = true,
}: TaskTableProps): JSX.Element {
  const rows = taskRows(tasks);
  const window = listWindow(rows, height - PANEL_BORDER_ROWS, offset);
  const idWidth =
    Math.min(
      MAX_ID_WIDTH,
      tasks.reduce((max, task) => Math.max(max, task.id.length), 0),
    ) + 2;
  const hidden = window.total - window.visible.length;
  const range = scrollable
    ? describeWindow(window)
    : hidden > 0
      ? `+${String(hidden)} more · /tasks`
      : undefined;
  return (
    <Panel
      title="Tasks"
      aside={<TaskCounts tasks={tasks} />}
      footerAside={range === undefined ? undefined : <Text dimColor>{range}</Text>}
      active={active}
      height={height}
    >
      {tasks.length === 0 ? (
        <Text dimColor>
          no tasks yet — the monitor reports them, or add one with /task
        </Text>
      ) : null}
      {window.visible.map((row) => (
        <TaskLine
          key={`${row.kind}:${row.task.id}`}
          row={row}
          idWidth={idWidth}
          now={now}
        />
      ))}
    </Panel>
  );
}
