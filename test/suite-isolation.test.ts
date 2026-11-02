import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

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

function runVitest(files: string[], env: NodeJS.ProcessEnv): Promise<Run> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(
      process.execPath,
      [vitestEntry, "run", "--reporter=dot", "--retry=0", ...files],
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
});
