import { defineCommand } from "citty";
import {
  fail,
  requestControl,
  SOCKET_ENV_HINT,
  writerFor,
  type ControlCommandIo,
} from "./control-commands.js";
import { logger } from "./logger.js";
import type { TaskSelector } from "./tasks.js";
import {
  FINAL_TASK_STATUSES,
  TASK_STATUSES,
  type Task,
  type TaskStatus,
} from "./types.js";

function parseStatus(raw: string | undefined): TaskStatus | null | undefined {
  if (raw === undefined) return undefined;
  const match = TASK_STATUSES.find((status) => status === raw);
  return match ?? null;
}

function taskLine(task: Task): string {
  return `${task.id.padEnd(24)} ${task.status.padEnd(12)} ${String(task.attempts).padStart(2)}  ${task.title}`;
}

export async function runTasksList(
  options: {
    json?: boolean | undefined;
    status?: string | undefined;
  } & ControlCommandIo = {},
): Promise<void> {
  const write = writerFor(options);
  const status = parseStatus(options.status);
  if (status === null) {
    fail(
      `Unknown task status "${options.status ?? ""}" — use ${TASK_STATUSES.join(", ")}.`,
    );
    return;
  }
  const response = await requestControl(
    status === undefined ? { cmd: "tasks.list" } : { cmd: "tasks.list", status },
    options,
  );
  if (response === null) return;
  if (options.json === true) {
    write(JSON.stringify(response.data, null, 2));
    return;
  }
  if (response.data.length === 0) {
    write("No tasks.");
    return;
  }
  for (const task of response.data) write(taskLine(task));
}

export async function runTasksAdd(
  description: string,
  options: {
    id?: string | undefined;
    title?: string | undefined;
    json?: boolean | undefined;
  } & ControlCommandIo = {},
): Promise<void> {
  if (description.trim() === "") {
    fail("The task description is empty.");
    return;
  }
  const response = await requestControl(
    {
      cmd: "tasks.add",
      description,
      ...(options.id === undefined ? {} : { id: options.id }),
      ...(options.title === undefined ? {} : { title: options.title }),
    },
    options,
  );
  if (response === null) return;
  if (options.json === true) {
    writerFor(options)(JSON.stringify(response.data, null, 2));
    return;
  }
  logger.success(`Task ${response.data.id} added.`);
}

export async function runTasksRetry(
  id: string,
  options: ControlCommandIo = {},
): Promise<void> {
  const response = await requestControl({ cmd: "tasks.retry", id }, options);
  if (response === null) return;
  if (!response.data) {
    fail(`No failed task "${id}".`);
    return;
  }
  logger.success(`Task ${id} requeued.`);
}

export async function runTasksCancel(
  id: string,
  options: ControlCommandIo = {},
): Promise<void> {
  const response = await requestControl({ cmd: "tasks.cancel", id }, options);
  if (response === null) return;
  if (!response.data) {
    fail(`No pending task "${id}".`);
    return;
  }
  logger.success(`Task ${id} cancelled.`);
}

function deletionSelector(
  id: string | undefined,
  rawStatus: string | undefined,
): TaskSelector | string {
  if ((id === undefined) === (rawStatus === undefined)) {
    return "Give either a task id or --status.";
  }
  if (id !== undefined) return { id };
  const status = FINAL_TASK_STATUSES.find((candidate) => candidate === rawStatus);
  return status === undefined
    ? `Cannot delete "${rawStatus ?? ""}" tasks. Only ${FINAL_TASK_STATUSES.join(", ")} tasks can be deleted.`
    : { status };
}

export async function runTasksDelete(
  id: string | undefined,
  options: {
    status?: string | undefined;
    json?: boolean | undefined;
  } & ControlCommandIo = {},
): Promise<void> {
  const selector = deletionSelector(id, options.status);
  if (typeof selector === "string") {
    fail(selector);
    return;
  }
  const response = await requestControl({ cmd: "tasks.delete", ...selector }, options);
  if (response === null) return;
  const write = writerFor(options);
  if (options.json === true) {
    write(JSON.stringify(response.data, null, 2));
    return;
  }
  if ("id" in selector) {
    logger.success(`Task ${selector.id} deleted.`);
    return;
  }
  const count = response.data.deleted.length;
  if (count === 0) {
    write(`No ${selector.status} tasks.`);
    return;
  }
  logger.success(
    `${String(count)} ${selector.status} ${count === 1 ? "task" : "tasks"} deleted.`,
  );
}

const jsonArg = { type: "boolean", description: "Print JSON instead of text" } as const;

export const tasksCommand = defineCommand({
  meta: {
    name: "tasks",
    description: `Inspect and edit the running worker's task queue. ${SOCKET_ENV_HINT}`,
  },
  subCommands: {
    list: defineCommand({
      meta: { name: "list", description: "List tasks, optionally filtered by status" },
      args: {
        json: jsonArg,
        status: {
          type: "string",
          description: `Only tasks with this status (${TASK_STATUSES.join(", ")})`,
        },
      },
      run: ({ args }) => runTasksList({ json: args.json, status: args.status }),
    }),
    add: defineCommand({
      meta: { name: "add", description: "Queue a task for the executor" },
      args: {
        description: {
          type: "positional",
          required: true,
          description: "What the executor should do",
        },
        id: { type: "string", description: "Task id (default: generated)" },
        title: { type: "string", description: "Task title (default: the first line)" },
        json: jsonArg,
      },
      run: ({ args }) =>
        runTasksAdd(args.description, {
          id: args.id,
          title: args.title,
          json: args.json,
        }),
    }),
    retry: defineCommand({
      meta: { name: "retry", description: "Requeue a failed task" },
      args: {
        id: { type: "positional", required: true, description: "Task id" },
      },
      run: ({ args }) => runTasksRetry(args.id),
    }),
    cancel: defineCommand({
      meta: { name: "cancel", description: "Cancel a pending task" },
      args: {
        id: { type: "positional", required: true, description: "Task id" },
      },
      run: ({ args }) => runTasksCancel(args.id),
    }),
    delete: defineCommand({
      meta: {
        name: "delete",
        description: "Delete a finished task, or every task with a final status",
      },
      args: {
        id: { type: "positional", required: false, description: "Task id" },
        status: {
          type: "string",
          description: `Delete every task with this status (${FINAL_TASK_STATUSES.join(", ")})`,
        },
        json: jsonArg,
      },
      run: ({ args }) =>
        runTasksDelete(args.id, { status: args.status, json: args.json }),
    }),
  },
});
