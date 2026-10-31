import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMemoryMcpServer, handoffTargetOf } from "../../src/memory/mcp.js";
import { MemoryStore } from "../../src/memory/store.js";
import { createTempDir, removeTempDir } from "../helpers.js";

interface TextContent {
  type: string;
  text: string;
}

function firstText(result: unknown): string {
  const content = (result as { content?: TextContent[] }).content;
  const block = content?.[0];
  if (block?.type !== "text") throw new Error("missing text block");
  return block.text;
}

describe("memory MCP server", () => {
  let dir: string;
  let store: MemoryStore;
  let client: Client;

  beforeEach(async () => {
    dir = await createTempDir();
    store = MemoryStore.open(join(dir, "memory.db"));
    store.add({
      taskId: "redmine-1",
      attempt: 1,
      ok: true,
      title: "Fix export",
      headline: "Fixed CSV export",
      summary: "The cause was a missing Content-Type header.",
      error: undefined,
      sessionId: "session-1",
      createdAt: "2026-07-02T10:00:00.000Z",
    });
    store.add({
      taskId: "redmine-1",
      attempt: 2,
      ok: false,
      title: "Fix export",
      headline: "Export regression",
      summary: "Deploy overwrote the fix.",
      error: "timeout",
      sessionId: "session-2",
      createdAt: "2026-07-02T11:00:00.000Z",
    });

    const server = createMemoryMcpServer(store);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "test", version: "1.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  });

  afterEach(async () => {
    await client.close();
    store.close();
    await removeTempDir(dir);
  });

  it("exposes the memory_search and memory_get tools", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["memory_get", "memory_search"]);
  });

  it("memory_search returns formatted hits", async () => {
    const result = await client.callTool({
      name: "memory_search",
      arguments: { query: "export csv" },
    });

    const text = firstText(result);
    expect(text).toContain("redmine-1 — Fixed CSV export");
    expect(text).toContain("result: success");
    expect(text).toContain("missing Content-Type header");
  });

  it("memory_search returns the newest entries first by default", async () => {
    const result = await client.callTool({
      name: "memory_search",
      arguments: { query: "export content type header" },
    });

    const text = firstText(result);
    expect(text.indexOf("Export regression")).toBeLessThan(
      text.indexOf("Fixed CSV export"),
    );
  });

  it("memory_search returns the best match first when asked for rank order", async () => {
    const result = await client.callTool({
      name: "memory_search",
      arguments: { query: "export content type header", order: "rank" },
    });

    const text = firstText(result);
    expect(text.indexOf("Fixed CSV export")).toBeLessThan(
      text.indexOf("Export regression"),
    );
  });

  it("memory_search picks the best matches of a multi-word query before it lists them newest first", async () => {
    const add = (taskId: string, headline: string, summary: string): void => {
      store.add({
        taskId,
        attempt: 1,
        ok: true,
        title: "Code review",
        headline,
        summary,
        error: undefined,
        sessionId: `session-${taskId}`,
        createdAt: "2026-10-22T12:00:00.000Z",
      });
    };
    add(
      "redmine-53035-cr",
      "Blog search relevance defect",
      "53035: the blog search ranks drafts above published posts; relevance weights were inverted.",
    );
    add(
      "redmine-53036-cr",
      "Blog teaser",
      "Blog search relevance looks fine on the teaser.",
    );
    for (let issue = 60_000; issue < 60_010; issue += 1) {
      add(
        `redmine-${String(issue)}-cr`,
        `Review ${String(issue)}`,
        "Redmine review of the blog.",
      );
    }

    const search = async (order?: string): Promise<string[]> => {
      const result = await client.callTool({
        name: "memory_search",
        arguments: {
          query: "53035 blog search relevance",
          limit: 3,
          ...(order === undefined ? {} : { order }),
        },
      });
      return [...firstText(result).matchAll(/^### (\S+)/gm)].map(
        (match) => match[1] ?? "",
      );
    };

    const newest = await search();
    const rank = await search("rank");
    expect(rank.slice(0, 2)).toEqual(["redmine-53035-cr", "redmine-53036-cr"]);
    expect(newest).toEqual([rank[2], "redmine-53036-cr", "redmine-53035-cr"]);
  });

  it("memory_search keeps the latest attempts at a task when one word matches more entries than the limit", async () => {
    for (let attempt = 1; attempt <= 12; attempt += 1) {
      store.add({
        taskId: "redmine-53035-cr",
        attempt,
        ok: attempt === 12,
        title: "Code review",
        headline: `Review attempt ${String(attempt)}`,
        summary: `Review of 53035. ${"Checked the diff again. ".repeat(attempt)}`,
        error: undefined,
        sessionId: `session-${String(attempt)}`,
        createdAt: "2026-10-22T12:00:00.000Z",
      });
    }

    const result = await client.callTool({
      name: "memory_search",
      arguments: { query: "53035", limit: 3 },
    });

    expect(
      [...firstText(result).matchAll(/^Attempt: (\d+)/gm)].map((match) => match[1]),
    ).toEqual(["12", "11", "10"]);
  });

  it("memory_search rejects an unknown order", async () => {
    const result = await client.callTool({
      name: "memory_search",
      arguments: { query: "export", order: "oldest" },
    });

    expect(result.isError).toBe(true);
  });

  it("memory_search with no hits returns a readable message", async () => {
    const result = await client.callTool({
      name: "memory_search",
      arguments: { query: "kubernetes" },
    });

    expect(firstText(result)).toBe("No results in memory.");
  });

  it("memory_search respects the limit", async () => {
    const result = await client.callTool({
      name: "memory_search",
      arguments: { query: "export export", limit: 1 },
    });

    expect(firstText(result).match(/###/g)).toHaveLength(1);
  });

  it("memory_get returns the full task history with attempt errors", async () => {
    const result = await client.callTool({
      name: "memory_get",
      arguments: { taskId: "redmine-1" },
    });

    const text = firstText(result);
    expect(text).toContain("Fixed CSV export");
    expect(text).toContain("Export regression");
    expect(text).toContain("Error: timeout");
    expect(text).toContain("result: failure");
  });

  it("memory_get returns a readable message for an unknown task", async () => {
    const result = await client.callTool({
      name: "memory_get",
      arguments: { taskId: "missing" },
    });

    expect(firstText(result)).toBe("No summaries for this task.");
  });

  it("memory_get and memory_search show a handoff to a human after the attempt line", async () => {
    store.add({
      taskId: "redmine-1",
      attempt: 3,
      ok: true,
      title: "Fix export",
      headline: "Left the export for the owner",
      summary: "The fix needs a decision on the CSV dialect.",
      error: undefined,
      sessionId: "session-3",
      createdAt: "2026-07-02T12:00:00.000Z",
      handedOff: true,
      handoffReason: "Needs the owner's approval of the budget",
    });

    const history = firstText(
      await client.callTool({ name: "memory_get", arguments: { taskId: "redmine-1" } }),
    );
    const search = firstText(
      await client.callTool({ name: "memory_search", arguments: { query: "dialect" } }),
    );

    for (const text of [history, search]) {
      expect(text).toContain(
        "Attempt: 3, result: success, date: 2026-07-02T12:00:00.000Z\n" +
          "Handed off to a human: Needs the owner's approval of the budget\n",
      );
    }
    expect(history.match(/Handed off to a human/g)).toHaveLength(1);
  });
});

describe("memory MCP server with a handoff target", () => {
  let dir: string;
  let file: string;
  let store: MemoryStore;
  let client: Client;

  beforeEach(async () => {
    dir = await createTempDir();
    file = join(dir, "data", "handoff.json");
    store = MemoryStore.open(join(dir, "memory.db"));
    const server = createMemoryMcpServer(store, { handoff: { taskId: "t-1", file } });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "test", version: "1.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  });

  afterEach(async () => {
    await client.close();
    store.close();
    await removeTempDir(dir);
  });

  const handoff = (reason: string) =>
    client.callTool({ name: "task_handoff", arguments: { reason } });

  const markOnDisk = async (): Promise<unknown> =>
    JSON.parse(await readFile(file, "utf8")) as unknown;

  it("exposes task_handoff next to the memory tools", async () => {
    const { tools } = await client.listTools();

    expect(tools.map((t) => t.name).sort()).toEqual([
      "memory_get",
      "memory_search",
      "task_handoff",
    ]);
  });

  it("writes the mark of the session's task and confirms it", async () => {
    const result = await handoff("line one\n\n  line two");

    expect(result.isError).not.toBe(true);
    expect(firstText(result)).toBe(
      "Task t-1 marked as handed off to a human: line one line two. " +
        "Finish the task as usual; the mark travels with its result.",
    );
    expect(await markOnDisk()).toEqual({
      taskId: "t-1",
      reason: "line one line two",
      markedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/) as unknown,
    });
  });

  it("keeps the last mark when called twice", async () => {
    await handoff("first");
    await handoff("second");

    expect(await markOnDisk()).toMatchObject({ taskId: "t-1", reason: "second" });
  });

  it("rejects an empty or too long reason without writing a mark", async () => {
    const empty = await handoff("   ");
    const long = await handoff("a".repeat(201));

    expect(empty.isError).toBe(true);
    expect(firstText(empty)).toContain("empty");
    expect(long.isError).toBe(true);
    expect(firstText(long)).toContain("the limit is 200");
    await expect(readdir(dir)).resolves.not.toContain("data");
  });
});

describe("handoffTargetOf", () => {
  it("needs both the task and the file", () => {
    expect(handoffTargetOf("t-1", "/data/handoff.json")).toEqual({
      taskId: "t-1",
      file: "/data/handoff.json",
    });
    expect(handoffTargetOf(undefined, "/data/handoff.json")).toBeUndefined();
    expect(handoffTargetOf("t-1", undefined)).toBeUndefined();
    expect(handoffTargetOf("", "/data/handoff.json")).toBeUndefined();
    expect(handoffTargetOf("t-1", "")).toBeUndefined();
  });
});
