<h1 align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/kikimoradev/kikimora/main/assets/kikimora-logo-dark.svg">
    <img alt="Kikimora" src="https://raw.githubusercontent.com/kikimoradev/kikimora/main/assets/kikimora-logo.svg" width="96">
  </picture><br>
  Kikimora
</h1>

<p align="center">
  <strong>A CLI that runs Claude Code sessions in a monitor, executor and summarizer loop.</strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@kikimoradev/kikimora"><img alt="npm" src="https://img.shields.io/npm/v/%40kikimoradev%2Fkikimora?logo=npm&color=CB3837"></a>
  <a href="https://github.com/kikimoradev/kikimora/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/kikimoradev/kikimora/ci.yml?branch=main&logo=github&label=CI"></a>
  <a href="https://github.com/kikimoradev/kikimora/blob/main/LICENSE"><img alt="License" src="https://img.shields.io/badge/license-MIT-green"></a>
  <img alt="Node" src="https://img.shields.io/badge/node-%E2%89%A522.16-339933?logo=node.js&logoColor=white">
</p>

<p align="center">
  <img alt="Kikimora demo" src="https://raw.githubusercontent.com/kikimoradev/kikimora/main/assets/demo.gif" width="800">
</p>

Kikimora is a CLI that runs [Claude Code](https://claude.com/claude-code) sessions in three roles. The **monitor** reports tasks, the **executor** completes them, and the **summarizer** writes findings to long-term memory.

```
        every N minutes (only during working hours)
                          │
                          ▼
                  ┌───────────────┐   JSON report   ┌───────────────┐
                  │    MONITOR    │ ───────────────▶│   TaskStore   │
                  │    (haiku)    │     (tasks)     │  tasks.json   │
                  └───────────────┘                 └───────┬───────┘
                                                            │ wakes (Waker)
                                                            │
┌───────────────┐  session log  ┌───────────────┐  pending  │
│  SUMMARIZER   │ ◀──────────── │   EXECUTOR    │ ◀─────────┘
│   (sonnet)    │               │    (opus)     │
└───────┬───────┘               └───────┬───────┘
        │ findings                      │ memory_search / memory_get
        ▼                               ▼
┌───────────────────────────────────────────────┐
│            Memory (SQLite + FTS5)             │
│              MCP server (stdio)               │
└───────────────────────────────────────────────┘
```

The monitor and executor loops run in parallel and share only the task store:

- The monitor runs a session on an interval and returns tasks as JSON that matches an enforced schema.
- New tasks wake the executor, which takes them one at a time.
- Each executor session has full tool access and can search the summaries of earlier sessions.
- After an executor session, the summarizer reads its log and stores a summary in memory.

The models in the diagram are the defaults.

## Use cases

The monitor prompt defines what counts as a task. Examples:

- **CI repair**: watch the pipeline on `main`, investigate failed builds, open a fix PR.
- **Issue triage**: pick up well-scoped bug reports and turn them into pull requests.
- **Dependency updates**: detect pending patch updates, bump them, run the tests.
- **Backlog work**: work through `TODO`s, flaky tests and lint findings.

A monitor prompt for the first two:

```markdown
1. **CI on main**: run `gh run list --branch main --limit 5`. If the latest
   run failed, report a task to investigate and fix it (id: `ci-<run-id>`).
2. **Issues labeled `bug`**: for each issue describing a concrete,
   self-contained change, report a task with id `issue-<number>`.
```

Full examples and prompt-writing tips: [docs/prompts.md](https://github.com/kikimoradev/kikimora/blob/main/docs/prompts.md).

## Features

- **Task loop**: the monitor reports tasks and the executor completes them. `/task` adds a task by hand.
- **Long-term memory**: SQLite with FTS5, exposed to the executor over MCP (`memory_search`, `memory_get`).
- **Interactive TUI**: an Ink/React shell with live agent status, switchable views and slash commands.
- **Working hours**: a time window and days of the week (`08:00-18:00`, `mon-fri`) limit when the monitor runs.
- **Retries**: transient failures are retried up to `maxTaskAttempts`, other failures mark the task `failed`. Tasks left `in_progress` by a crash return to `pending` on the next start.
- **Usage limits**: when Claude Code reports its 5-hour or weekly limit, both agents wait with a countdown until the reset plus 60 s. The interrupted task returns to the queue and the attempt is not counted.
- **Prompts in files**: agent prompts are markdown files; the code contains no prompt text.

## Quick start

Requirements:

- Node.js `^22.16.0` or `>=24.0.0` (the `engines` field), an official build: long-term memory needs `node:sqlite` with FTS5.
- The [Claude Code CLI](https://claude.com/claude-code) (`claude`), installed and logged in.

```bash
npm install -g @kikimoradev/kikimora

cd your-project
kikimora          # first run asks for the two agent prompts, then opens the TUI
```

The first-run wizard asks for two prompts: what the monitor watches and how the executor works. Its multi-line editor accepts pasted markdown; Enter adds a line and Ctrl+D submits. All other settings start at their defaults and can be changed later with slash commands. In a terminal the agents start **paused** and run after `/start`.

From a clone: `pnpm install && pnpm start`.

## The TUI

The screen has three parts:

- a header with the live status of both agents: state, model, cost, task counters;
- the current view;
- a command input with history, tab completion and PgUp/PgDn scrolling.

| Command                       | Effect                                                                  |
| ----------------------------- | ----------------------------------------------------------------------- |
| `/dashboard`                  | combined view: both agents and the task table                           |
| `/monitor`, `/executor`       | one agent full-screen with its recent outcomes                          |
| `/tasks`                      | the full task list                                                      |
| `/memory [query]`             | browse long-term memory, optionally filtered by FTS search              |
| `/start [monitor\|executor]`  | start paused agents                                                     |
| `/pause [monitor\|executor]`  | pause agents after the current session finishes                         |
| `/drain`                      | let the current sessions finish, then shut down                         |
| `/task <description>`         | add a task by hand; an idle executor takes it at once                   |
| `/retry <task-id>`            | requeue a failed task                                                   |
| `/cancel <task-id>`           | cancel a pending task                                                   |
| `/model <agent> <model>`      | set the model (`haiku`, `sonnet`, `opus`, `fable`)                      |
| `/effort <agent> <level>`     | set the reasoning effort (`low`, `medium`, `high`, `xhigh`, `max`)      |
| `/interval <minutes>`         | set how often the monitor looks for new tasks                           |
| `/hours <HH:MM-HH:MM\|off>`   | set the monitor working hours; `off` means 24/7                         |
| `/days <days\|off>`           | set the monitor working days (`mon-fri`); `off` means every day         |
| `/prompt <monitor\|executor>` | view and edit an agent prompt; Ctrl+D saves, Esc closes                 |
| `/context`                    | view and edit the workspace context file; Ctrl+D saves, Esc closes      |
| `/config`                     | show the current configuration                                          |
| `/help`                       | list all commands                                                       |
| `/exit`                       | stop at once, like Ctrl+C: running sessions are killed, logs are closed |

Configuration commands write to `.kikimora/settings.json` and take effect from the next agent session, without a restart.

## Headless mode and servers

Without a TTY (systemd, Docker, CI, a pipe), kikimora skips the dashboard and starts the agents immediately. It prints line logs to stdout: human-readable by default, NDJSON with `--log-format json`. A second shell controls the running worker over a local control socket.

| Command                                                         | Effect                                                                                                      |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `kikimora`                                                      | start the worker (TUI in a terminal, headless without one)                                                  |
| `kikimora --headless [--log-format json]`                       | force headless mode in a terminal                                                                           |
| `kikimora --paused`                                             | start with both agents paused; `kikimora resume` starts them                                                |
| `kikimora init --monitor-prompt <f> --executor-prompt <f>`      | non-interactive setup (cloud-init, Ansible); `--settings <f>` and `--context <f>` write those files as well |
| `kikimora status [--json]`                                      | live status of the running worker; exits `1` without one, so it works as a health check                     |
| `kikimora version [--json]`                                     | kikimora, Claude Code and Node versions, auth kind and pid of the running worker                            |
| `kikimora pause [monitor\|executor]`                            | pause after the current session, same as `/pause`                                                           |
| `kikimora resume [monitor\|executor]`                           | resume paused agents                                                                                        |
| `kikimora drain [--timeout <ms>]`                               | let the current sessions finish, then exit; after the timeout, kill what still runs                         |
| `kikimora tasks\|settings\|prompt\|context\|memory\|sessions …` | manage the running worker's queue, settings, prompts, context and memory, and list its sessions             |
| `kikimora update [--check]`                                     | update to the newest published version; a running worker also checks in the background                      |

A second `kikimora` in the same project exits with an error while one is running.

- The control socket, its subcommands and the wire protocol: [docs/control.md](https://github.com/kikimoradev/kikimora/blob/main/docs/control.md).
- The NDJSON event schema, a systemd runbook, authentication without a browser, the reference `Dockerfile` and `docker-compose.yml`, and the prebuilt images `ghcr.io/kikimoradev/kikimora` (plus a `-browser` variant with Chromium for Playwright MCP): [docs/deployment.md](https://github.com/kikimoradev/kikimora/blob/main/docs/deployment.md).

## Configuration

Per-project state lives in `.kikimora/` inside the directory kikimora runs from, like Claude Code's `.claude/`. It holds `settings.json`, the project prompts and runtime data (tasks, memory, logs). The runtime data directories are listed in `.kikimora/.gitignore`, which setup writes.

`settings.json` is validated strictly and every section is optional. Change it with the slash commands above or by hand:

```json
{
  "monitor": {
    "intervalMinutes": 15,
    "activeHours": "08:00-18:00",
    "activeDays": "mon-fri"
  },
  "executor": { "model": "opus", "effort": "high" }
}
```

All settings, the directory layout and what to commit: [docs/configuration.md](https://github.com/kikimoradev/kikimora/blob/main/docs/configuration.md).

## Security and costs

> **Warning: agents work directly in your project.** Sessions run with `--permission-mode bypassPermissions` and full tool access **in the directory `kikimora` runs from**. Kikimora provides no sandbox. Run it only in projects where that is acceptable: reviewed prompts, no secrets within reach, version control to undo changes. Tasks reported by the monitor are input to an autonomous agent; the prompts set the boundaries.

Each monitor patrol and each task is a Claude Code session, and each session is billed. The bill scales with the interval and the models. Start with a long `intervalMinutes` and `sonnet` on the executor, then scale up once the prompts behave.

On the Anthropic API, `fable` costs twice the per-token rate of `opus` ($10 and $50 against $5 and $25 per million input and output tokens, Anthropic pricing as of June 2026). Use it on the executor for work that needs it. Working hours stop the monitor from patrolling outside the configured window.

## Development

```bash
pnpm dev              # start with watch (tsx)
pnpm check            # typecheck + lint + format:check + test, before every commit
pnpm build            # tsup -> dist/
```

Tests run Claude sessions against a fake `claude` binary (`test/fixtures/claude`) and make no API calls. Coverage thresholds are enforced. See [CONTRIBUTING.md](https://github.com/kikimoradev/kikimora/blob/main/CONTRIBUTING.md).

## License

[MIT](https://github.com/kikimoradev/kikimora/blob/main/LICENSE) © Kikimora
