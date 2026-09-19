# Configuration

Everything lives in `.kikimora/settings.json` — a nested JSON that's strictly validated, so a typo'd key fails with a named path instead of being silently ignored. The first `kikimora` run asks only for the two agent prompts and writes an empty settings file — every setting starts with its default. Change them at runtime with the slash commands below or edit the file by hand (picked up on the next start).

Every section is optional — `{}` is a valid file. A typical setup:

```json
{
  "monitor": {
    "model": "haiku",
    "intervalMinutes": 15,
    "activeHours": "08:00-18:00",
    "activeDays": "mon-fri"
  },
  "executor": {
    "model": "opus",
    "effort": "high",
    "sessionTimeoutMs": 1800000
  }
}
```

## All settings

| Key                           | Default          | Description                                             |
| ----------------------------- | ---------------- | ------------------------------------------------------- |
| `monitor.model`               | `haiku`          | monitor model: `haiku`, `sonnet`, `opus`, `fable`       |
| `monitor.effort`              | `medium`         | monitor effort: `low`, `medium`, `high`, `xhigh`, `max` |
| `monitor.intervalMinutes`     | `15`             | patrol interval (fractions allowed)                     |
| `monitor.activeHours`         | _(24/7)_         | working window, e.g. `08:00-18:00`                      |
| `monitor.activeDays`          | _(daily)_        | working days, e.g. `mon-fri` or `mon,wed,sat-sun`       |
| `monitor.sessionTimeoutMs`    | _(none)_         | monitor session timeout                                 |
| `executor.model`              | `opus`           | executor model: `haiku`, `sonnet`, `opus`, `fable`      |
| `executor.effort`             | `high`           | executor effort                                         |
| `executor.sessionTimeoutMs`   | _(none)_         | executor session timeout                                |
| `executor.maxTaskAttempts`    | `3`              | max attempts per task (transient failures are retried)  |
| `executor.retryDelayMs`       | `30000`          | delay between attempts                                  |
| `summarizer.model`            | `sonnet`         | summarizer model: `haiku`, `sonnet`, `opus`, `fable`    |
| `summarizer.effort`           | `medium`         | summarizer effort                                       |
| `summarizer.sessionTimeoutMs` | `300000` (5 min) | summarizer session timeout                              |
| `streamPartial`               | `true`           | stream partial responses to the dashboard               |
| `mcpServers`                  | _(none)_         | MCP servers available to the agents, keyed by name      |
| `monitor.mcpServers`          | _(none)_         | names from `mcpServers` the monitor gets                |
| `executor.mcpServers`         | _(none)_         | names from `mcpServers` the executor gets               |
| `browser`                     | `false`          | give both agents the bundled Playwright browser         |
| `shutdownGraceMs`             | `0`              | how long `SIGTERM` drains before the worker stops       |

`shutdownGraceMs` and what a drain waits for are explained in [Stopping the worker](deployment.md#stopping-the-worker).

## Changing settings at runtime

The dashboard exposes the everyday settings as slash commands — each one validates the value, persists it to `.kikimora/settings.json`, and applies it live, so the **next agent session** already uses it (a running session finishes on the old values, no restart needed):

| Command                     | Setting                                                  |
| --------------------------- | -------------------------------------------------------- |
| `/model <agent> <model>`    | `monitor.model`, `executor.model`, `summarizer.model`    |
| `/effort <agent> <level>`   | `monitor.effort`, `executor.effort`, `summarizer.effort` |
| `/interval <minutes>`       | `monitor.intervalMinutes`                                |
| `/hours <HH:MM-HH:MM\|off>` | `monitor.activeHours` (`off` clears it)                  |
| `/days <days\|off>`         | `monitor.activeDays` (`off` clears it)                   |
| `/config`                   | shows all current values                                 |

The remaining keys (`streamPartial`, `sessionTimeoutMs`, `maxTaskAttempts`, `retryDelayMs`, `shutdownGraceMs`) are edited by hand and picked up on the next start — or patched live from a shell with `kikimora settings patch` ([docs/control.md](control.md)). The agent prompts are also editable in place — `/prompt <monitor|executor>` opens them in the dashboard editor ([docs/prompts.md](prompts.md)).

## MCP servers

Every session runs with `--strict-mcp-config` against a file kikimora writes itself, so an agent sees exactly the servers listed here — never what a `.mcp.json` in the repository, `~/.claude.json` or `.claude/settings.json` happens to configure. Declare a server once under `mcpServers`, then hand it to an agent by name:

```json
{
  "mcpServers": {
    "sentry": {
      "type": "http",
      "url": "https://mcp.sentry.dev/mcp",
      "headers": { "Authorization": "Bearer ${SENTRY_TOKEN}" }
    },
    "linter": { "command": "run-linter", "args": ["--stdio"] }
  },
  "executor": { "mcpServers": ["sentry", "linter"] },
  "monitor": { "mcpServers": ["sentry"] },
  "browser": true
}
```

- An entry is a Claude Code MCP server verbatim: `command`/`args`/`env` for stdio, `type` (`http` or `sse`)/`url`/`headers` for a remote one. Claude Code expands `${VAR}` and `${VAR:-default}` in all of them, so secrets stay in the environment instead of in `settings.json`.
- Names are lowercase (`a-z0-9`, `_` and `-` inside); `memory` and `playwright` are reserved. A name in an agent list that is not in `mcpServers` fails validation at that index (`executor.mcpServers.0`).
- The executor always gets the `memory` server on top of its list; the monitor never does, and the summarizer gets no servers at all.
- `browser: true` adds the `playwright` server (headless Chromium, an isolated profile, screenshots into `.kikimora/data/playwright`) to the monitor and the executor. It needs `playwright-mcp` on `PATH` — the `-browser` image ([docs/deployment.md](deployment.md#prebuilt-images)) — and preflight refuses to start without it.
- The composed file lives in `.kikimora/data/mcp/<agent>.json`, rewritten before every session, so a change takes effect on the next session without a restart.
- `kikimora settings patch` follows the same rules as everywhere else: an array is replaced whole (`{"executor":{"mcpServers":["a"]}}`), and `null` deletes a key (`{"mcpServers":{"linter":null}}` drops that server).

## Working hours

The monitor patrols only inside the configured window; outside it the loop sleeps until the next opening. The executor is not limited by the window — it finishes whatever is already in the queue.

- `activeHours` — `HH:MM-HH:MM`, e.g. `08:00-18:00`. Overnight windows work too: `22:00-06:00`.
- `activeDays` — day tokens `mon`…`sun`, as ranges and/or a comma-separated list: `mon-fri`, `sat-sun`, `mon,wed,fri`, `fri-mon`.

## Timeouts and retries

- `sessionTimeoutMs` kills a stuck session (SIGTERM, then SIGKILL after 5 s). A timeout counts as a **transient** failure.
- `fable` sessions on hard tasks routinely run for many minutes. Leave `executor.sessionTimeoutMs` unset or generous when the executor runs on `fable`, and raise the summarizer's 5-minute default before switching it to `fable`.
- The executor retries transient failures (timeouts, known error patterns in the result) up to `maxTaskAttempts` with `retryDelayMs` between attempts; permanent failures mark the task `failed` right away. Failed tasks can be requeued from the TUI with `/retry <task-id>`.

## The `.kikimora/` directory

Like Claude Code's `.claude/`, kikimora keeps all per-project state in `.kikimora/` inside the directory you run it from:

```
your-project/
└── .kikimora/
    ├── settings.json              # configuration (validated with zod)
    ├── .gitignore                 # ignores data/ and logs/ (written once by the wizard)
    ├── prompts/
    │   ├── monitor.prompt.md      # what the monitor should check on every patrol
    │   ├── executor.prompt.md     # who the executor is and how it works
    │   └── context.md             # optional: what the workspace is, for both agents
    ├── data/
    │   ├── tasks.json             # task queue (atomic writes)
    │   ├── memory.db              # long-term memory (SQLite + FTS5)
    │   ├── mcp/                   # MCP configuration, one file per agent session
    │   └── playwright/            # browser screenshots and downloads (browser: true)
    └── logs/                      # session logs: <agent>/<day>/<hour>_<sessionId>.log
```

Commit `settings.json` and `prompts/` if your team shares them — `data/` and `logs/` are runtime state, ignored automatically via the wizard-written `.kikimora/.gitignore`.

Tasks live in `data/tasks.json`; tasks stuck `in_progress` after a crash are reset to `pending` on the next start. Every session is also written to a persistent log under `logs/`, so you can always read back what an agent actually did.
