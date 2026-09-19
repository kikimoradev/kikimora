import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const demoDir = resolve(dirname(fileURLToPath(import.meta.url)), "acme-shop");
const kikimoraDir = join(demoDir, ".kikimora");

rmSync(join(kikimoraDir, "data"), { recursive: true, force: true });
rmSync(join(kikimoraDir, "logs"), { recursive: true, force: true });
rmSync(join(kikimoraDir, "prompts"), { recursive: true, force: true });
mkdirSync(kikimoraDir, { recursive: true });

const settings = {
  monitor: { model: "sonnet", intervalMinutes: 5 },
  executor: { model: "opus", effort: "high" },
  summarizer: { model: "haiku" },
};

writeFileSync(
  join(kikimoraDir, "settings.json"),
  `${JSON.stringify(settings, null, 2)}\n`,
);
writeFileSync(join(kikimoraDir, ".gitignore"), "data/\nlogs/\n");

console.log(`Demo project ready: ${demoDir}`);
