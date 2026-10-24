import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MemoryStore,
  toMatchQuery,
  type NewTaskSummaryRecord,
} from "../../src/memory/store.js";
import { createTempDir, removeTempDir } from "../helpers.js";

function buildRecord(
  overrides: Partial<NewTaskSummaryRecord> = {},
): NewTaskSummaryRecord {
  return {
    taskId: "redmine-1",
    attempt: 1,
    ok: true,
    title: "Fix export",
    headline: "Fixed CSV export",
    summary: "The cause was a missing Content-Type header.",
    error: undefined,
    sessionId: "session-1",
    createdAt: "2026-07-02T10:00:00.000Z",
    ...overrides,
  };
}

describe("toMatchQuery", () => {
  it("joins tokens into an alternative of quoted phrases", () => {
    expect(toMatchQuery("connection error redmine")).toBe(
      '"connection" OR "error" OR "redmine"',
    );
  });

  it("neutralizes FTS5 syntax", () => {
    expect(toMatchQuery('redmine AND "export" (NOT x*)')).toBe(
      '"redmine" OR "and" OR "export" OR "not" OR "x"',
    );
  });

  it("lists a word once whatever its case", () => {
    expect(toMatchQuery("Blog blog BLOG relevance")).toBe('"blog" OR "relevance"');
  });

  it("returns null for empty queries", () => {
    expect(toMatchQuery("")).toBeNull();
    expect(toMatchQuery('   ()"* ')).toBeNull();
  });
});

describe("MemoryStore", () => {
  let dir: string;
  let dbPath: string;
  let store: MemoryStore;

  beforeEach(async () => {
    dir = await createTempDir();
    dbPath = join(dir, "data", "memory.db");
    store = MemoryStore.open(dbPath);
  });

  afterEach(async () => {
    store.close();
    await removeTempDir(dir);
  });

  it("creates the database file along with a missing directory", () => {
    const record = store.add(buildRecord());
    expect(record.id).toBeGreaterThan(0);
  });

  it("add returns a record with an assigned id, and get reads task history in insertion order", () => {
    const first = store.add(buildRecord({ ok: false, error: "timeout" }));
    const second = store.add(buildRecord({ attempt: 2, headline: "Second attempt" }));
    store.add(buildRecord({ taskId: "redmine-2", headline: "Other task" }));

    const history = store.get("redmine-1");
    expect(history.map((r) => r.id)).toEqual([first.id, second.id]);
    expect(history[0]).toEqual(first);
    expect(history[0]?.ok).toBe(false);
    expect(history[0]?.error).toBe("timeout");
    expect(history[1]?.attempt).toBe(2);
  });

  it("get returns an empty list for an unknown task", () => {
    expect(store.get("missing")).toEqual([]);
  });

  it("search finds records by summary content", () => {
    store.add(
      buildRecord({ summary: "Redmine rejected requests without an API token." }),
    );
    store.add(
      buildRecord({
        taskId: "email-1",
        headline: "Handled the mailbox",
        summary: "The IMAP mailbox requires an app password.",
      }),
    );

    const results = store.search("token api redmine");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.taskId).toBe("redmine-1");
  });

  it("search matches accented characters and folds decomposable diacritics", () => {
    store.add(buildRecord({ summary: "Café connection to the database." }));

    expect(store.search("café")).toHaveLength(1);
    expect(store.search("cafe")).toHaveLength(1);
  });

  it("search sorts by bm25 relevance", () => {
    store.add(
      buildRecord({
        taskId: "redmine-2",
        headline: "Application deployment",
        summary: "Deployment via deploy.sh, requires the DEPLOY_ENV variable.",
      }),
    );
    store.add(
      buildRecord({
        taskId: "redmine-3",
        headline: "Deployment fix",
        summary: "Deploy failed because deploy.sh assumed deploy-keys were present.",
      }),
    );

    const results = store.search("deploy");
    expect(results.map((r) => r.taskId)).toEqual(["redmine-3", "redmine-2"]);
  });

  it("search respects the limit", () => {
    for (let i = 0; i < 5; i += 1) {
      store.add(buildRecord({ taskId: `redmine-${i}`, summary: `deployment ${i}` }));
    }

    expect(store.search("deployment", 2)).toHaveLength(2);
  });

  it("recent returns the newest records first and respects the limit", () => {
    const first = store.add(buildRecord({ taskId: "redmine-1" }));
    const second = store.add(buildRecord({ taskId: "redmine-2" }));
    const third = store.add(buildRecord({ taskId: "redmine-3" }));

    expect(store.recent().map((r) => r.id)).toEqual([third.id, second.id, first.id]);
    expect(store.recent(2).map((r) => r.id)).toEqual([third.id, second.id]);
  });

  it("recent pages below an entry and keeps the entries of one outcome", () => {
    const first = store.add(buildRecord({ taskId: "redmine-1", ok: false }));
    const second = store.add(buildRecord({ taskId: "redmine-2" }));
    const third = store.add(buildRecord({ taskId: "redmine-3", ok: false }));
    const fourth = store.add(buildRecord({ taskId: "redmine-4" }));

    expect(store.recent(10, { beforeId: third.id }).map((r) => r.id)).toEqual([
      second.id,
      first.id,
    ]);
    expect(store.recent(10, { ok: false }).map((r) => r.id)).toEqual([
      third.id,
      first.id,
    ]);
    expect(store.recent(10, { ok: true, beforeId: fourth.id }).map((r) => r.id)).toEqual([
      second.id,
    ]);
    expect(store.recent(1, { beforeId: fourth.id }).map((r) => r.id)).toEqual([third.id]);
  });

  it("search orders newest first on request and pages below an entry by outcome", () => {
    const relevant = store.add(
      buildRecord({ taskId: "redmine-1", summary: "deploy deploy deploy deploy" }),
    );
    const failed = store.add(
      buildRecord({ taskId: "redmine-2", ok: false, summary: "deploy once" }),
    );
    const newest = store.add(buildRecord({ taskId: "redmine-3", summary: "deploy" }));

    expect(store.search("deploy", 10, { order: "newest" }).map((r) => r.id)).toEqual([
      newest.id,
      failed.id,
      relevant.id,
    ]);
    expect(store.search("deploy", 10).map((r) => r.id)[0]).toBe(relevant.id);
    expect(
      store
        .search("deploy", 10, { order: "newest", beforeId: newest.id })
        .map((r) => r.id),
    ).toEqual([failed.id, relevant.id]);
    expect(store.search("deploy", 10, { ok: false }).map((r) => r.id)).toEqual([
      failed.id,
    ]);
  });

  it("search ranks equally relevant entries newest first", () => {
    const older = store.add(
      buildRecord({ taskId: "redmine-1", summary: "deploy failed" }),
    );
    const newer = store.add(
      buildRecord({ taskId: "redmine-2", summary: "deploy failed" }),
    );

    expect(store.search("deploy", 10).map((r) => r.id)).toEqual([newer.id, older.id]);
  });

  it("latestMatches keeps the latest entries of a one-word query with more matches than the limit", () => {
    for (let attempt = 1; attempt <= 12; attempt += 1) {
      store.add(
        buildRecord({
          taskId: "redmine-53035-cr",
          attempt,
          summary: `Review of 53035. ${"Checked the diff again. ".repeat(attempt)}`,
        }),
      );
    }

    expect(store.latestMatches("53035", 3).map((r) => r.attempt)).toEqual([12, 11, 10]);
    expect(store.search("53035", 3).map((r) => r.attempt)).toEqual([1, 2, 3]);
  });

  it("latestMatches picks the entries with the most query words and lists them newest first", () => {
    const relevant = store.add(
      buildRecord({ taskId: "redmine-1", summary: "deploy failed on a timeout" }),
    );
    const partial = store.add(
      buildRecord({ taskId: "redmine-2", summary: "deploy failed" }),
    );
    const newest = store.add(
      buildRecord({ taskId: "redmine-3", summary: "deploy done" }),
    );

    expect(store.latestMatches("deploy failed timeout", 2).map((r) => r.id)).toEqual([
      partial.id,
      relevant.id,
    ]);
    expect(store.latestMatches("deploy failed timeout").map((r) => r.id)).toEqual([
      newest.id,
      partial.id,
      relevant.id,
    ]);
  });

  it("latestMatches counts a repeated query word once", () => {
    store.add(buildRecord({ taskId: "redmine-1", summary: "blog teaser" }));
    const newer = store.add(
      buildRecord({ taskId: "redmine-2", summary: "search relevance" }),
    );

    expect(store.latestMatches("blog blog relevance", 1).map((r) => r.id)).toEqual([
      newer.id,
    ]);
    expect(store.latestMatches("Blog blog relevance", 1).map((r) => r.id)).toEqual([
      newer.id,
    ]);
  });

  it("latestMatches weighs a query word by its rarity, so common words do not push out the topic", () => {
    const relevant = store.add(
      buildRecord({
        taskId: "redmine-blog",
        title: "Blog search",
        headline: "Fixed blog search relevance",
        summary:
          "Blog search relevance was poor; fixed the Elasticsearch analyzer for the blog index.",
      }),
    );
    for (let attempt = 1; attempt <= 12; attempt += 1) {
      store.add(
        buildRecord({
          taskId: `redmine-flaky-${String(attempt)}`,
          title: "Flaky test",
          headline: "Stabilized a flaky test",
          summary: "How did we fix the flaky test? We retried the request in the test.",
        }),
      );
    }

    expect(
      store.latestMatches("how did we fix the blog search relevance", 5).map((r) => r.id),
    ).toContain(relevant.id);
  });

  it("latestMatches keeps the latest attempts at a task when every attempt has all query words", () => {
    for (let attempt = 1; attempt <= 12; attempt += 1) {
      store.add(
        buildRecord({
          taskId: "redmine-70000-cr",
          attempt,
          title: "Code review",
          summary: `Code review of 70000. ${"Checked the diff again. ".repeat(attempt)}`,
        }),
      );
    }
    store.add(
      buildRecord({ taskId: "redmine-70001-cr", summary: "Code review of 70001." }),
    );

    expect(store.latestMatches("70000 code review", 3).map((r) => r.attempt)).toEqual([
      12, 11, 10,
    ]);
    expect(store.latestMatches("70000", 3).map((r) => r.attempt)).toEqual([12, 11, 10]);
  });

  it("latestMatches returns nothing for a query without words", () => {
    store.add(buildRecord());

    expect(store.latestMatches('  ()"* ')).toEqual([]);
  });

  it("recent returns an empty list for an empty store", () => {
    expect(store.recent()).toEqual([]);
  });

  it("search returns an empty list for a query without tokens", () => {
    store.add(buildRecord());
    expect(store.search('"()*')).toEqual([]);
  });

  it("does not save a partial record on a transaction error", () => {
    store.add(buildRecord());
    const broken = buildRecord({ attempt: 2 });
    Object.defineProperty(broken, "headline", {
      get() {
        return { bad: "value" };
      },
    });

    expect(() => store.add(broken)).toThrow();
    expect(store.get("redmine-1")).toHaveLength(1);
    expect(store.search("export")).toHaveLength(1);
  });

  it("a read-only reader sees the writer's records and cannot write", () => {
    store.add(buildRecord());

    const reader = MemoryStore.open(dbPath, { readOnly: true });
    try {
      expect(reader.get("redmine-1")).toHaveLength(1);

      store.add(buildRecord({ attempt: 2 }));
      expect(reader.get("redmine-1")).toHaveLength(2);

      expect(() => reader.add(buildRecord({ attempt: 3 }))).toThrow();
    } finally {
      reader.close();
    }
  });

  it("read-only open does not create a missing database", () => {
    expect(() =>
      MemoryStore.open(join(dir, "missing", "memory.db"), { readOnly: true }),
    ).toThrow();
  });
});
