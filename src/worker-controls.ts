import type { MemoryExport } from "./memory/export.js";
import type { TaskSummaryRecord } from "./memory/store.js";
import type { SessionListQuery, SessionRecord } from "./sessions/index.js";
import type { TaskDeletion, TaskSelector } from "./tasks.js";
import type { NewTask, Task } from "./types.js";

export interface TaskControls {
  list(): Task[];
  retry(id: string): Promise<boolean>;
  cancel(id: string): Promise<boolean>;
  delete(selector: TaskSelector): Promise<TaskDeletion>;
  addTasks(tasks: NewTask[]): Promise<Task[]>;
}

export interface MemoryReader {
  recent(limit: number): TaskSummaryRecord[];
  search(query: string, limit: number): TaskSummaryRecord[];
}

export interface MemoryExporter {
  export(path: string): Promise<MemoryExport>;
}

export interface SessionReader {
  list(query: SessionListQuery): SessionRecord[];
  get(sessionId: string): SessionRecord | undefined;
}
