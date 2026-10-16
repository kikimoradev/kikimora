import { execFile, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const POLL_MS = 50;
const SETTLE_AFTER_KILL_MS = 1000;

export function leadsOwnProcessGroup(
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform !== "win32";
}

export async function terminateProcessTree(
  child: ChildProcess,
  graceMs: number,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  const { pid } = child;
  if (pid === undefined) return;
  if (!leadsOwnProcessGroup(platform)) {
    if (!(await taskkillTree(pid))) child.kill("SIGKILL");
    return;
  }
  signalGroup(child, pid, "SIGTERM");
  if (await groupGone(pid, graceMs)) return;
  signalGroup(child, pid, "SIGKILL");
  await groupGone(pid, SETTLE_AFTER_KILL_MS);
}

function signalGroup(child: ChildProcess, pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") child.kill(signal);
  }
}

function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function groupGone(pid: number, withinMs: number): Promise<boolean> {
  const deadline = Date.now() + withinMs;
  while (groupAlive(pid)) {
    if (Date.now() >= deadline) return false;
    await delay(POLL_MS);
  }
  return true;
}

function taskkillPath(): string {
  return join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe");
}

function taskkillTree(pid: number): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(
      taskkillPath(),
      ["/PID", String(pid), "/T", "/F"],
      { windowsHide: true },
      (error) => {
        resolve(error === null);
      },
    );
  });
}
