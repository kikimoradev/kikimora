import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  heaviest,
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

function seededRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 48271) % 2147483647;
    return state / 2147483647;
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

function shuffled<T>(values: T[], random: () => number): T[] {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1));
    [result[index], result[other]] = [result[other] as T, result[index] as T];
  }
  return result;
}

function heaviestBySort(weights: Map<number, number>, limit: number): number[] {
  return [...weights]
    .sort(([idA, weightA], [idB, weightB]) => weightB - weightA || idB - idA)
    .slice(0, limit)
    .map(([id]) => id);
}

describe("heaviest", () => {
  it("picks the same entries in the same order as a full sort, ties included", () => {
    const random = seededRandom(49);
    for (let round = 0; round < 2000; round += 1) {
      const levels = 1 + Math.floor(random() * 5);
      const size = Math.floor(random() * 81);
      const ids = shuffled(
        Array.from({ length: size }, (_, index) => index + 1),
        random,
      );
      const weights = new Map(
        ids.map((id) => [id, Math.floor(random() * levels)] as const),
      );
      const limit = 1 + Math.floor(random() * 100);

      expect(heaviest(weights, limit)).toEqual(heaviestBySort(weights, limit));
    }
  });

  it("keeps the newest entries when every entry has the same weight", () => {
    const ascending = new Map(
      Array.from({ length: 20_000 }, (_, index) => [index + 1, 1] as const),
    );
    const descending = new Map([...ascending].reverse());
    const newest = Array.from({ length: 50 }, (_, index) => 20_000 - index);

    expect(heaviest(ascending, 50)).toEqual(newest);
    expect(heaviest(descending, 50)).toEqual(newest);
    expect(heaviest(ascending, 1)).toEqual([20_000]);
  });

  it("returns nothing for an empty map or a limit of zero", () => {
    expect(heaviest(new Map(), 10)).toEqual([]);
    expect(heaviest(new Map([[1, 1]]), 0)).toEqual([]);
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

  it("latestMatches keeps the latest among entries of equal weight whatever the word order", () => {
    store.add(
      buildRecord({
        taskId: "redmine-1",
        title: "Note",
        headline: "Note",
        summary: "beta",
      }),
    );
    const newer = store.add(
      buildRecord({
        taskId: "redmine-2",
        title: "Note",
        headline: "Note",
        summary: "alpha",
      }),
    );

    expect(store.latestMatches("alpha beta", 1).map((r) => r.id)).toEqual([newer.id]);
    expect(store.latestMatches("beta alpha", 1).map((r) => r.id)).toEqual([newer.id]);
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

  it("latestMatches keeps the attempts at an issue when its number comes with common words", () => {
    const random = seededRandom(17);
    const frequencies: [string, number][] = [
      ["the", 0.97],
      ["we", 0.75],
      ["for", 0.7],
      ["fix", 0.4],
      ["test", 0.45],
      ["how", 0.05],
      ["did", 0.08],
      ["review", 0.3],
      ["code", 0.35],
      ["what", 0.1],
      ["happened", 0.02],
      ["in", 0.95],
      ["of", 0.95],
      ["issue", 0.4],
    ];
    const vocabulary = Array.from({ length: 2000 }, (_, i) => `v${i.toString(36)}`);
    const summaryWith = (extra: string): string => {
      const words = frequencies.filter(([, p]) => random() < p).map(([word]) => word);
      for (let i = 0; i < 100; i += 1) {
        words.push(vocabulary[Math.floor(random() ** 2 * vocabulary.length)] ?? "");
      }
      return `${words.join(" ")} ${extra}`;
    };
    for (let i = 0; i < 600; i += 1) {
      const issue = i >= 300 && i % 30 === 0 ? "53035" : String(60000 + i);
      store.add(
        buildRecord({
          taskId: `redmine-${issue}-cr`,
          title: `Code review ${issue}`,
          headline: "Reviewed",
          summary: summaryWith(issue === "53035" ? issue : ""),
        }),
      );
    }

    for (const query of [
      "how did we fix the test for 53035",
      "what happened in the code review of issue 53035",
    ]) {
      const matches = store.latestMatches(query, 5);
      expect(matches.map((r) => r.taskId)).toEqual(Array(5).fill("redmine-53035-cr"));
      expect(matches.map((r) => r.id)).toEqual(
        matches.map((r) => r.id).toSorted((a, b) => b - a),
      );
    }
  });

  it("latestMatches keeps the attempts at an issue when half of memory shares the other query words", () => {
    const chores = [
      "We checked the diff and ran the tests before pushing the branch.",
      "The review found a missing null check in the handler; we fixed it.",
      "Updated the migration and the seed data for the new column.",
    ];
    for (let i = 1; i <= 100; i += 1) {
      store.add(
        buildRecord({
          taskId: `redmine-${String(i)}`,
          title: `Task ${String(i)}`,
          summary: `How did we fix the test? ${chores[i % chores.length] ?? ""}`,
        }),
      );
    }
    for (let attempt = 1; attempt <= 15; attempt += 1) {
      store.add(
        buildRecord({
          taskId: "redmine-53035-cr",
          attempt,
          title: "Code review 53035",
          summary: `Code review of issue 53035. ${attempt <= 5 ? "We could not fix the failing test yet." : "Waiting for the reviewer."}`,
        }),
      );
    }
    for (let i = 101; i <= 200; i += 1) {
      store.add(
        buildRecord({
          taskId: `redmine-${String(i)}`,
          title: `Task ${String(i)}`,
          summary: `Code review done. ${chores[i % chores.length] ?? ""}`,
        }),
      );
    }

    expect(
      store.latestMatches("how did we fix the test for 53035", 3).map((r) => r.attempt),
    ).toEqual([5, 4, 3]);
    expect(
      store.latestMatches("how did we fix the test for 53035", 5).map((r) => r.attempt),
    ).toEqual([5, 4, 3, 2, 1]);
  });

  it("latestMatches counts a word found in the task id or the title once more", () => {
    const inTaskId = store.add(
      buildRecord({
        taskId: "redmine-53035-cr",
        title: "Code review",
        summary: "Reviewed.",
      }),
    );
    const inTitle = store.add(
      buildRecord({
        taskId: "redmine-9-cr",
        title: "Backport of 53035",
        summary: "Done.",
      }),
    );
    store.add(
      buildRecord({
        taskId: "redmine-10",
        title: "Docs",
        headline: "Linked 53035",
        summary: "Done.",
      }),
    );
    store.add(
      buildRecord({ taskId: "redmine-11", title: "Docs", summary: "Mentions 53035." }),
    );

    expect(store.latestMatches("53035", 2).map((r) => r.id)).toEqual([
      inTitle.id,
      inTaskId.id,
    ]);
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
