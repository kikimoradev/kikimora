import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdmissionGate, LOCAL_LEASE, type AdmissionLease } from "../src/admission.js";
import { runSession, type SessionSpec } from "../src/runner.js";
import { NO_LAUNCHER } from "../src/session-launcher.js";
import {
  buildSessionSpec,
  createSessionEventCollector,
  createTempDir,
  fakeClaudeEnv,
  fakeClaudePath,
  fixturesDir,
  removeTempDir,
  type SessionEventCollector,
} from "./helpers.js";

const fakeLauncher = [process.execPath, join(fixturesDir, "launcher")];
const posixOnly = it.skipIf(process.platform === "win32");

interface LauncherRecord {
  pid: number;
  argv: string[];
  env: Record<string, string>;
}

interface ClaudeRecord {
  pid: number;
  env: Record<string, string>;
}

interface TreeRecord {
  attached: number[];
  orphaned: number[];
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function killQuietly(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    return;
  }
}

function kikimoraVars(env: NodeJS.ProcessEnv): Record<string, string | undefined> {
  return Object.fromEntries(
    Object.entries(env).filter(([key]) => key.startsWith("KIKIMORA_")),
  );
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

async function grantedLease(gate: AdmissionGate): Promise<AdmissionLease> {
  const waiting = gate.acquire("executor", {
    signal: new AbortController().signal,
    interrupted: () => new Promise(() => undefined),
    taskId: "ci-7",
    onWait: (wait) => {
      setImmediate(() => gate.grant("executor", wait.ticket));
    },
  });
  const lease = await waiting;
  if (lease === null) throw new Error("the gate granted no lease");
  return lease;
}

describe("runSession (integration with fake claude)", () => {
  let dir: string;
  let collector: SessionEventCollector;

  beforeEach(async () => {
    dir = await createTempDir();
    collector = createSessionEventCollector();
  });

  afterEach(() => removeTempDir(dir));

  it("returns success and a summary from result", async () => {
    const spec = buildSessionSpec(collector.sink, { childEnv: fakeClaudeEnv("ok") });
    const result = await runSession(spec, new AbortController().signal);

    expect(result.ok).toBe(true);
    expect(result.costUsd).toBeCloseTo(0.0123);
    expect(result.numTurns).toBe(2);
    expect(result.sessionId).toBe("sess-1");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  }, 15_000);

  it("passes resultText from the result event", async () => {
    const spec = buildSessionSpec(collector.sink, {
      childEnv: fakeClaudeEnv("ok", {
        FAKE_CLAUDE_RESULT_TEXT: '{"tasks": []}',
      }),
    });
    const result = await runSession(spec, new AbortController().signal);

    expect(result.ok).toBe(true);
    expect(result.resultText).toBe('{"tasks": []}');
  }, 15_000);

  it("returns an error when result has is_error", async () => {
    const spec = buildSessionSpec(collector.sink, {
      childEnv: fakeClaudeEnv("error_result"),
    });
    const result = await runSession(spec, new AbortController().signal);

    expect(result.ok).toBe(false);
    expect(result.error).toBe("Session ended with an error (is_error)");
    expect(result.failureReason).toBe("isError");
  }, 15_000);

  it("surfaces the 401 api_retry and terminal reason of an invalid token", async () => {
    const spec = buildSessionSpec(collector.sink, {
      childEnv: fakeClaudeEnv("auth_error"),
    });
    const result = await runSession(spec, new AbortController().signal);

    expect(result.ok).toBe(false);
    expect(result.failureReason).toBe("isError");
    expect(result.apiError).toEqual({ status: 401, code: "authentication_failed" });
    expect(result.terminalReason).toBe("api_error");
    expect(result.resultText).toContain("401");
  }, 15_000);

  it("passes the not-logged-in result text without an api error", async () => {
    const spec = buildSessionSpec(collector.sink, {
      childEnv: fakeClaudeEnv("not_logged_in"),
    });
    const result = await runSession(spec, new AbortController().signal);

    expect(result.ok).toBe(false);
    expect(result.apiError).toBeUndefined();
    expect(result.resultText).toBe("Not logged in · Please run /login");
  }, 15_000);

  it("returns an error with the exit code on a non-zero code", async () => {
    const spec = buildSessionSpec(collector.sink, {
      childEnv: fakeClaudeEnv("exit_nonzero"),
    });
    const result = await runSession(spec, new AbortController().signal);

    expect(result.ok).toBe(false);
    expect(result.error).toContain("Process exited with code 2");
  }, 15_000);

  it("returns a spawn error when the command is missing", async () => {
    const spec = buildSessionSpec(collector.sink, {
      command: "claude-does-not-exist-xyz",
      launcher: NO_LAUNCHER,
    });
    const result = await runSession(spec, new AbortController().signal);

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/^Failed to start/);
  }, 15_000);

  it("kills the session after the timeout is exceeded", async () => {
    const spec = buildSessionSpec(collector.sink, {
      childEnv: fakeClaudeEnv("hang"),
      sessionTimeoutMs: 200,
    });
    const result = await runSession(spec, new AbortController().signal);

    expect(result.ok).toBe(false);
    expect(result.error).toBe("Session timed out");
    expect(result.failureReason).toBe("timeout");
  }, 15_000);

  it("aborts the session on the abort signal", async () => {
    const spec = buildSessionSpec(collector.sink, { childEnv: fakeClaudeEnv("hang") });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 150);
    const result = await runSession(spec, controller.signal);

    expect(result.ok).toBe(false);
    expect(result.error).toBe("Session aborted");
  }, 15_000);

  it("emits child process stderr as a session event", async () => {
    const spec = buildSessionSpec(collector.sink, {
      childEnv: fakeClaudeEnv("exit_nonzero"),
    });
    await runSession(spec, new AbortController().signal);

    expect(collector.events).toContainEqual({
      type: "stderr",
      line: expect.stringContaining("something went wrong") as string,
    });
  }, 15_000);

  it("always runs the session in bypassPermissions mode", async () => {
    const out = join(dir, "received-args.json");
    const spec = buildSessionSpec(collector.sink, {
      childEnv: fakeClaudeEnv("ok", { FAKE_CLAUDE_ARGS_OUT: out }),
    });
    await runSession(spec, new AbortController().signal);

    const args = JSON.parse(await readFile(out, "utf8")) as string[];
    const flagIndex = args.indexOf("--permission-mode");
    expect(flagIndex).toBeGreaterThanOrEqual(0);
    expect(args[flagIndex + 1]).toBe("bypassPermissions");
  }, 15_000);

  it("turns off the attribution Claude Code adds to commits and pull requests", async () => {
    const out = join(dir, "args-settings.json");
    const spec = buildSessionSpec(collector.sink, {
      childEnv: fakeClaudeEnv("ok", { FAKE_CLAUDE_ARGS_OUT: out }),
    });
    await runSession(spec, new AbortController().signal);

    const args = JSON.parse(await readFile(out, "utf8")) as string[];
    const flagIndex = args.indexOf("--settings");
    expect(flagIndex).toBeGreaterThanOrEqual(0);
    expect(JSON.parse(args[flagIndex + 1] ?? "")).toStrictEqual({
      attribution: { commit: "", pr: "" },
    });
  }, 15_000);

  it("passes the effort from the spec as the --effort flag", async () => {
    const out = join(dir, "args-effort.json");
    const spec = buildSessionSpec(collector.sink, {
      effort: "max",
      childEnv: fakeClaudeEnv("ok", { FAKE_CLAUDE_ARGS_OUT: out }),
    });
    await runSession(spec, new AbortController().signal);

    const args = JSON.parse(await readFile(out, "utf8")) as string[];
    const flagIndex = args.indexOf("--effort");
    expect(flagIndex).toBeGreaterThanOrEqual(0);
    expect(args[flagIndex + 1]).toBe("max");
  }, 15_000);

  it("points --mcp-config at the session config file", async () => {
    const out = join(dir, "args-mcp.json");
    const mcpConfigPath = join(dir, "mcp", "executor.json");
    const spec = buildSessionSpec(collector.sink, {
      mcpConfigPath,
      childEnv: fakeClaudeEnv("ok", { FAKE_CLAUDE_ARGS_OUT: out }),
    });
    await runSession(spec, new AbortController().signal);

    const args = JSON.parse(await readFile(out, "utf8")) as string[];
    const flagIndex = args.indexOf("--mcp-config");
    expect(flagIndex).toBeGreaterThanOrEqual(0);
    expect(args[flagIndex + 1]).toBe(mcpConfigPath);
  }, 15_000);

  it("always adds --strict-mcp-config so no outside MCP configuration is inherited", async () => {
    const out = join(dir, "args-strict-mcp.json");
    const spec = buildSessionSpec(collector.sink, {
      childEnv: fakeClaudeEnv("ok", { FAKE_CLAUDE_ARGS_OUT: out }),
    });
    await runSession(spec, new AbortController().signal);

    const args = JSON.parse(await readFile(out, "utf8")) as string[];
    expect(args).toContain("--mcp-config");
    expect(args).toContain("--strict-mcp-config");
    expect(args).not.toContain("--json-schema");
  }, 15_000);

  it("with jsonSchema adds the --json-schema flag", async () => {
    const out = join(dir, "args-json-schema.json");
    const jsonSchema = '{"type":"object"}';
    const spec = buildSessionSpec(collector.sink, {
      jsonSchema,
      childEnv: fakeClaudeEnv("ok", { FAKE_CLAUDE_ARGS_OUT: out }),
    });
    await runSession(spec, new AbortController().signal);

    const args = JSON.parse(await readFile(out, "utf8")) as string[];
    const flagIndex = args.indexOf("--json-schema");
    expect(flagIndex).toBeGreaterThanOrEqual(0);
    expect(args[flagIndex + 1]).toBe(jsonSchema);
  }, 15_000);

  it("passes the prompt from the spec to the child process stdin", async () => {
    const out = join(dir, "received-prompt.txt");
    const spec = buildSessionSpec(collector.sink, {
      prompt: "my task\n",
      childEnv: fakeClaudeEnv("ok", { FAKE_CLAUDE_PROMPT_OUT: out }),
    });
    await runSession(spec, new AbortController().signal);

    expect(await readFile(out, "utf8")).toBe("my task\n");
  }, 15_000);

  it("selects the fake behavior by model (_MODEL suffix)", async () => {
    const spec = buildSessionSpec(collector.sink, {
      model: "haiku",
      childEnv: fakeClaudeEnv("exit_nonzero", {
        FAKE_CLAUDE_MODE_HAIKU: "ok",
        FAKE_CLAUDE_RESULT_TEXT_HAIKU: "haiku report",
      }),
    });
    const result = await runSession(spec, new AbortController().signal);

    expect(result.ok).toBe(true);
    expect(result.resultText).toBe("haiku report");
  }, 15_000);

  it("passes the fable alias through to the --model flag untouched", async () => {
    const out = join(dir, "args-fable.json");
    const spec = buildSessionSpec(collector.sink, {
      model: "fable",
      childEnv: fakeClaudeEnv("exit_nonzero", {
        FAKE_CLAUDE_MODE_FABLE: "ok",
        FAKE_CLAUDE_ARGS_OUT_FABLE: out,
      }),
    });
    const result = await runSession(spec, new AbortController().signal);

    expect(result.ok).toBe(true);
    const args = JSON.parse(await readFile(out, "utf8")) as string[];
    const flagIndex = args.indexOf("--model");
    expect(args[flagIndex + 1]).toBe("fable");
  }, 15_000);

  it("carries the session meta into the init event", async () => {
    const spec = buildSessionSpec(collector.sink, {
      meta: { agent: "executor", taskId: "ci-42" },
      childEnv: fakeClaudeEnv("ok"),
    });
    await runSession(spec, new AbortController().signal);

    expect(collector.events).toContainEqual({
      type: "init",
      model: "haiku",
      sessionId: "sess-1",
      toolCount: 2,
      taskId: "ci-42",
      cycle: undefined,
    });
  }, 15_000);

  it("records the session in the index, opening it on init and closing it on the result", async () => {
    const started = vi.fn();
    const finished = vi.fn();
    const spec = buildSessionSpec(collector.sink, {
      meta: { agent: "monitor", cycle: 3 },
      index: { started, finished },
      childEnv: fakeClaudeEnv("ok"),
    });

    await runSession(spec, new AbortController().signal);

    expect(started).toHaveBeenCalledWith({
      sessionId: "sess-1",
      agent: "monitor",
      cycle: 3,
      taskId: undefined,
      model: "haiku",
      startedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/) as string,
    });
    expect(finished).toHaveBeenCalledWith({
      sessionId: "sess-1",
      finishedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/) as string,
      ok: true,
      failureReason: undefined,
      costUsd: 0.0123,
      numTurns: 2,
    });
  }, 15_000);

  it("closes a killed session with its failure reason and no cost", async () => {
    const finished = vi.fn();
    const controller = new AbortController();
    const spec = buildSessionSpec(collector.sink, {
      index: { started: vi.fn(), finished },
      childEnv: fakeClaudeEnv("hang_after_init"),
    });
    const running = runSession(spec, controller.signal);
    await vi.waitFor(() =>
      expect(collector.events).toContainEqual(expect.objectContaining({ type: "init" })),
    );
    controller.abort();
    await running;

    expect(finished).toHaveBeenCalledWith(
      expect.objectContaining({ ok: false, failureReason: "abort", costUsd: undefined }),
    );
  }, 15_000);

  it("records nothing when the session never reaches init", async () => {
    const started = vi.fn();
    const finished = vi.fn();
    const spec = buildSessionSpec(collector.sink, {
      command: join(dir, "missing-binary"),
      launcher: NO_LAUNCHER,
      index: { started, finished },
    });

    const result = await runSession(spec, new AbortController().signal);

    expect(result.failureReason).toBe("spawn");
    expect(started).not.toHaveBeenCalled();
    expect(finished).not.toHaveBeenCalled();
  }, 15_000);
});

describe("runSession with a session launcher", () => {
  let dir: string;
  let collector: SessionEventCollector;

  beforeEach(async () => {
    dir = await createTempDir();
    collector = createSessionEventCollector();
  });

  afterEach(() => removeTempDir(dir));

  it("starts the session through the launcher with its role, pool and ticket", async () => {
    const launcherOut = join(dir, "launcher.json");
    const claudeOut = join(dir, "claude.json");
    const gate = new AdmissionGate("external");
    const lease = await grantedLease(gate);
    const slotPids: (number | undefined)[] = [];
    const spec = buildSessionSpec(
      (event) => {
        collector.sink(event);
        if (event.type === "spawned") {
          const slot = gate.status().executor;
          slotPids.push(slot.state === "holding" ? slot.pid : undefined);
        }
      },
      {
        launcher: fakeLauncher,
        meta: { agent: "summarizer", taskId: "ci-7" },
        placement: { pool: "executor", lease },
        childEnv: fakeClaudeEnv("ok", {
          FAKE_LAUNCHER_OUT: launcherOut,
          FAKE_CLAUDE_ENV_OUT: claudeOut,
          KIKIMORA_SESSION_ROLE: "stale",
        }),
      },
    );

    const result = await runSession(spec, new AbortController().signal);

    expect(result.ok).toBe(true);
    const launcher = await readJson<LauncherRecord>(launcherOut);
    expect(launcher.argv.slice(0, 3)).toEqual([fakeClaudePath, "-p", "--model"]);
    const placement = {
      KIKIMORA_SESSION_ROLE: "summarizer",
      KIKIMORA_ADMISSION_POOL: "executor",
      KIKIMORA_ADMISSION_TICKET: lease.ticket,
    };
    expect(launcher.env).toMatchObject(placement);
    expect((await readJson<ClaudeRecord>(claudeOut)).env).toMatchObject(placement);
    expect(collector.events[0]).toEqual({
      type: "spawned",
      pid: launcher.pid,
      role: "summarizer",
      pool: "executor",
      ticket: lease.ticket,
      seq: expect.any(Number) as number,
    });
    expect(slotPids).toEqual([launcher.pid]);
    const after = gate.status().executor;
    expect(after.state).toBe("holding");
    expect(after.state === "holding" ? after.pid : "idle").toBeUndefined();
  }, 15_000);

  it("leaves the ticket out without a supervisor, even when the worker inherited one", async () => {
    const launcherOut = join(dir, "launcher-local.json");
    const childEnv = fakeClaudeEnv("ok", {
      FAKE_LAUNCHER_OUT: launcherOut,
      KIKIMORA_ADMISSION_TICKET: "inherited",
    });
    const spec = buildSessionSpec(collector.sink, {
      launcher: fakeLauncher,
      placement: { pool: "monitor", lease: LOCAL_LEASE },
      childEnv,
    });

    await runSession(spec, new AbortController().signal);

    const { env } = await readJson<LauncherRecord>(launcherOut);
    expect(env).not.toHaveProperty("KIKIMORA_ADMISSION_TICKET");
    expect(env).toEqual({
      ...kikimoraVars(childEnv),
      KIKIMORA_ADMISSION_TICKET: undefined,
      KIKIMORA_SESSION_ROLE: "monitor",
      KIKIMORA_ADMISSION_POOL: "monitor",
    });
    expect(collector.events[0]).toEqual({
      type: "spawned",
      pid: expect.any(Number) as number,
      role: "monitor",
      pool: "monitor",
      ticket: undefined,
      seq: undefined,
    });
  }, 15_000);

  posixOnly(
    "without a launcher spawns claude itself and passes the environment through untouched",
    async () => {
      const argsOut = join(dir, "direct-args.json");
      const claudeOut = join(dir, "direct-claude.json");
      const childEnv = fakeClaudeEnv("ok", {
        FAKE_CLAUDE_ARGS_OUT: argsOut,
        FAKE_CLAUDE_ENV_OUT: claudeOut,
        KIKIMORA_LOG_FORMAT: "json",
      });
      const spec = buildSessionSpec(collector.sink, { launcher: NO_LAUNCHER, childEnv });

      await runSession(spec, new AbortController().signal);

      const claude = await readJson<ClaudeRecord>(claudeOut);
      expect(claude.env).toEqual(kikimoraVars(childEnv));
      expect(claude.env).not.toHaveProperty("KIKIMORA_SESSION_ROLE");
      expect((await readJson<string[]>(argsOut))[0]).toBe("-p");
      expect(collector.events[0]).toMatchObject({ type: "spawned", pid: claude.pid });
    },
    15_000,
  );

  it("reports a launcher that cannot start as a spawn failure", async () => {
    const missing = join(dir, "missing-launcher");
    const spec = buildSessionSpec(collector.sink, { launcher: [missing] });

    const result = await runSession(spec, new AbortController().signal);

    expect(result.failureReason).toBe("spawn");
    expect(result.error).toContain(missing);
    expect(collector.events).toEqual([]);
  }, 15_000);
});

describe("runSession reading the launcher's verdict", () => {
  let collector: SessionEventCollector;

  beforeEach(() => {
    collector = createSessionEventCollector();
  });

  function launchedSpec(
    mode: string,
    launcherEnv: Record<string, string>,
    overrides: Partial<SessionSpec> = {},
  ): SessionSpec {
    return buildSessionSpec(collector.sink, {
      launcher: fakeLauncher,
      childEnv: fakeClaudeEnv(mode, launcherEnv),
      ...overrides,
    });
  }

  it("treats exit code 75 before Claude Code starts as a refusal to place the session", async () => {
    const started = vi.fn();
    const finished = vi.fn();
    const spec = launchedSpec(
      "ok",
      { FAKE_LAUNCHER_EXIT_BEFORE: "75" },
      { index: { started, finished } },
    );

    const result = await runSession(spec, new AbortController().signal);

    expect(result).toMatchObject({
      ok: false,
      failureReason: "launcherRefused",
      error: "Session launcher refused the session (exit code 75)",
    });
    expect(collector.events[0]).toMatchObject({ type: "spawned" });
    expect(started).not.toHaveBeenCalled();
    expect(finished).not.toHaveBeenCalled();
  }, 15_000);

  it("treats exit code 75 after Claude Code started as an ordinary exit", async () => {
    const spec = launchedSpec("ok", { FAKE_LAUNCHER_EXIT_AFTER: "75" });

    const result = await runSession(spec, new AbortController().signal);

    expect(result).toMatchObject({
      ok: false,
      failureReason: "exit",
      error: "Process exited with code 75",
    });
  }, 15_000);

  it("blames the pool memory limit when a waiting launcher exits with 137", async () => {
    const finished = vi.fn();
    const spec = launchedSpec(
      "killed_after_init",
      { FAKE_LAUNCHER_EXIT_AFTER: "137" },
      { index: { started: vi.fn(), finished } },
    );

    const result = await runSession(spec, new AbortController().signal);

    expect(result).toMatchObject({
      ok: false,
      failureReason: "poolMemoryLimit",
      error: "Session killed by the pool memory limit",
    });
    expect(finished).toHaveBeenCalledWith(
      expect.objectContaining({ ok: false, failureReason: "poolMemoryLimit" }),
    );
  }, 15_000);

  posixOnly(
    "blames the pool memory limit when the session a launcher exec'd dies by SIGKILL",
    async () => {
      const spec = launchedSpec(
        "killed_after_init",
        {},
        { launcher: ["/bin/sh", "-c", 'exec "$@"', "launch"] },
      );

      const result = await runSession(spec, new AbortController().signal);

      expect(result.failureReason).toBe("poolMemoryLimit");
    },
    15_000,
  );

  posixOnly(
    "keeps a SIGKILL without a launcher an ordinary exit",
    async () => {
      const spec = launchedSpec("killed_after_init", {}, { launcher: NO_LAUNCHER });

      const result = await runSession(spec, new AbortController().signal);

      expect(result).toMatchObject({
        ok: false,
        failureReason: "exit",
        error: "Process terminated by signal SIGKILL",
      });
    },
    15_000,
  );

  it("keeps a session the worker stopped itself a timeout, whatever the launcher reports", async () => {
    const spec = launchedSpec(
      "hang_after_init",
      { FAKE_LAUNCHER_EXIT_AFTER: "137" },
      { sessionTimeoutMs: 1_000 },
    );

    const result = await runSession(spec, new AbortController().signal);

    expect(result.failureReason).toBe("timeout");
  }, 15_000);
});

describe("runSession stopping the session process tree", () => {
  let dir: string;
  let tree: TreeRecord | undefined;

  beforeEach(async () => {
    dir = await createTempDir();
    tree = undefined;
  });

  afterEach(async () => {
    for (const pid of [...(tree?.attached ?? []), ...(tree?.orphaned ?? [])]) {
      killQuietly(pid);
    }
    await removeTempDir(dir);
  });

  async function runTree(trigger: "timeout" | "abort"): Promise<TreeRecord> {
    const treeOut = join(dir, `tree-${trigger}.json`);
    const collector = createSessionEventCollector();
    const controller = new AbortController();
    const spec = buildSessionSpec(collector.sink, {
      childEnv: fakeClaudeEnv("hang_with_tree", { FAKE_CLAUDE_TREE_OUT: treeOut }),
      sessionTimeoutMs: trigger === "timeout" ? 4_000 : undefined,
    });
    const running = runSession(spec, controller.signal);
    if (trigger === "abort") {
      await vi.waitFor(
        () =>
          expect(collector.events).toContainEqual(
            expect.objectContaining({ type: "init" }),
          ),
        { timeout: 4_000 },
      );
      controller.abort();
    }

    const result = await running;

    expect(result.failureReason).toBe(trigger);
    tree = await readJson<TreeRecord>(treeOut);
    return tree;
  }

  it("leaves no descendant of a timed-out session running", async () => {
    const { attached } = await runTree("timeout");

    expect(attached).toHaveLength(2);
    expect(attached.filter(isAlive)).toEqual([]);
  }, 30_000);

  it("leaves no descendant of an aborted session running", async () => {
    const { attached } = await runTree("abort");

    expect(attached.filter(isAlive)).toEqual([]);
  }, 30_000);

  posixOnly(
    "also stops descendants whose parent already exited",
    async () => {
      const { orphaned } = await runTree("timeout");

      expect(orphaned).toHaveLength(1);
      expect(orphaned.filter(isAlive)).toEqual([]);
    },
    30_000,
  );
});
