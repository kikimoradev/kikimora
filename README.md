<h1 align="center">
  <img alt="Brownie" src="https://raw.githubusercontent.com/brownie-labs/brownie/main/assets/brownie-logo.png" width="140"><br>
  Brownie
</h1>

<p align="center">
  <strong>Your household sprite for the work you keep putting off. It works while you're not looking.</strong><br>
  <em>Not the cake. The spirit.</em>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@brownie-labs/brownie"><img alt="npm" src="https://img.shields.io/npm/v/%40brownie-labs%2Fbrownie?logo=npm&color=CB3837"></a>
  <a href="https://github.com/brownie-labs/brownie/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/brownie-labs/brownie/ci.yml?branch=main&logo=github&label=CI"></a>
  <a href="https://github.com/brownie-labs/brownie/blob/main/LICENSE"><img alt="License" src="https://img.shields.io/badge/license-MIT-green"></a>
  <img alt="Node" src="https://img.shields.io/badge/node-%E2%89%A522.16-339933?logo=node.js&logoColor=white">
</p>

<p align="center">
  <img alt="Brownie demo" src="https://raw.githubusercontent.com/brownie-labs/brownie/main/assets/demo.gif" width="800">
</p>

Brownie is a CLI that cyclically runs [Claude Code](https://claude.com/claude-code) sessions in a two-agent setup: the **monitor** watches for tasks, the **executor** completes them, and the **summarizer** writes findings to long-term memory. You sleep — the sprite tidies up.

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

Two loops run in parallel and talk only through the shared task store: the monitor patrols your sources on an interval and reports tasks as structured JSON; the executor wakes the moment tasks land and completes them one by one, with full tool access and searchable memory of past sessions.

## What can it do for you?

Whatever you describe in one markdown file. Some sprites people keep:

- **CI medic** — watch the pipeline on `main`, investigate red builds, open a fix PR.
- **Issue triager** — pick up well-scoped bug reports and turn them into pull requests.
- **Dependency groundskeeper** — notice pending patch updates, bump, run the tests.
- **Backlog sweeper** — work through `TODO`s, flaky tests, and lint debt while you build features.

The monitor's patrol is just a prompt:

```markdown
1. **CI on main** — run `gh run list --branch main --limit 5`. If the latest
   run failed, report a task to investigate and fix it (id: `ci-<run-id>`).
2. **Issues labeled `bug`** — for each issue describing a concrete,
   self-contained change, report a task with id `issue-<number>`.
```

Full examples and prompt-writing tips: [docs/prompts.md](https://github.com/brownie-labs/brownie/blob/main/docs/prompts.md).

## Highlights

- 🔁 **Autonomous loop** — the monitor finds work, the executor does it; zero manual queuing (though `/task` adds work by hand).
- 🧠 **Long-term memory** — SQLite + FTS5 exposed to the executor over MCP; the sprite learns from its own sessions.
- 📺 **Interactive TUI** — a Claude-Code-style shell (Ink/React): live agent status, switchable views, slash commands.
- ⏰ **Working hours** — a time window and days of the week (`08:00-18:00`, `mon-fri`); outside them the monitor rests.
- 🔂 **Smart retries** — transient failures are retried, permanent ones fail fast; stalled tasks recover on restart.
- ⛔ **Usage-limit aware** — when Claude Code hits its 5-hour or weekly limit, both agents park with a countdown and resume automatically after the reset; interrupted tasks go back to the queue without burning a retry.
- 📝 **Prompts in files** — the entire personality lives in markdown, no prompts baked into the code.

## Quick start

You need Node.js ≥ 22.16 (an official build — brownie's long-term memory needs SQLite with FTS5) and the [Claude Code CLI](https://claude.com/claude-code) (`claude`) installed and logged in.

```bash
npm install -g @brownie-labs/brownie

cd your-project
brownie          # first run asks for the two agent prompts, then opens the TUI
```

The first-run wizard asks only two questions — what the monitor should watch and how the executor should work — in a multi-line editor built for pasting markdown (Enter adds a line, Ctrl+D submits). Everything else starts with sensible defaults you can change later with slash commands. Agents boot **paused** — nothing runs until you type `/start`.

Working from a clone instead: `pnpm install && pnpm start`.

## The TUI

A shell in the style of Claude Code: a header with the live status of both agents (state, model, cost, task counters), a view in the middle, and a command input at the bottom (history, tab completion, pgup/pgdn scrolling):

| Command                       | Effect                                                     |
| ----------------------------- | ---------------------------------------------------------- |
| `/dashboard`                  | combined view: both agents + the task table                |
| `/monitor`, `/executor`       | one agent full-screen with its recent outcomes             |
| `/tasks`                      | the full task list                                         |
| `/memory [query]`             | browse long-term memory, optionally filtered by FTS search |
| `/start [monitor\|executor]`  | start paused agents — agents boot paused                   |
| `/pause [monitor\|executor]`  | graceful pause — the current session finishes first        |
| `/drain`                      | let the current sessions finish, then shut down            |
| `/task <description>`         | add a task by hand (the executor picks it up immediately)  |
| `/retry <task-id>`            | requeue a failed task                                      |
| `/cancel <task-id>`           | cancel a pending task                                      |
| `/model <agent> <model>`      | set the model (`haiku`, `sonnet`, `opus`, `fable`)         |
| `/effort <agent> <level>`     | set the reasoning effort (`low`…`max`)                     |
| `/interval <minutes>`         | set how often the monitor looks for new tasks              |
| `/hours <HH:MM-HH:MM\|off>`   | set the monitor working hours, `off` = 24/7                |
| `/days <days\|off>`           | set the monitor working days (`mon-fri`), `off` = daily    |
| `/prompt <monitor\|executor>` | view and edit an agent prompt — Ctrl+D saves, Esc closes   |
| `/config`                     | show the current configuration                             |
| `/help`                       | list all commands                                          |
| `/exit`                       | graceful shutdown (same as ctrl+c)                         |

Configuration commands persist to `.brownie/settings.json` and apply live — the next agent session already uses the new value, no restart needed.

## Headless & servers

Without a TTY (systemd, Docker, CI, piping) brownie skips the dashboard, starts the agents immediately, and prints structured line logs to stdout — human-readable by default, NDJSON with `--log-format json` for log aggregators. A running worker is controlled from a second shell over a local control socket:

| Command                                                   | Effect                                                                                                              |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `brownie`                                                 | start the worker (TUI in a terminal, headless without one)                                                          |
| `brownie --headless [--log-format json]`                  | force headless mode even in a terminal                                                                              |
| `brownie --paused`                                        | boot with both agents paused; `brownie resume` starts them                                                          |
| `brownie init --monitor-prompt <f> --executor-prompt <f>` | non-interactive setup for servers (cloud-init, Ansible); `--settings <f>` and `--context <f>` write those files too |
| `brownie status [--json]`                                 | live status of the running worker (doubles as a health check)                                                       |
| `brownie version [--json]`                                | brownie, Claude Code and Node versions, auth kind, pid of the worker                                                |
| `brownie pause [monitor\|executor]`                       | graceful pause, same as `/pause` in the TUI                                                                         |
| `brownie resume [monitor\|executor]`                      | resume paused agents                                                                                                |
| `brownie drain [--timeout <ms>]`                          | let the current sessions finish, then exit (with a deadline, kill what still runs)                                  |
| `brownie tasks\|settings\|prompt\|memory …`               | edit the queue, settings, prompts and memory of the running worker                                                  |
| `brownie update [--check]`                                | update to the newest published version (auto-updates in the background too)                                         |

A second `brownie` in the same project refuses to start while one is already running. The control socket, its subcommands and wire protocol: [docs/control.md](https://github.com/brownie-labs/brownie/blob/main/docs/control.md). The full server story — the NDJSON event schema, a DigitalOcean/systemd runbook, authentication without a browser, the reference `Dockerfile` + `docker-compose.yml`, and the prebuilt images on GHCR (`ghcr.io/brownie-labs/brownie`, plus a `-browser` variant with Chromium for Playwright MCP): [docs/deployment.md](https://github.com/brownie-labs/brownie/blob/main/docs/deployment.md).

## Configuration

Like Claude Code's `.claude/`, all per-project state lives in `.brownie/` inside the directory you run brownie from: `settings.json`, the two project prompts, and runtime data (tasks, memory, logs — gitignored automatically). The settings file is a strictly validated JSON where every section is optional — change it with the slash commands above or by hand:

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

All settings, the full directory layout, and what to commit: [docs/configuration.md](https://github.com/brownie-labs/brownie/blob/main/docs/configuration.md).

## Security & costs

> **⚠️ The sprite works directly in your project.** Agent sessions run with `--permission-mode bypassPermissions` and full tool access **in the directory you run `brownie` from** — there is no isolated sandbox. Run it in projects you trust it with: well-considered prompts, no secrets within reach, version control as your safety net. Treat tasks reported by the monitor like any input to an autonomous agent — the prompts define the boundaries.

Brownie spends real tokens: every patrol is a session, every task is a session. Interval × models = your bill, so start conservative — a longer `intervalMinutes`, `sonnet` on the executor — and scale up once you trust the prompts. `fable` is the most capable and the most expensive tier (roughly twice the price of `opus`), so reserve it for the executor on work that earns it. Working hours keep the sprite from patrolling an empty repo at 3 a.m.

## Development

```bash
pnpm dev              # start with watch (tsx)
pnpm check            # typecheck + lint + format:check + test — before every commit
pnpm build            # tsup -> dist/
```

Claude sessions are tested against a fake `claude` binary (`test/fixtures/claude`) — no real API calls. Coverage thresholds are enforced. See [CONTRIBUTING.md](https://github.com/brownie-labs/brownie/blob/main/CONTRIBUTING.md).

## License

[MIT](https://github.com/brownie-labs/brownie/blob/main/LICENSE) © Brownie Labs

## Why "Brownie"? 🧌

In British folklore a **brownie** is a household spirit that, at night — while the household sleeps — quietly finishes their work for them. It has two iron rules: it works unbidden, and it vanishes when watched. Ours is a touch more modern: instead of a bowl of milk it takes tokens, and instead of sweeping the room it closes out your tasks. Watching is allowed (that's what the dashboard is for).
