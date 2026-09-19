# Configuration

Kikimora reads its configuration from `.kikimora/settings.json`, a nested JSON document validated against a strict schema. An unknown key fails validation with its path named. The first `kikimora` run asks only for the two agent prompts and writes the settings file as `{}`, so every setting starts at its default. Change settings at runtime with the slash commands below, or edit the file by hand and restart.

Every section is optional; `{}` is a valid file. A typical setup:

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

| Key                           | Default          | Description                                                                  |
| ----------------------------- | ---------------- | ---------------------------------------------------------------------------- |
| `monitor.model`               | `haiku`          | monitor model                                                                |
| `monitor.effort`              | `medium`         | monitor effort: `low`, `medium`, `high`, `xhigh`, `max`                      |
| `monitor.intervalMinutes`     | `15`             | patrol interval, measured from the start of a cycle; fractions allowed       |
| `monitor.activeHours`         | _(24/7)_         | working window, e.g. `08:00-18:00`                                           |
| `monitor.activeDays`          | _(every day)_    | working days, e.g. `mon-fri` or `mon,wed,sat-sun`                            |
| `monitor.sessionTimeoutMs`    | _(none)_         | monitor session timeout                                                      |
| `executor.model`              | `opus`           | executor model                                                               |
| `executor.effort`             | `high`           | executor effort                                                              |
| `executor.sessionTimeoutMs`   | _(none)_         | executor session timeout                                                     |
| `executor.maxTaskAttempts`    | `3`              | maximum attempts per task (transient failures are retried)                   |
| `executor.retryDelayMs`       | `30000`          | delay between attempts                                                       |
| `summarizer.model`            | `sonnet`         | summarizer model                                                             |
| `summarizer.effort`           | `medium`         | summarizer effort                                                            |
| `summarizer.sessionTimeoutMs` | `300000` (5 min) | summarizer session timeout                                                   |
| `streamPartial`               | `true`           | stream partial responses to the dashboard                                    |
| `mcpServers`                  | _(none)_         | MCP servers available to the agents, keyed by name                           |
| `monitor.mcpServers`          | _(none)_         | names from `mcpServers` the monitor gets                                     |
| `executor.mcpServers`         | _(none)_         | names from `mcpServers` the executor gets                                    |
| `browser`                     | `false`          | give the monitor and the executor the bundled Playwright browser             |
| `shutdownGraceMs`             | `0`              | how long `SIGTERM` drains before the worker stops; at most `86400000` (24 h) |

Model values:

- `/model` accepts `haiku`, `sonnet`, `opus` and `fable`.
- The file accepts any non-empty string and passes it to `claude --model` unchanged.
- `/effort` is refused for an agent whose model is `haiku`.

[Stopping the worker](deployment.md#stopping-the-worker) explains `shutdownGraceMs` and what a drain waits for.

## Changing settings at runtime

Slash commands in the dashboard cover the everyday settings. Each command validates the value, writes it to `.kikimora/settings.json` and applies it to the **next agent session**. A running session finishes with the old values. No restart is needed.

| Command                     | Setting                                                  |
| --------------------------- | -------------------------------------------------------- |
| `/model <agent> <model>`    | `monitor.model`, `executor.model`, `summarizer.model`    |
| `/effort <agent> <level>`   | `monitor.effort`, `executor.effort`, `summarizer.effort` |
| `/interval <minutes>`       | `monitor.intervalMinutes`                                |
| `/hours <HH:MM-HH:MM\|off>` | `monitor.activeHours` (`off` clears it)                  |
| `/days <days\|off>`         | `monitor.activeDays` (`off` clears it)                   |
| `/config`                   | shows all current values                                 |

The remaining keys (`streamPartial`, `sessionTimeoutMs`, `maxTaskAttempts`, `retryDelayMs`, `browser`, `mcpServers`, `shutdownGraceMs`) have no slash command. Edit them by hand and restart, or patch them live from a shell with `kikimora settings patch` ([docs/control.md](control.md)). `/prompt <monitor|executor>` opens an agent prompt in the dashboard editor ([docs/prompts.md](prompts.md)).

## MCP servers

Each session runs with `--strict-mcp-config` against a file that kikimora writes. An agent sees exactly the servers configured here. A `.mcp.json` in the repository, `~/.claude.json` and `.claude/settings.json` are ignored. Declare a server once under `mcpServers`, then give it to an agent by name:

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

- An entry uses the Claude Code MCP server format: `command`, `args` and `env` for stdio; `type` (`http` or `sse`), `url` and `headers` for a remote server. `env` keys must be uppercase (`^[A-Z][A-Z0-9_]*$`).
- Claude Code expands `${VAR}` and `${VAR:-default}` in these fields, so secrets can stay in the environment and out of `settings.json`.
- Names are lowercase, up to 64 characters: `a-z` and `0-9`, with `_` and `-` allowed inside. `memory` and `playwright` are reserved.
- A name in an agent list that is missing from `mcpServers` fails validation at that index (`executor.mcpServers.0`).
- The executor gets the `memory` server in addition to its list. The monitor does not get `memory`. The summarizer gets no servers.
- `browser: true` adds the `playwright` server (headless Chromium, an isolated profile, screenshots in `.kikimora/data/playwright`) to the monitor and the executor. It needs `playwright-mcp` on `PATH`, which the `-browser` image provides ([docs/deployment.md](deployment.md#prebuilt-images)). Preflight refuses to start without it.
- The composed file is `.kikimora/data/mcp/<agent>.json`. It is rewritten before each session, so a change takes effect on the next session without a restart.
- `kikimora settings patch` replaces an array whole (`{"executor":{"mcpServers":["a"]}}`), and `null` deletes a key (`{"mcpServers":{"linter":null}}` drops that server).

## Working hours

The monitor patrols only inside the configured window and sleeps until the next opening outside it. Working hours do not apply to the executor, which keeps working through the queue.

- `activeHours`: `HH:MM-HH:MM`, e.g. `08:00-18:00`. A window may cross midnight: `22:00-06:00`.
- `activeDays`: day tokens `mon` to `sun`, as ranges, a comma-separated list, or both: `mon-fri`, `sat-sun`, `mon,wed,fri`, `fri-mon`.

Both use the local time of the worker process (see `TZ` in [the droplet runbook](deployment.md#a-droplet-runbook-systemd)).

## Timeouts and retries

- `sessionTimeoutMs` kills a session that runs longer: SIGTERM, then SIGKILL after 5 s. A timeout counts as a **transient** failure.
- A `fable` session on a hard task can run for many minutes. Leave `executor.sessionTimeoutMs` unset or generous when the executor runs on `fable`. Raise the summarizer's 5-minute default before switching it to `fable`.
- The executor retries transient failures (timeouts, known error patterns in the result) up to `maxTaskAttempts`, waiting `retryDelayMs` between attempts. Other failures mark the task `failed` at once.
- `/retry <task-id>` in the TUI, or `kikimora tasks retry <id>`, requeues a failed task with its attempt count reset.

## The `.kikimora/` directory

Kikimora keeps per-project state in `.kikimora/` inside the directory it runs from, like Claude Code's `.claude/`:

```
your-project/
└── .kikimora/
    ├── settings.json              # configuration (validated with zod)
    ├── .gitignore                 # ignores data/ and logs/ (written by setup when missing)
    ├── prompts/
    │   ├── monitor.prompt.md      # what the monitor checks on each patrol
    │   ├── executor.prompt.md     # how the executor works
    │   └── context.md             # optional: the workspace, for both agents
    ├── data/
    │   ├── tasks.json             # task queue (atomic writes)
    │   ├── memory.db              # long-term memory and the session index (SQLite + FTS5)
    │   ├── mcp/                   # MCP configuration, one file per agent
    │   └── playwright/            # browser screenshots and downloads (browser: true)
    └── logs/                      # session logs: <agent>/<YYYY-MM-DD>/<HH-MM-SS>-<sessionId>.log and .jsonl
```

Commit `settings.json` and `prompts/` if your team shares them. `data/` and `logs/` are runtime state, excluded by `.kikimora/.gitignore`, which the wizard and `kikimora init` write.

Tasks live in `data/tasks.json`. Tasks left `in_progress` by a crash are reset to `pending` on the next start. Each session also writes a log under `logs/` that records what the agent did ([session transcripts](deployment.md#session-transcripts)).
