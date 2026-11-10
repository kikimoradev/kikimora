import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { createTempDir, removeTempDir } from "./helpers.js";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const vitestEntry = join(projectRoot, "node_modules", "vitest", "vitest.mjs");

const WORKER_SESSION_ENV = {
  KIKIMORA_CONTROL_SOCKET: join(projectRoot, "no-such-dir", "worker-control.sock"),
  KIKIMORA_SESSION_LAUNCHER: "kikimora-pool-launcher --pool agents",
  KIKIMORA_ADMISSION: "external",
  KIKIMORA_ADMISSION_POOL: "executor",
  KIKIMORA_ADMISSION_TICKET: "ticket-from-the-worker",
  KIKIMORA_SESSION_ROLE: "executor",
  KIKIMORA_LOG_FORMAT: "json",
  KIKIMORA_START_PAUSED: "1",
  KIKIMORA_DISABLE_AUTOUPDATER: "1",
};

const ENV_SENSITIVE_FILES = [
  "test/paths.test.ts",
  "test/runner.test.ts",
  "test/main.test.ts",
  "test/start.test.ts",
  "test/control-commands.test.ts",
];

const STUB_BINARY_FILES = ["test/preflight.test.ts", "test/update/install.test.ts"];

const SLOW_MACHINE_PRELOAD = `const lock = new Int32Array(new SharedArrayBuffer(4));
const startDelayMs = Number(process.env.SLOW_MACHINE_START_DELAY_MS ?? "0");
if (startDelayMs > 0) Atomics.wait(lock, 0, 0, startDelayMs);
const share = Number(process.env.SLOW_MACHINE_CPU_SHARE ?? "1");
if (share < 1) {
  const sliceMs = 20;
  setInterval(() => Atomics.wait(lock, 0, 0, sliceMs * (1 - share)), sliceMs * share).unref();
}
`;

const CLI_SMOKE_TESTS_SLOW_TO_START = [
  "an executor session marks its task as handed off to a human through the memory server",
  "carries the source of a task from the monitor report to the queue, the events, the status and memory",
  "indexes the executor session and writes both transcript files next to each other",
  "answers kikimora status --json and pause over the control socket",
  "kikimora drain --json lets the executor finish its session and summary, then the worker exits 0",
  "kikimora drain waits for a monitor cycle in flight while the executor idles, then the worker exits 0",
];

interface Run {
  code: number | null;
  output: string;
}

function cleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("KIKIMORA_") || key.startsWith("VITEST") || key === "TEST") {
      continue;
    }
    env[key] = value;
  }
  return env;
}

function runVitest(
  files: string[],
  env: NodeJS.ProcessEnv,
  options: string[] = [],
): Promise<Run> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(
      process.execPath,
      [vitestEntry, "run", "--reporter=dot", "--retry=0", ...options, ...files],
      { cwd: projectRoot, env, stdio: ["ignore", "pipe", "pipe"] },
    );
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
    child.on("error", rejectPromise);
    child.on("close", (code) => {
      resolvePromise({ code, output });
    });
  });
}

function namePattern(names: string[]): string {
  return names.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
}

async function runVitestOnSlowMachine(
  files: string[],
  slowdown: { startDelayMs?: number; cpuShare?: number },
  options: string[],
): Promise<Run> {
  const dir = await createTempDir();
  try {
    const preload = join(dir, "slow-machine.mjs");
    await writeFile(preload, SLOW_MACHINE_PRELOAD, "utf8");
    const env = cleanEnv();
    return await runVitest(
      files,
      {
        ...env,
        NODE_OPTIONS: [env.NODE_OPTIONS, `--import=${pathToFileURL(preload).href}`]
          .filter((option) => option !== undefined && option !== "")
          .join(" "),
        SLOW_MACHINE_START_DELAY_MS: String(slowdown.startDelayMs ?? 0),
        SLOW_MACHINE_CPU_SHARE: String(slowdown.cpuShare ?? 1),
      },
      options,
    );
  } finally {
    await removeTempDir(dir);
  }
}

function failures(run: Run): string {
  return run.output
    .split("\n")
    .filter((line) => /FAIL|AssertionError|Error:|Tests\s|^ {2}- /.test(line))
    .slice(0, 40)
    .join("\n");
}

describe("the test suite", () => {
  it("gives the same results when the session of a worker runs it with the KIKIMORA_* variables of that worker", async () => {
    const run = await runVitest(ENV_SENSITIVE_FILES, {
      ...cleanEnv(),
      ...WORKER_SESSION_ENV,
    });

    expect(run.code, failures(run)).toBe(0);
  }, 180_000);

  it("runs the stub binaries of the tests when the temporary directory of the machine forbids executing files", async () => {
    const run = await runVitest(STUB_BINARY_FILES, cleanEnv());

    expect(run.code, failures(run)).toBe(0);
  }, 180_000);

  it("passes the CLI smoke tests when every process of the machine starts seconds late, as under heavy load", async () => {
    const run = await runVitestOnSlowMachine(
      ["test/cli.test.ts"],
      { startDelayMs: 2_500 },
      [`--testNamePattern=${namePattern(CLI_SMOKE_TESTS_SLOW_TO_START)}`],
    );

    expect(run.code, failures(run)).toBe(0);
  }, 900_000);

  it("passes the dashboard tests when the machine gives the test a tenth of a CPU, as under heavy load", async () => {
    const run = await runVitestOnSlowMachine(
      ["test/ui/app.test.tsx"],
      { cpuShare: 0.1 },
      [
        `--testNamePattern=${namePattern(["warns when a session produces no output for a long time"])}`,
      ],
    );

    expect(run.code, failures(run)).toBe(0);
  }, 900_000);
});
