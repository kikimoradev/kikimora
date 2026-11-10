import { spawn } from "node:child_process";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTempDir, removeTempDir } from "./helpers.js";

const dockerfilePath = fileURLToPath(new URL("../Dockerfile", import.meta.url));

interface HealthCheck {
  timeoutMs: number;
  command: string;
}

function durationMs(value: string): number {
  const match = /^(\d+)(ms|s|m)$/.exec(value);
  if (match === null) throw new Error(`Unsupported duration "${value}".`);
  const amount = Number(match[1]);
  if (match[2] === "ms") return amount;
  return match[2] === "s" ? amount * 1000 : amount * 60_000;
}

async function readHealthCheck(): Promise<HealthCheck> {
  const dockerfile = (await readFile(dockerfilePath, "utf8")).replace(/\\\r?\n\s*/g, " ");
  const instruction = /^HEALTHCHECK\s+(.*)$/m.exec(dockerfile)?.[1];
  if (instruction === undefined) throw new Error("The Dockerfile has no HEALTHCHECK.");
  const [options = "", command] = instruction.split(/\s+CMD\s+/);
  if (command === undefined) throw new Error("The HEALTHCHECK has no CMD.");
  const timeout = /--timeout=(\S+)/.exec(options)?.[1] ?? "30s";
  return { timeoutMs: durationMs(timeout), command: command.trim() };
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntilGone(pid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !isAlive(pid);
}

async function readPid(file: string, ms: number): Promise<number> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const content = await readFile(file, "utf8").catch(() => "");
    const pid = Number.parseInt(content, 10);
    if (Number.isInteger(pid) && pid > 0) return pid;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("The stub kikimora never started.");
}

interface ProbeRun {
  endedOnItsOwn: boolean;
  code: number | null;
  elapsedMs: number;
}

function runProbeLikeDocker(
  command: string,
  timeoutMs: number,
  env: NodeJS.ProcessEnv,
): Promise<ProbeRun> {
  const started = Date.now();
  const probe = spawn("/bin/sh", ["-c", command], { env, stdio: "ignore" });
  return new Promise((resolve) => {
    let endedOnItsOwn = true;
    const timer = setTimeout(() => {
      endedOnItsOwn = false;
      probe.kill("SIGKILL");
    }, timeoutMs);
    probe.once("close", (code) => {
      clearTimeout(timer);
      resolve({ endedOnItsOwn, code, elapsedMs: Date.now() - started });
    });
  });
}

describe.runIf(process.platform === "linux")("the health check of the image", () => {
  let dir: string;
  let hungPid: number | undefined;

  beforeEach(async () => {
    dir = await createTempDir();
    hungPid = undefined;
  });

  afterEach(async () => {
    if (hungPid !== undefined && isAlive(hungPid)) process.kill(hungPid, "SIGKILL");
    await removeTempDir(dir);
  });

  it("ends within its timeout and leaves no kikimora status process behind when status hangs", async () => {
    const { timeoutMs, command } = await readHealthCheck();
    const pidFile = join(dir, "status.pid");
    const stub = join(dir, "kikimora");
    await writeFile(stub, `#!/bin/sh\necho $$ > "${pidFile}"\nexec sleep 600\n`, "utf8");
    await chmod(stub, 0o755);
    const env = { ...process.env, PATH: `${dir}${delimiter}${process.env.PATH ?? ""}` };

    const run = runProbeLikeDocker(command, timeoutMs, env);
    hungPid = await readPid(pidFile, 5_000);
    const result = await run;
    const statusGone = await waitUntilGone(hungPid, 2_000);

    expect(
      statusGone,
      `"${command}" left its hung kikimora status process (pid ${String(hungPid)}) running after Docker killed the probe at the ${String(timeoutMs)} ms timeout, so a new one piles up at every interval`,
    ).toBe(true);
    expect(
      result.endedOnItsOwn,
      `"${command}" was still running when Docker's ${String(timeoutMs)} ms timeout hit`,
    ).toBe(true);
    expect(result.code).not.toBe(0);
  }, 30_000);
});
