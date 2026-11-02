import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const projectRoot = fileURLToPath(new URL(".", import.meta.url));

function canExecuteIn(dir: string): boolean {
  let probeDir: string | undefined;
  try {
    probeDir = mkdtempSync(join(dir, "kikimora-exec-probe-"));
    const probe = join(probeDir, "probe");
    writeFileSync(probe, "#!/bin/sh\nexit 0\n", "utf8");
    chmodSync(probe, 0o755);
    const run = spawnSync(probe, { stdio: "ignore" });
    return run.error === undefined && run.status === 0;
  } catch {
    return false;
  } finally {
    if (probeDir !== undefined) rmSync(probeDir, { recursive: true, force: true });
  }
}

function testTempDirEnv(): Record<string, string> {
  if (process.platform === "win32" || canExecuteIn(tmpdir())) return {};
  const dir = join(projectRoot, "node_modules", ".tmp");
  mkdirSync(dir, { recursive: true });
  return { TMPDIR: dir };
}

export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    testTimeout: 15_000,
    retry: process.env.GITHUB_ACTIONS === "true" ? 2 : 0,
    env: {
      CI: "false",
      CONTINUOUS_INTEGRATION: "false",
      ...testTempDirEnv(),
    },
    setupFiles: ["test/setup-env.ts"],
    include: ["test/**/*.test.{ts,tsx}"],
    coverage: {
      provider: "v8",
      include: ["src/**"],
      exclude: ["src/index.ts", "src/logger.ts", "src/types.ts", "src/ui/mount.tsx"],
      reporter: ["text", "html"],
      thresholds: {
        statements: 92,
        branches: 75,
        functions: 90,
        lines: 94,
      },
    },
  },
});
