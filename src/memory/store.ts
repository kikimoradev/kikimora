import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { z } from "zod";

export interface TaskSummaryRecord {
  id: number;
  taskId: string;
  attempt: number;
  ok: boolean;
  title: string;
  headline: string;
  summary: string;
  error: string | undefined;
  sessionId: string | undefined;
  createdAt: string;
}

export type NewTaskSummaryRecord = Omit<TaskSummaryRecord, "id">;

export const MEMORY_ORDERS = ["rank", "newest"] as const;

export type MemoryOrder = (typeof MEMORY_ORDERS)[number];

export interface MemoryFilter {
  beforeId?: number | undefined;
  ok?: boolean | undefined;
}

export interface MemorySearchOptions extends MemoryFilter {
  order?: MemoryOrder | undefined;
}

interface Conditions {
  sql: string;
  params: SQLInputValue[];
}

function conditionsOf(filter: MemoryFilter, table: string): Conditions {
  const clauses: string[] = [];
  const params: SQLInputValue[] = [];
  if (filter.beforeId !== undefined) {
    clauses.push(`${table}.id < ?`);
    params.push(filter.beforeId);
  }
  if (filter.ok !== undefined) {
    clauses.push(`${table}.ok = ?`);
    params.push(filter.ok ? 1 : 0);
  }
  return { sql: clauses.map((clause) => ` AND ${clause}`).join(""), params };
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS summaries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  ok INTEGER NOT NULL,
  title TEXT NOT NULL,
  headline TEXT NOT NULL,
  summary TEXT NOT NULL,
  error TEXT,
  session_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS summaries_task_id ON summaries (task_id);
CREATE VIRTUAL TABLE IF NOT EXISTS summaries_fts USING fts5(
  task_id, title, headline, summary,
  content='summaries', content_rowid='id'
);
`;

const rowSchema = z.object({
  id: z.number().int(),
  task_id: z.string(),
  attempt: z.number().int(),
  ok: z.number(),
  title: z.string(),
  headline: z.string(),
  summary: z.string(),
  error: z.string().nullable(),
  session_id: z.string().nullable(),
  created_at: z.string(),
});

function toRecord(row: unknown): TaskSummaryRecord {
  const parsed = rowSchema.parse(row);
  return {
    id: parsed.id,
    taskId: parsed.task_id,
    attempt: parsed.attempt,
    ok: parsed.ok !== 0,
    title: parsed.title,
    headline: parsed.headline,
    summary: parsed.summary,
    error: parsed.error ?? undefined,
    sessionId: parsed.session_id ?? undefined,
    createdAt: parsed.created_at,
  };
}

function matchPhrases(query: string): string[] {
  const tokens = query.match(/[\p{L}\p{N}_]+/gu) ?? [];
  return [...new Set(tokens.map((token) => token.toLowerCase()))].map(
    (token) => `"${token}"`,
  );
}

export function toMatchQuery(query: string): string | null {
  const phrases = matchPhrases(query);
  return phrases.length === 0 ? null : phrases.join(" OR ");
}

type WeightedEntry = [id: number, weight: number];

function outweighs(
  [idA, weightA]: WeightedEntry,
  [idB, weightB]: WeightedEntry,
): boolean {
  return weightA > weightB || (weightA === weightB && idA > idB);
}

function insertionPoint(top: WeightedEntry[], entry: WeightedEntry): number {
  let low = 0;
  let high = top.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    const other = top[middle];
    if (other === undefined || outweighs(entry, other)) {
      high = middle;
    } else {
      low = middle + 1;
    }
  }
  return low;
}

export function heaviest(weights: Map<number, number>, limit: number): number[] {
  const top: WeightedEntry[] = [];
  for (const entry of weights) {
    if (top.length >= limit) {
      const lightest = top.at(-1);
      if (lightest === undefined || !outweighs(entry, lightest)) continue;
      top.pop();
    }
    top.splice(insertionPoint(top, entry), 0, entry);
  }
  return top.map(([id]) => id);
}

export interface MemoryStoreOptions {
  readOnly?: boolean;
}

export class MemoryStore {
  private constructor(private readonly db: DatabaseSync) {}

  static open(path: string, options: MemoryStoreOptions = {}): MemoryStore {
    const readOnly = options.readOnly ?? false;
    if (!readOnly) {
      mkdirSync(dirname(path), { recursive: true });
    }
    const db = new DatabaseSync(path, { readOnly });
    if (!readOnly) {
      db.exec("PRAGMA journal_mode = WAL;");
      db.exec(SCHEMA);
    }
    return new MemoryStore(db);
  }

  get connection(): DatabaseSync {
    return this.db;
  }

  add(record: NewTaskSummaryRecord): TaskSummaryRecord {
    this.db.exec("BEGIN");
    try {
      const inserted = this.db
        .prepare(
          `INSERT INTO summaries
             (task_id, attempt, ok, title, headline, summary, error, session_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          record.taskId,
          record.attempt,
          record.ok ? 1 : 0,
          record.title,
          record.headline,
          record.summary,
          record.error ?? null,
          record.sessionId ?? null,
          record.createdAt,
        );
      const id = Number(inserted.lastInsertRowid);
      this.db
        .prepare(
          `INSERT INTO summaries_fts (rowid, task_id, title, headline, summary)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(id, record.taskId, record.title, record.headline, record.summary);
      this.db.exec("COMMIT");
      return { ...record, id };
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  search(
    query: string,
    limit = 10,
    options: MemorySearchOptions = {},
  ): TaskSummaryRecord[] {
    const match = toMatchQuery(query);
    if (match === null) return [];
    const conditions = conditionsOf(options, "s");
    const order =
      options.order === "newest" ? "s.id DESC" : "bm25(summaries_fts), s.id DESC";
    const rows = this.db
      .prepare(
        `SELECT s.*
         FROM summaries_fts
         JOIN summaries s ON s.id = summaries_fts.rowid
         WHERE summaries_fts MATCH ?${conditions.sql}
         ORDER BY ${order}
         LIMIT ?`,
      )
      .all(match, ...conditions.params, limit);
    return rows.map(toRecord);
  }

  latestMatches(query: string, limit = 10): TaskSummaryRecord[] {
    const phrases = matchPhrases(query);
    if (phrases.length === 0) return [];
    const entries = Number(
      this.db.prepare("SELECT count(*) AS entries FROM summaries").get()?.entries,
    );
    const matching = this.db.prepare(
      "SELECT rowid FROM summaries_fts WHERE summaries_fts MATCH ?",
    );
    matching.setReturnArrays(true);
    const idsMatching = (match: string): number[] =>
      matching.all(match).map((row) => Number(row[0]));
    const weights = new Map<number, number>();
    const addWeight = (ids: number[], weight: number): void => {
      for (const id of ids) weights.set(id, (weights.get(id) ?? 0) + weight);
    };
    for (const phrase of phrases) {
      const ids = idsMatching(phrase);
      const rarity = Math.log(1 + entries / ids.length);
      addWeight(ids, rarity);
      addWeight(idsMatching(`{task_id title} : ${phrase}`), rarity);
    }
    const picked = heaviest(weights, limit);
    if (picked.length === 0) return [];
    const rows = this.db
      .prepare(
        `SELECT * FROM summaries WHERE id IN (${picked.map(() => "?").join(", ")})
         ORDER BY id DESC`,
      )
      .all(...picked);
    return rows.map(toRecord);
  }

  recent(limit = 10, filter: MemoryFilter = {}): TaskSummaryRecord[] {
    const conditions = conditionsOf(filter, "summaries");
    const rows = this.db
      .prepare(
        `SELECT * FROM summaries WHERE 1 = 1${conditions.sql} ORDER BY id DESC LIMIT ?`,
      )
      .all(...conditions.params, limit);
    return rows.map(toRecord);
  }

  get(taskId: string): TaskSummaryRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM summaries WHERE task_id = ? ORDER BY id`)
      .all(taskId);
    return rows.map(toRecord);
  }

  exportTo(path: string): void {
    this.db.prepare("VACUUM INTO ?").run(path);
  }

  close(): void {
    this.db.close();
  }
}
