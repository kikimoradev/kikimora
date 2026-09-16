#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
import { runMain } from "citty";
import { contextCommand } from "./context-command.js";
import {
  drainCommand,
  pauseCommand,
  resumeCommand,
  statusCommand,
  versionCommand,
} from "./control-commands.js";
import { initCommand } from "./init-command.js";
import { mainCommand } from "./main.js";
import { mcpCommand } from "./mcp-command.js";
import { memoryCommand } from "./memory-command.js";
import { promptCommand } from "./prompt-command.js";
import { sessionsCommand } from "./sessions-command.js";
import { settingsCommand } from "./settings-command.js";
import { tasksCommand } from "./tasks-command.js";
import { updateCommand } from "./update-command.js";

const rawArgs = process.argv.slice(2);
const [first, ...rest] = rawArgs;

switch (first) {
  case "mcp":
    void runMain(mcpCommand, { rawArgs: rest });
    break;
  case "init":
    void runMain(initCommand, { rawArgs: rest });
    break;
  case "status":
    void runMain(statusCommand, { rawArgs: rest });
    break;
  case "version":
    void runMain(versionCommand, { rawArgs: rest });
    break;
  case "pause":
    void runMain(pauseCommand, { rawArgs: rest });
    break;
  case "resume":
    void runMain(resumeCommand, { rawArgs: rest });
    break;
  case "drain":
    void runMain(drainCommand, { rawArgs: rest });
    break;
  case "tasks":
    void runMain(tasksCommand, { rawArgs: rest });
    break;
  case "settings":
    void runMain(settingsCommand, { rawArgs: rest });
    break;
  case "prompt":
    void runMain(promptCommand, { rawArgs: rest });
    break;
  case "context":
    void runMain(contextCommand, { rawArgs: rest });
    break;
  case "memory":
    void runMain(memoryCommand, { rawArgs: rest });
    break;
  case "sessions":
    void runMain(sessionsCommand, { rawArgs: rest });
    break;
  case "update":
    void runMain(updateCommand, { rawArgs: rest });
    break;
  default:
    void runMain(mainCommand, { rawArgs });
}
