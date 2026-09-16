import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TaskStore } from "../src/tasks.js";
import type { NewTask } from "../src/types.js";
import { createTempDir, removeTempDir } from "./helpers.js";

function newTask(id: string, overrides: Partial<NewTask> = {}): NewTask {
  return { id, title: `Task ${id}`, description: `Description ${id}`, ...overrides };
}

describe("TaskStore", () => {
  let dir: string;
  let path: string;

  beforeEach(async () => {
    dir = await createTempDir();
    path = join(dir, "data", "tasks.json");
  });

  afterEach(() => removeTempDir(dir));

  it("opens an empty store when the file does not exist", async () => {
    const store = await TaskStore.open(path);
    expect(store.pendingCount()).toBe(0);
    expect(await store.takeNext()).toBeUndefined();
  });

  it("adds new tasks and returns the ones actually added", async () => {
    const store = await TaskStore.open(path);
    const added = await store.addTasks([newTask("a"), newTask("b")]);

    expect(added.map((t) => t.id)).toEqual(["a", "b"]);
    expect(added[0]?.status).toBe("pending");
    expect(store.pendingCount()).toBe(2);
  });

  it("deduplicates against pending tasks", async () => {
    const store = await TaskStore.open(path);
    await store.addTasks([newTask("a")]);

    const added = await store.addTasks([newTask("a"), newTask("b")]);

    expect(added.map((t) => t.id)).toEqual(["b"]);
    expect(store.pendingCount()).toBe(2);
  });

  it("deduplicates against history (done and failed)", async () => {
    const store = await TaskStore.open(path);
    await store.addTasks([newTask("done-1"), newTask("failed-1")]);
    await store.takeNext();
    await store.complete("done-1");
    await store.takeNext();
    await store.fail("failed-1", "error");

    const added = await store.addTasks([newTask("done-1"), newTask("failed-1")]);

    expect(added).toEqual([]);
    expect(store.pendingCount()).toBe(0);
  });

  it("takeNext returns the oldest pending and marks it in_progress", async () => {
    const store = await TaskStore.open(path);
    await store.addTasks([newTask("a"), newTask("b")]);

    const first = await store.takeNext();
    const second = await store.takeNext();

    expect(first?.id).toBe("a");
    expect(first?.status).toBe("in_progress");
    expect(second?.id).toBe("b");
    expect(await store.takeNext()).toBeUndefined();
  });

  it("complete and fail persist the status with the error", async () => {
    const store = await TaskStore.open(path);
    await store.addTasks([newTask("a"), newTask("b")]);
    await store.takeNext();
    await store.complete("a");
    await store.takeNext();
    await store.fail("b", "did not work");

    const file = JSON.parse(await readFile(path, "utf8")) as {
      tasks: { id: string; status: string; error?: string }[];
    };
    const byId = new Map(file.tasks.map((t) => [t.id, t]));
    expect(byId.get("a")?.status).toBe("done");
    expect(byId.get("b")?.status).toBe("failed");
    expect(byId.get("b")?.error).toBe("did not work");
  });

  it("keeps tasks after reopening", async () => {
    const store = await TaskStore.open(path);
    await store.addTasks([newTask("a")]);

    const reopened = await TaskStore.open(path);

    expect(reopened.pendingCount()).toBe(1);
    expect((await reopened.takeNext())?.id).toBe("a");
  });

  it("resets orphaned in_progress to pending on open", async () => {
    const store = await TaskStore.open(path);
    await store.addTasks([newTask("a")]);
    await store.takeNext();

    const reopened = await TaskStore.open(path);

    expect(reopened.pendingCount()).toBe(1);
    expect((await reopened.takeNext())?.id).toBe("a");
  });

  it("does not leave a temporary file after writing", async () => {
    const store = await TaskStore.open(path);
    await store.addTasks([newTask("a")]);

    expect(existsSync(`${path}.tmp`)).toBe(false);
    expect(existsSync(path)).toBe(true);
  });

  it("throws a readable error on corrupted JSON", async () => {
    await TaskStore.open(path);
    await writeFile(path, "not json", "utf8");

    await expect(TaskStore.open(path)).rejects.toThrow(/Corrupted task store file/);
  });

  it("throws a readable error on an incompatible format", async () => {
    await TaskStore.open(path);
    await writeFile(path, JSON.stringify({ version: 2, tasks: [] }), "utf8");

    await expect(TaskStore.open(path)).rejects.toThrow(/unexpected data format/);
  });

  it("takeNext counts execution attempts", async () => {
    const store = await TaskStore.open(path);
    await store.addTasks([newTask("a")]);

    const taken = await store.takeNext();

    expect(taken?.attempts).toBe(1);
  });

  it("requeue restores the task to pending, keeps attempts and saves the error", async () => {
    const store = await TaskStore.open(path);
    await store.addTasks([newTask("a")]);
    await store.takeNext();

    await store.requeue("a", "broken connection");

    expect(store.list()[0]).toMatchObject({
      id: "a",
      status: "pending",
      attempts: 1,
      error: "broken connection",
    });

    const again = await store.takeNext();
    expect(again?.attempts).toBe(2);
  });

  it("release restores the task to pending and gives the attempt back", async () => {
    const store = await TaskStore.open(path);
    await store.addTasks([newTask("a")]);
    await store.takeNext();

    await store.release("a", "usage limit reached");

    expect(store.list()[0]).toMatchObject({
      id: "a",
      status: "pending",
      attempts: 0,
      error: "usage limit reached",
    });

    const again = await store.takeNext();
    expect(again?.attempts).toBe(1);
  });

  it("release without a reason gives the attempt back and keeps the last error", async () => {
    const store = await TaskStore.open(path);
    await store.addTasks([newTask("a")]);
    await store.takeNext();
    await store.requeue("a", "API Error: overloaded");
    await store.takeNext();

    await store.release("a");

    expect(store.list()[0]).toMatchObject({
      id: "a",
      status: "pending",
      attempts: 1,
      error: "API Error: overloaded",
    });
  });

  it("release of an unknown id is ignored", async () => {
    const store = await TaskStore.open(path);
    await store.addTasks([newTask("a")]);

    await store.release("not-there", "error");

    expect(store.list()).toHaveLength(1);
    expect(store.list()[0]?.status).toBe("pending");
  });

  it("requeue of an unknown id is ignored", async () => {
    const store = await TaskStore.open(path);
    await store.addTasks([newTask("a")]);

    await store.requeue("not-there", "error");

    expect(store.list()).toHaveLength(1);
    expect(store.list()[0]?.status).toBe("pending");
  });

  it("retry restores a failed task to pending, resets attempts and clears the error", async () => {
    const store = await TaskStore.open(path);
    await store.addTasks([newTask("a")]);
    await store.takeNext();
    await store.fail("a", "broken");

    expect(await store.retry("a")).toBe(true);

    expect(store.list()[0]).toMatchObject({ id: "a", status: "pending", attempts: 0 });
    expect(store.list()[0]?.error).toBeUndefined();
    expect((await store.takeNext())?.attempts).toBe(1);
  });

  it("retry refuses tasks that are not failed and unknown ids", async () => {
    const store = await TaskStore.open(path);
    await store.addTasks([newTask("a")]);

    expect(await store.retry("a")).toBe(false);
    expect(await store.retry("missing")).toBe(false);
    expect(store.list()[0]?.status).toBe("pending");
  });

  it("cancel marks a pending task as cancelled and persists it", async () => {
    const store = await TaskStore.open(path);
    await store.addTasks([newTask("a")]);

    expect(await store.cancel("a")).toBe(true);

    expect(store.list()[0]?.status).toBe("cancelled");
    expect(store.pendingCount()).toBe(0);
    expect(await store.takeNext()).toBeUndefined();

    const reopened = await TaskStore.open(path);
    expect(reopened.list()[0]?.status).toBe("cancelled");
  });

  it("cancel refuses in_progress tasks and unknown ids", async () => {
    const store = await TaskStore.open(path);
    await store.addTasks([newTask("a")]);
    await store.takeNext();

    expect(await store.cancel("a")).toBe(false);
    expect(await store.cancel("missing")).toBe(false);
    expect(store.list()[0]?.status).toBe("in_progress");
  });

  it("loads an old-format store without the attempts field", async () => {
    await TaskStore.open(path);
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        tasks: [
          {
            id: "old",
            title: "Old task",
            description: "Description",
            status: "pending",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      }),
      "utf8",
    );

    const reopened = await TaskStore.open(path);

    expect(reopened.list()[0]?.attempts).toBe(0);
  });

  it("list returns copies of tasks — mutating the result does not corrupt the store", async () => {
    const store = await TaskStore.open(path);
    await store.addTasks([newTask("a")]);

    const listed = store.list();
    expect(listed.map((t) => t.id)).toEqual(["a"]);

    const first = listed[0];
    if (!first) throw new Error("expected a task on the list");
    first.status = "failed";
    expect(store.list()[0]?.status).toBe("pending");
    expect(store.pendingCount()).toBe(1);
  });

  it("onChange notifies with a fresh snapshot after each mutation", async () => {
    const store = await TaskStore.open(path);
    const snapshots: string[][] = [];
    store.onChange((tasks) => snapshots.push(tasks.map((t) => `${t.id}:${t.status}`)));

    await store.addTasks([newTask("a")]);
    await store.takeNext();
    await store.complete("a");

    expect(snapshots).toEqual([["a:pending"], ["a:in_progress"], ["a:done"]]);
  });

  it("onChange does not notify when a mutation changes nothing", async () => {
    const store = await TaskStore.open(path);
    await store.addTasks([newTask("a")]);
    const calls: number[] = [];
    store.onChange((tasks) => calls.push(tasks.length));

    await store.addTasks([newTask("a")]);

    expect(calls).toEqual([]);
  });

  it("unsubscribe from onChange stops notifications", async () => {
    const store = await TaskStore.open(path);
    let calls = 0;
    const unsubscribe = store.onChange(() => {
      calls += 1;
    });

    await store.addTasks([newTask("a")]);
    expect(calls).toBe(1);

    unsubscribe();
    await store.addTasks([newTask("b")]);
    expect(calls).toBe(1);
  });

  it("concurrent mutations do not interleave and leave a consistent file", async () => {
    const store = await TaskStore.open(path);
    const ids = Array.from({ length: 20 }, (_, i) => `t-${i}`);

    await Promise.all(ids.map((id) => store.addTasks([newTask(id)])));
    await Promise.all([
      store.takeNext(),
      store.takeNext(),
      store.addTasks([newTask("t-1"), newTask("extra")]),
    ]);

    const file = JSON.parse(await readFile(path, "utf8")) as {
      tasks: { id: string; status: string }[];
    };
    expect(file.tasks).toHaveLength(21);
    expect(file.tasks.filter((t) => t.status === "in_progress")).toHaveLength(2);
    expect(store.pendingCount()).toBe(19);
  });
});
