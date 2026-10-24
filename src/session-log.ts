import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { formatSessionEvent, type SessionEventSink } from "./session-events.js";

function pad2(value: number): string {
  return value.toString().padStart(2, "0");
}

function dayStamp(now: Date): string {
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
}

function clockStamp(now: Date): string {
  return `${pad2(now.getHours())}-${pad2(now.getMinutes())}-${pad2(now.getSeconds())}`;
}

function timeStamp(now: Date): string {
  return `${pad2(now.getHours())}:${pad2(now.getMinutes())}:${pad2(now.getSeconds())}`;
}

function safeName(value: string): string {
  return value.replace(/[^\w.-]+/g, "_");
}

const DAY_DIR_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const CLOCK_PREFIX_PATTERN = /^\d{2}-\d{2}-\d{2}$/;
const CLOCK_PREFIX_LENGTH = 8;

async function entriesOf(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

export interface SessionLogPaths {
  log: string;
  jsonl: string;
}

interface SessionStreams {
  log: WriteStream;
  jsonl: WriteStream;
}

function flushStream(stream: WriteStream): Promise<void> {
  return new Promise((resolve) => stream.write("", () => resolve()));
}

export class SessionLog {
  private streams: SessionStreams | null = null;
  private readonly closing: Promise<void>[] = [];
  private readonly sessionPaths = new Map<string, SessionLogPaths[]>();

  constructor(
    private readonly dir: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  readonly sink: SessionEventSink = (event) => {
    if (event.type === "partial" || event.type === "spawned") return;
    const at = this.now();
    const streams =
      event.type === "init"
        ? this.openSession(at, event.sessionId)
        : (this.streams ?? this.openSession(at, "unknown"));
    if (event.type === "stream") {
      streams.jsonl.write(
        `${JSON.stringify({ ts: at.toISOString(), event: event.event })}\n`,
      );
      return;
    }
    if (event.type === "raw") {
      streams.jsonl.write(
        `${JSON.stringify({ ts: at.toISOString(), raw: event.line })}\n`,
      );
    }
    const prefix = `[${timeStamp(at)}]`;
    for (const line of formatSessionEvent(event).split("\n")) {
      streams.log.write(`${prefix} ${line}\n`);
    }
  };

  logPathsFor(sessionId: string): string[] {
    return (this.sessionPaths.get(sessionId) ?? []).map((paths) => paths.log);
  }

  async findLogPaths(sessionId: string): Promise<string[]> {
    const suffix = `-${safeName(sessionId)}.log`;
    const isSessionLog = (name: string): boolean =>
      CLOCK_PREFIX_PATTERN.test(name.slice(0, CLOCK_PREFIX_LENGTH)) &&
      name.slice(CLOCK_PREFIX_LENGTH) === suffix;
    const days = (await entriesOf(this.dir)).filter((day) => DAY_DIR_PATTERN.test(day));
    const found = await Promise.all(
      days.map(async (day) =>
        (await entriesOf(join(this.dir, day)))
          .filter(isSessionLog)
          .map((name) => join(this.dir, day, name)),
      ),
    );
    return [...new Set([...found.flat(), ...this.logPathsFor(sessionId)])].sort();
  }

  pathsFor(sessionId: string): SessionLogPaths | undefined {
    return this.sessionPaths.get(sessionId)?.at(-1);
  }

  async flush(): Promise<void> {
    const streams = this.streams;
    if (!streams) return;
    await Promise.all([flushStream(streams.log), flushStream(streams.jsonl)]);
  }

  async close(): Promise<void> {
    if (this.streams) this.endStreams(this.streams);
    this.streams = null;
    await Promise.all(this.closing.splice(0));
  }

  private openSession(at: Date, sessionId: string): SessionStreams {
    if (this.streams) this.endStreams(this.streams);
    const dayDir = join(this.dir, dayStamp(at));
    mkdirSync(dayDir, { recursive: true });
    const base = join(dayDir, `${clockStamp(at)}-${safeName(sessionId)}`);
    const paths: SessionLogPaths = { log: `${base}.log`, jsonl: `${base}.jsonl` };
    this.sessionPaths.set(sessionId, [
      ...(this.sessionPaths.get(sessionId) ?? []),
      paths,
    ]);
    this.streams = {
      log: createWriteStream(paths.log, { flags: "a" }),
      jsonl: createWriteStream(paths.jsonl, { flags: "a" }),
    };
    return this.streams;
  }

  private endStreams(streams: SessionStreams): void {
    for (const stream of [streams.log, streams.jsonl]) {
      this.closing.push(new Promise((resolve) => stream.end(() => resolve())));
    }
  }
}

export function teeSession<R extends { session: SessionEventSink }>(
  reporter: R,
  extra: SessionEventSink,
): R {
  return {
    ...reporter,
    session: (event) => {
      reporter.session(event);
      extra(event);
    },
  };
}
