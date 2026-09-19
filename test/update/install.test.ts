import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  detectInstallMethod,
  installCommand,
  runInstall,
} from "../../src/update/install.js";
import { createTempDir, pathEnv, removeTempDir, writeExecutable } from "../helpers.js";

describe("detectInstallMethod", () => {
  it("returns unknown for a dev/local path without node_modules", () => {
    expect(detectInstallMethod("/Users/me/projects/ai-agent")).toBe("unknown");
    expect(detectInstallMethod("/Users/me/projects/ai-agent/dist")).toBe("unknown");
  });

  it("detects npm global installs", () => {
    expect(detectInstallMethod("/usr/local/lib/node_modules/@kikimoradev/kikimora")).toBe(
      "npm",
    );
    expect(
      detectInstallMethod(
        "/Users/me/.nvm/versions/node/v22.16.0/lib/node_modules/@kikimoradev/kikimora",
      ),
    ).toBe("npm");
  });

  it("detects pnpm, yarn and bun by path segment", () => {
    expect(
      detectInstallMethod(
        "/Users/me/Library/pnpm/global/5/node_modules/@kikimoradev/kikimora",
      ),
    ).toBe("pnpm");
    expect(
      detectInstallMethod(
        "/Users/me/.config/yarn/global/node_modules/@kikimoradev/kikimora",
      ),
    ).toBe("yarn");
    expect(
      detectInstallMethod(
        "/Users/me/.bun/install/global/node_modules/@kikimoradev/kikimora",
      ),
    ).toBe("bun");
  });

  it("handles windows-style separators", () => {
    expect(
      detectInstallMethod(
        "C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@kikimoradev\\kikimora",
      ),
    ).toBe("npm");
  });
});

describe("installCommand", () => {
  it("maps each manager to its global add command", () => {
    expect(installCommand("npm", "pkg")).toEqual({
      command: "npm",
      args: ["install", "-g", "pkg@latest"],
    });
    expect(installCommand("pnpm", "pkg")).toEqual({
      command: "pnpm",
      args: ["add", "-g", "pkg@latest"],
    });
    expect(installCommand("yarn", "pkg")).toEqual({
      command: "yarn",
      args: ["global", "add", "pkg@latest"],
    });
    expect(installCommand("bun", "pkg")).toEqual({
      command: "bun",
      args: ["add", "-g", "pkg@latest"],
    });
  });
});

describe("runInstall", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await createTempDir();
  });

  afterEach(async () => {
    await removeTempDir(dir);
  });

  it("succeeds and captures output when the manager exits 0", async () => {
    await writeExecutable(
      dir,
      "npm",
      'console.log("ARGS:" + JSON.stringify(process.argv.slice(2)));\n',
    );

    const result = await runInstall("npm", "@kikimoradev/kikimora", {
      env: pathEnv(dir),
    });

    expect(result.ok).toBe(true);
    expect(result.output).toContain('["install","-g","@kikimoradev/kikimora@latest"]');
  });

  it("fails when the manager exits non-zero", async () => {
    await writeExecutable(dir, "pnpm", 'console.error("boom");\nprocess.exit(1);\n');

    const result = await runInstall("pnpm", "pkg", { env: pathEnv(dir) });

    expect(result.ok).toBe(false);
    expect(result.output).toContain("boom");
  });

  it("fails gracefully when the manager binary is missing", async () => {
    const result = await runInstall("bun", "pkg", {
      env: { PATH: join(dir, "empty") },
    });

    expect(result.ok).toBe(false);
    expect(result.output).toContain("Failed to start");
  });
});
