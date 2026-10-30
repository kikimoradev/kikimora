import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import {
  isFinalTaskStatus,
  type FinalTaskStatus,
  type NewTask,
  type Task,
  type TaskHandoff,
  type TaskResume,
  type TaskStatus,
} from "./types.js";

const taskSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  description: z.string(),
  status: z.enum(["pending", "in_progress", "done", "failed", "cancelled"]),
  attempts: z.number().int().nonnegative().default(0),
  createdAt: z.string(),
  updatedAt: z.string(),
  error: z.string().optional(),
  resume: z
    .object({
      sessionId: z.string().min(1),
      limitedAt: z.iso.datetime(),
      costUsd: z.number().nonnegative().optional(),
    })
    .optional(),
  handedOff: z.boolean().optional(),
  handoffReason: z.string().optional(),
});

const storeFileSchema = z.object({
  version: z.literal(1),
  tasks: z.array(taskSchema),
});

function corruptStoreError(path: string, reason: string): Error {
  return new Error(
    `Corrupted task store file (${path}): ${reason}\nFix or delete the file and restart.`,
  );
}

export type TaskSelector = { id: string } | { status: FinalTaskStatus };

export type TaskDeletion =
  | { ok: true; deleted: string[] }
  | { ok: false; reason: "missing"; id: string }
  | {
      ok: false;
      reason: "unfinished";
      id: string;
      status: Exclude<TaskStatus, FinalTaskStatus>;
    };

const TASK_TITLE_MAX = 60;

let manualTaskCounter = 0;

export function buildManualTask(description: string): NewTask {
  manualTaskCounter += 1;
  const id = `manual-${Date.now().toString(36)}-${manualTaskCounter.toString(36)}`;
  const firstLine = description.split("\n", 1)[0] ?? description;
  const title =
    firstLine.length > TASK_TITLE_MAX
      ? `${firstLine.slice(0, TASK_TITLE_MAX - 1)}…`
      : firstLine;
  return { id, title, description };
}

function markHandoff(task: Task, handoff: TaskHandoff | undefined): void {
  if (handoff === undefined) {
    delete task.handedOff;
    delete task.handoffReason;
  } else {
    task.handedOff = true;
    task.handoffReason = handoff.reason;
  }
}

export class TaskStore {
  private chain: Promise<unknown> = Promise.resolve();
  private readonly listeners = new Set<(tasks: Task[]) => void>();

  private constructor(
    private readonly path: string,
    private readonly tasks: Task[],
  ) {}

  static async open(path: string): Promise<TaskStore> {
    await mkdir(dirname(path), { recursive: true });

    let raw: string | undefined;
    try {
      raw = await readFile(path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }

    let tasks: Task[] = [];
    if (raw !== undefined) {
      let json: unknown;
      try {
        json = JSON.parse(raw);
      } catch {
        throw corruptStoreError(path, "not valid JSON");
      }
      const parsed = storeFileSchema.safeParse(json);
      if (!parsed.success) {
        throw corruptStoreError(path, "unexpected data format");
      }
      tasks = parsed.data.tasks;
    }

    const store = new TaskStore(path, tasks);
    await store.resetStaleInProgress();
    return store;
  }

  private run<T>(op: () => Promise<T>): Promise<T> {
    const result = this.chain.then(op, op);
    this.chain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async persist(): Promise<void> {
    const tmpPath = `${this.path}.tmp`;
    const payload = JSON.stringify({ version: 1, tasks: this.tasks }, null, 2);
    await writeFile(tmpPath, `${payload}\n`, "utf8");
    await rename(tmpPath, this.path);
    this.notifyChanged();
  }

  private notifyChanged(): void {
    if (this.listeners.size === 0) return;
    const snapshot = this.list();
    for (const listener of this.listeners) listener(snapshot);
  }

  private resetStaleInProgress(): Promise<void> {
    return this.run(async () => {
      const stale = this.tasks.filter((task) => task.status === "in_progress");
      if (stale.length === 0) return;
      const now = new Date().toISOString();
      for (const task of stale) {
        task.status = "pending";
        task.updatedAt = now;
      }
      await this.persist();
    });
  }

  addTasks(candidates: NewTask[]): Promise<Task[]> {
    return this.run(async () => {
      const now = new Date().toISOString();
      const added: Task[] = [];
      for (const candidate of candidates) {
        if (this.tasks.some((task) => task.id === candidate.id)) continue;
        const task: Task = {
          id: candidate.id,
          title: candidate.title,
          description: candidate.description,
          status: "pending",
          attempts: 0,
          createdAt: now,
          updatedAt: now,
        };
        this.tasks.push(task);
        added.push({ ...task });
      }
      if (added.length > 0) await this.persist();
      return added;
    });
  }

  peekNext(): Task | undefined {
    const task = this.tasks.find((candidate) => candidate.status === "pending");
    return task === undefined ? undefined : { ...task };
  }

  takeNext(): Promise<Task | undefined> {
    return this.run(async () => {
      const task = this.tasks.find((candidate) => candidate.status === "pending");
      if (!task) return undefined;
      task.status = "in_progress";
      task.attempts += 1;
      task.updatedAt = new Date().toISOString();
      await this.persist();
      return { ...task };
    });
  }

  complete(id: string, handoff?: TaskHandoff): Promise<void> {
    return this.setStatus(id, "done", undefined, handoff);
  }

  fail(id: string, error: string, handoff?: TaskHandoff): Promise<void> {
    return this.setStatus(id, "failed", error, handoff);
  }

  release(id: string, error?: string): Promise<void> {
    return this.run(async () => {
      const task = this.tasks.find((candidate) => candidate.id === id);
      if (!task) return;
      task.status = "pending";
      task.attempts = Math.max(0, task.attempts - 1);
      if (error !== undefined) task.error = error;
      task.updatedAt = new Date().toISOString();
      await this.persist();
    });
  }

  suspend(id: string, error: string, resume: TaskResume): Promise<void> {
    return this.run(async () => {
      const task = this.tasks.find((candidate) => candidate.id === id);
      if (!task) return;
      task.status = "pending";
      task.attempts = Math.max(0, task.attempts - 1);
      task.error = error;
      task.resume = { ...resume };
      task.updatedAt = new Date().toISOString();
      await this.persist();
    });
  }

  forgetResume(id: string, error: string): Promise<void> {
    return this.run(async () => {
      const task = this.tasks.find((candidate) => candidate.id === id);
      if (!task) return;
      task.status = "pending";
      task.attempts = Math.max(0, task.attempts - 1);
      task.error = error;
      task.resume = undefined;
      task.updatedAt = new Date().toISOString();
      await this.persist();
    });
  }

  requeue(id: string, error: string, handoff?: TaskHandoff): Promise<void> {
    return this.run(async () => {
      const task = this.tasks.find((candidate) => candidate.id === id);
      if (!task) return;
      task.status = "pending";
      task.error = error;
      task.resume = undefined;
      markHandoff(task, handoff);
      task.updatedAt = new Date().toISOString();
      await this.persist();
    });
  }

  retry(id: string): Promise<boolean> {
    return this.run(async () => {
      const task = this.tasks.find((candidate) => candidate.id === id);
      if (task?.status !== "failed") return false;
      task.status = "pending";
      task.attempts = 0;
      task.error = undefined;
      markHandoff(task, undefined);
      task.updatedAt = new Date().toISOString();
      await this.persist();
      return true;
    });
  }

  cancel(id: string): Promise<boolean> {
    return this.run(async () => {
      const task = this.tasks.find((candidate) => candidate.id === id);
      if (task?.status !== "pending") return false;
      task.status = "cancelled";
      task.updatedAt = new Date().toISOString();
      await this.persist();
      return true;
    });
  }

  delete(selector: TaskSelector): Promise<TaskDeletion> {
    return this.run(async () => {
      if ("id" in selector) {
        const task = this.tasks.find((candidate) => candidate.id === selector.id);
        if (task === undefined) return { ok: false, reason: "missing", id: selector.id };
        if (!isFinalTaskStatus(task.status)) {
          return { ok: false, reason: "unfinished", id: task.id, status: task.status };
        }
      }
      const selected = (task: Task): boolean =>
        "id" in selector ? task.id === selector.id : task.status === selector.status;
      const deleted = this.tasks.filter(selected).map((task) => task.id);
      if (deleted.length === 0) return { ok: true, deleted };
      const kept = this.tasks.filter((task) => !selected(task));
      this.tasks.splice(0, this.tasks.length, ...kept);
      await this.persist();
      return { ok: true, deleted };
    });
  }

  private setStatus(
    id: string,
    status: "done" | "failed",
    error: string | undefined,
    handoff: TaskHandoff | undefined,
  ): Promise<void> {
    return this.run(async () => {
      const task = this.tasks.find((candidate) => candidate.id === id);
      if (!task) return;
      task.status = status;
      task.updatedAt = new Date().toISOString();
      task.error = error;
      task.resume = undefined;
      markHandoff(task, handoff);
      await this.persist();
    });
  }

  pendingCount(): number {
    return this.tasks.filter((task) => task.status === "pending").length;
  }

  list(): Task[] {
    return this.tasks.map((task) => ({ ...task }));
  }

  onChange(listener: (tasks: Task[]) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}
