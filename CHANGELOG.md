# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- A task attempt that the Claude usage limit stops now resumes its Claude Code session after the reset (`claude --resume`), with a note on when the limit hit and how long the worker waited, instead of starting the task over in a fresh session; the work and the cost of the interrupted attempt are no longer lost. A session that cannot be resumed (`failureReason` `resumeFailed`) falls back to a fresh session in the same attempt, and every other failure still retries in a fresh session. `tasks.list` shows the session to resume as `resume`, `task.started` as `resumedSessionId`, and the memory summary of a resumed session reads all of its log files.
- The agents' `memory_search` tool returns its matches newest first, so the latest attempts at a task come before older ones and survive the result limit; it takes `order: "rank"` for the best match first.

### Fixed

- The package requires `@modelcontextprotocol/sdk` 1.32.1 or later instead of 1.29.0, so an install can no longer keep an SDK release with its known high advisories. The lockfile moves the SDK's dependencies to fixed releases as well (`proxy-addr` 2.0.8, `fast-uri` 3.1.8, `ip-address` 10.7.4, `hono` 4.13.13, `qs` 6.16.1), and `pnpm audit` reports no known advisory. The memory MCP server behaves as before.
- A task attempt that ended by its session timeout, or by a shutdown, got no memory entry, because its result lost the session id. The id now comes from the session's start, so the attempt is summarized from its log like any other failure, and `task.finished` carries its `sessionId`.

## [0.15.1] - 2026-10-22

### Changed

- The Docker image pins Claude Code 2.1.293 instead of 2.1.284. Its `haiku` alias resolves to Claude Haiku 5.5 instead of Claude Haiku 4.5, so an agent on the default monitor model moves to Haiku 5.5 with this release, and a container runs the same models as a worker on a host with Claude Code 2.1.293.

### Fixed

- `authKind` reports `apiKey` for a Console sign-in with a stored API key, which Claude Code 2.1.286 and later report as the `api_key` method of `claude auth status`, instead of `unknown`.

## [0.15.0] - 2026-10-19

### Added

- The control requests `memory.recent` and `memory.search` take an optional `beforeId`, which returns only the entries older than that id, and an optional `ok`, which keeps the entries of tasks that succeeded or failed, so a client can page through the whole memory instead of the newest 100 entries. `memory.search` also takes `"order":"newest"` to return its matches newest first; the default stays best match first, and the `memory_search` tool of the agents is unchanged.

## [0.14.0] - 2026-10-19

### Added

- `kikimora tasks delete <id>`, `kikimora tasks delete --status done|failed|cancelled`, the dashboard commands `/delete` and `/purge` and the control request `tasks.delete` delete finished tasks, which until now stayed in `tasks.json` for good. A pending or running task and an unknown id are refused. The monitor's report is deduplicated against the stored tasks, so a deleted id that the monitor reports again comes back as a new task.

## [0.13.0] - 2026-10-16

### Added

- A [session launcher](docs/deployment.md#session-launcher) can refuse a session by exiting with 75 before Claude Code starts. The executor then returns the task to the queue without spending an attempt and tries again after 30 s, and the monitor repeats the cycle after 30 s, a requested check included; before, the task failed for good.
- A session that a launcher started and that ends by `SIGKILL`, or whose launcher exits with 137, without the worker stopping it, is reported as killed by the pool memory limit (`poolMemoryLimit`) and retried like other transient failures, up to `maxTaskAttempts`.
- `task.finished`, `cycle.finished`, `summary.finished` and the recent outcomes in `kikimora status` carry the session's `failureReason`, so a supervisor can show why a session failed. Without a launcher, sessions fail and retry as before.

## [0.12.0] - 2026-10-16

### Added

- `KIKIMORA_SESSION_LAUNCHER` starts every monitor, executor and summarizer session through a command of yours, given as a JSON array; the launcher learns the session's role, admission pool and ticket from `KIKIMORA_SESSION_ROLE`, `KIKIMORA_ADMISSION_POOL` and `KIKIMORA_ADMISSION_TICKET`, so a supervisor can place each session in a resource pool before Claude Code starts. Without the variable sessions start as before.
- The new `session.spawned` log event reports each session's pid, role, pool and ticket, and `status` shows the pid on a held admission slot while the session process runs.
- `kikimora memory export <path>` and the control request `memory.export` copy `memory.db`, the session index included, to a new file while the agents keep working, as a consistent SQLite snapshot that Kikimora opens on any machine.

### Changed

- A session that times out, is aborted or outlives a drain deadline is stopped together with the MCP servers, shells and other processes it started: on Linux and macOS through its own process group, on Windows with `taskkill /T`. Closing the terminal (`SIGHUP`) now stops the worker the way Ctrl+C does.

## [0.11.0] - 2026-10-15

### Added

- `KIKIMORA_ADMISSION=external` lets a supervisor such as Kikimora Cloud decide when sessions start: each monitor cycle and each task waits in the new `admissionWait` phase until the control request `admission.grant` admits it, holds the slot through the session and the memory summary, and gives it back afterwards, so many workers can share one machine without reserving it; `status` reports the admission state and new `admission.*` log events follow it. Without the variable nothing changes.

## [0.10.0] - 2026-10-01

### Added

- `kikimora check`, the dashboard command `/check` and the control request `monitor.check` run a monitor cycle now instead of waiting for the interval, also outside the working hours. A paused or draining worker and a running usage limit refuse it; a cycle already in progress is reported instead of doubled.

## [0.9.2] - 2026-09-30

### Changed

- Sessions run with `--settings '{"attribution":{"commit":"","pr":""}}'`, so Claude Code no longer adds a `Co-Authored-By` trailer to the commits and pull requests an agent makes.

## [0.9.1] - 2026-09-29

### Changed

- The Docker image pins Claude Code 2.1.284 instead of 2.1.268. Its `opus` alias resolves to Claude Opus 5.5, so an agent on the default executor model moves to Opus 5.5 with this release.

## [0.9.0] - 2026-09-25

### Added

- Tab completes command values in the TUI (agents, models, effort levels, `off`), and the input shows the missing arguments as a gray hint, e.g. `/model <agent> <model>`.
- Readline keys in the command line and in the prompt editor: Ctrl+A/E, Ctrl+W, Ctrl+U/K, Alt+←/→ and forward Delete.
- PgUp/PgDn scrolls `/tasks`, `/memory`, `/config` and `/help`; the panel border shows the visible range.
- Below 100 columns the dashboard shows one agent at a time with tabs; Tab switches between them.
- A spinner marks a running session, and the task table spins next to the task in progress.

### Changed

- The TUI is redesigned: panels carry their title, model and last outcome in the border, the header is one line, and a status bar at the bottom shows the view, one dot per agent and the keys that apply right now. Hierarchy comes from weight (bold titles, plain content, dim metadata), so titles no longer blend with the text below them.
- Command results appear in the status bar with ✔/✖/⚠ for five seconds and no longer shift the layout.
- Durations read `3.7s`, `42s`, `12m 05s`, `1h 02m`; costs show three decimals below a dollar; reset times read `14:00`, `tomorrow 09:00` or `Mon 09:00`. Glyphs are single-width, with no emoji.
- The task table has aligned status, id, title and age columns, and a failed task's error sits on its own line.
- Each session starts with a divider line (model, tools, session id), so consecutive sessions in a panel no longer run together.
- `/help` groups commands by topic; `/config` names the command that changes each entry and uses two columns on wide terminals.
- The setup wizard puts each question in the editor border, summarizes the first answer during the second step, and shows line and character counts.

### Fixed

- The task table no longer glues the `in progress` status to the task id.
- `/config` no longer silently cuts off entries that do not fit on the screen.
- The prompt editor no longer grows past the screen when long lines wrap; the viewport and the arrow keys follow wrapped rows.
- A failed `/prompt` or `/context` save now shows its error inside the editor instead of behind it.
- The header says `1 cycle` instead of `1 cycles`.

## [0.8.1] - 2026-09-19

### Changed

- The dashboard and the setup wizard are black and white. Color marks states only: green for done and successful, yellow for pending and warnings, red for failures, cyan for work in progress. A task count of zero is gray.

## [0.8.0] - 2026-09-19

### Changed

- **Breaking:** the project is renamed from Brownie to Kikimora. Kikimora reads none of the old names, so an existing installation needs the manual steps below.

  | What                       | Before                                                                | After                                                                     |
  | -------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------- |
  | npm package                | `@brownie-labs/brownie`                                               | `@kikimoradev/kikimora`                                                   |
  | binary                     | `brownie`                                                             | `kikimora`                                                                |
  | project directory          | `.brownie/`                                                           | `.kikimora/`                                                              |
  | global configuration       | `~/.brownie/config.json`                                              | `~/.kikimora/config.json`                                                 |
  | log format variable        | `BROWNIE_LOG_FORMAT`                                                  | `KIKIMORA_LOG_FORMAT`                                                     |
  | paused start variable      | `BROWNIE_START_PAUSED`                                                | `KIKIMORA_START_PAUSED`                                                   |
  | control socket variable    | `BROWNIE_CONTROL_SOCKET`                                              | `KIKIMORA_CONTROL_SOCKET`                                                 |
  | auto-updater variable      | `BROWNIE_DISABLE_AUTOUPDATER`                                         | `KIKIMORA_DISABLE_AUTOUPDATER`                                            |
  | control socket file name   | `brownie-<uid>-<hash>`                                                | `kikimora-<uid>-<hash>`                                                   |
  | memory MCP server name     | `brownie-memory`                                                      | `kikimora-memory`                                                         |
  | container images           | `ghcr.io/brownie-labs/brownie`                                        | `ghcr.io/kikimoradev/kikimora`                                            |
  | OCI labels                 | `ai.brownie.claude-code.version`, `ai.brownie.playwright-mcp.version` | `dev.kikimora.claude-code.version`, `dev.kikimora.playwright-mcp.version` |
  | container user and home    | `brownie`, `/home/brownie`                                            | `kikimora`, `/home/kikimora`                                              |
  | compose service and volume | `brownie`, `brownie-home`                                             | `kikimora`, `kikimora-home`                                               |

  To migrate:
  - install `@kikimoradev/kikimora`;
  - rename the project directory: `mv .brownie .kikimora`;
  - rename the global configuration directory, if present: `mv ~/.brownie ~/.kikimora`;
  - rename the environment variables in systemd units, compose files and shells;
  - in Docker, configure `gh`, `ssh` and `git` again in the new `kikimora-home` volume, since the old `brownie-home` volume is no longer mounted.

  At the default socket path, the `kikimora` CLI does not find a worker started from `brownie`; restart the worker after the upgrade.

## [0.7.0] - 2026-09-17

### Added

- A drain stops a worker after its running work finishes. `kikimora drain [--timeout <ms>] [--json]`, `/drain` in the dashboard and the `drain` control command start it ([docs/deployment.md](docs/deployment.md#stopping-the-worker), [docs/control.md](docs/control.md)).
  - Both agents finish their current work, an executor session together with its memory summary, and start nothing new. The process exits `0` once both are idle.
  - The command answers at once with `{"state":"draining","since":…,"until":…}`.
  - `--timeout` (`timeoutMs` on the socket, at most 24 hours) sets a deadline after which what still runs is killed.
  - A repeated request returns the first acknowledgement and does not move the deadline. `resume` is refused while draining.
  - `kikimora status` shows the drain (`drain` in the JSON document).
  - The headless log gains `worker.draining`. `worker.stopped` carries `drained`, plus `forced` when the deadline or a signal cut the drain short.
- `shutdownGraceMs` in `.kikimora/settings.json` turns `SIGTERM` into a drain with that deadline ([docs/deployment.md](docs/deployment.md#stopping-the-worker)).
  - `docker stop`, or `systemctl stop` on a unit with `KillMode=mixed`, then lets a running session finish.
  - The worker exits `0` once both agents are idle (`worker.stopped signal=SIGTERM drained=true`), or kills what still runs when the grace is up.
  - The default `0` keeps the immediate stop. `SIGINT` stops at once, and a second signal of either kind during a drain stops at once too.
  - A patched value applies to the next signal.

### Changed

- A stop timeout shorter than the shutdown grace makes the supervisor send `SIGKILL` in the middle of the drain. `docs/deployment.md` now says to set `stop_grace_period` (Compose) or `TimeoutStopSec` (systemd) at least 10 s above `shutdownGraceMs`. It also notes that `docker stop -t 10` kills the worker after 10 s regardless of the grace. Under systemd the unit also needs `KillMode=mixed`, which the runbook's unit now sets. The default `control-group` sends `SIGTERM` to the `claude` sessions as well, so they die as the grace begins and the executor's task is marked failed ([docs/deployment.md](docs/deployment.md#stopping-the-worker)).
- A pause or a drain that arrives while an agent prepares its next session (reading the prompts, writing the MCP configuration) now takes effect before that session starts. The monitor skips the cycle. The executor returns the task it has just claimed to the queue with its attempt given back. Previously that one session still ran.
- After a signal has stopped the worker, while it kills sessions and closes its logs, any further signal ends the process at once. Previously only a repeat of the same signal did, and the other signal was ignored.

## [0.6.0] - 2026-09-14

### Added

- Custom MCP servers in `.kikimora/settings.json` ([docs/configuration.md](docs/configuration.md#mcp-servers)).
  - Declare them once under `mcpServers` in the Claude Code entry format: `command`/`args`/`env` for stdio, `type`/`url`/`headers` for `http` and `sse`. `${VAR}` expansion keeps secrets in the environment.
  - Give each agent the servers it needs through `monitor.mcpServers` and `executor.mcpServers`.
  - A name that no server declares, or one of the reserved `memory` and `playwright`, fails validation at the offending path.
  - The executor still gets the memory server in addition to its list, and the summarizer still gets none.
  - A change applies to the next session without a restart.
- `browser: true` gives the monitor and the executor a browser. The bundled `playwright-mcp` runs headless with an isolated profile and writes screenshots and downloads to `.kikimora/data/playwright`, which `.kikimora/.gitignore` excludes. It needs the `-browser` image; preflight reports a missing binary at startup, before the first session.
- The reference image includes the Docker buildx plugin next to the compose plugin, so an agent can run `docker buildx build` without installing it.
- An optional `.kikimora/prompts/context.md` describes the workspace the agents work in: repositories, APIs, anything the project needs them to know ([docs/prompts.md](docs/prompts.md), [docs/control.md](docs/control.md)).
  - It is appended to both project prompts; for the executor, ahead of the `## Task to complete` section.
  - It is re-read before each session, so an edit applies to the next one. Without the file, the prompts are unchanged.
  - Edit it with `/context` in the dashboard, with `kikimora context get|set [file|-]` from a shell, or over the socket with `context.get` / `context.set`. An empty `context.set` clears it.
- A machine-readable transcript next to each session log ([docs/deployment.md](docs/deployment.md#session-transcripts)).
  - Next to `.kikimora/logs/<agent>/<day>/<time>-<sessionId>.log`, kikimora writes a `.jsonl` of the same name with the raw Claude Code stream.
  - Each line is one event in a `{"ts":…,"event":{…}}` envelope: `ts` in UTC, `event` unchanged, so new message types are kept.
  - Token deltas are left out, because the assistant blocks carry the full text. A non-JSON line from the CLI is kept as `{"ts":…,"raw":"…"}`, cut to 500 characters.
  - Kikimora does not delete these files; prune them yourself.
- `kikimora sessions list [--agent] [--task] [--before] [--limit]` and `kikimora sessions show <id> [--log]` ([docs/control.md](docs/control.md#the-session-index)).
  - They read a `sessions` table in `.kikimora/data/memory.db`, also exposed as the `sessions.list` and `sessions.get` control commands.
  - A session is indexed when it starts and closed with its outcome when it ends: agent, task or cycle, model, start and finish, `ok`, failure reason, cost, turns, and the paths of both transcript files.
  - The paths are relative to `.kikimora/`, so the index stays valid in a container and on its host.
  - A session killed before Claude Code reported a result is closed without a cost.
  - `sessions.get` returns metadata only, because a socket reply is one line and an executor transcript can be megabytes. Read the files with `--log` or from the volume.
- `sessionId` on `task.finished`, `cycle.finished` and `summary.finished`, and `taskId`/`cycle` on `session.init`, in the headless log and in the recent outcomes of `kikimora status`. They link an outcome to the session that produced it.
- `kikimora init` provisions a whole project in one non-interactive call ([docs/deployment.md](docs/deployment.md#provisioning-without-a-terminal)).
  - `--settings <file>` writes `.kikimora/settings.json` and `--context <file>` the context file, next to the two prompts.
  - The settings document is checked against the worker's schema **before** anything is written. A typo fails with the worker's own `Invalid configuration (.kikimora/settings.json): …` and exit 1, and the project is left unchanged.
  - The document is stored as written, without defaults filled in.
  - `--force` now covers every file the call writes, settings and context included.
  - `--settings` and `--context` on their own are a complete invocation, enough to refresh the configuration of a project that already has its prompts.

### Changed

- Agent sessions no longer inherit MCP configuration from outside kikimora.
  - Each session gets `--mcp-config` pointing at a file kikimora composes for that agent (`.kikimora/data/mcp/<agent>.json`), plus `--strict-mcp-config`.
  - A repository's `.mcp.json`, `~/.claude.json` and `.claude/settings.json` are ignored. A checkout the agents work on is untrusted input and can no longer add a server to a session.
  - If you registered Playwright in `.mcp.json`, set `"browser": true` in its place.
  - The configuration is no longer passed in `argv`, where any process in the container could read it with `ps`.

## [0.5.1] - 2026-09-14

### Changed

- The JSON log carries the full text of what an agent said.
  - Before, `session.text` and `session.toolError` were cut to 500 characters, with whitespace flattened, before they left the worker. A supervisor storing the stream could not recover the rest.
  - The cut now happens in the pretty formatter only. `--log-format pretty` output is unchanged, and `--log-format json` keeps the text intact, newlines included.
  - Tool output on `session.toolError` joins its lines with newlines in place of spaces. It stays bounded by the existing limit of 20 lines of 300 characters.

## [0.5.0] - 2026-09-11

### Added

- `kikimora tasks|settings|prompt|memory` subcommands and a documented wire protocol on the control socket ([docs/control.md](docs/control.md)). From a shell or your own tooling you can:
  - list, add, retry and cancel tasks;
  - read or patch settings live, as a sparse JSON merge where `null` deletes a key, validated before writing;
  - read or replace the project prompts;
  - query long-term memory.
- `KIKIMORA_CONTROL_SOCKET` moves the control socket to a path both a container and its host can see. The worker creates the directory, and the CLI reads the same variable.
- `--paused` (env `KIKIMORA_START_PAUSED=1`) starts a headless worker with both agents paused, so a supervisor decides when they start.
- Credential failures pause the agents without using up retries.
  - A rejected token (`401`, `Not logged in`) returns the task to the queue without consuming an attempt.
  - Both agents pause in the new `authBlocked` phase, visible in the dashboard, in `kikimora status` and in the `monitor.authBlocked` / `executor.authBlocked` log events.
  - They stay paused until `kikimora resume` or `/start`.
  - Preflight runs `claude auth status --json` and refuses to start when no login is configured.
- Prebuilt container images on GHCR, published for `linux/amd64` and `linux/arm64` with each release ([docs/deployment.md](docs/deployment.md#prebuilt-images)).
  - `ghcr.io/kikimoradev/kikimora` is the image the reference `Dockerfile` builds.
  - The `-browser` variant adds Chromium (run headless) and a pinned `@playwright/mcp`, installed globally as `playwright-mcp`, for agents that browse the web through MCP.
  - Tags: `<version>`, `<major>.<minor>` and `latest`. Use them in `docker-compose.yml` with `image:` in place of `build:`.
- `kikimora version [--json]` and the `{"cmd":"version"}` control request expose a running worker's identity: kikimora, Claude Code CLI and Node versions, pid, start time, project directory, and `authKind` (`apiKey`, `oauth`, `claude.ai` or `unknown`; the secret is not included). `kikimora status --json` carries the same fields, and the headless `worker.started` event logs the versions and `authKind`. `kikimora --version` is unchanged.

### Changed

- The `Dockerfile` names its stages. `runtime` is the image it built before and remains the default target of `docker build .`. `browser` is the new variant (`docker build --target browser .`). `docker-compose.yml` targets `runtime` explicitly.
- `kikimora status` starts with an identity line (`kikimora <version> · claude <version> · auth <kind> · pid <pid> · …`). A CLI that sends a worker started from an older kikimora a command the worker predates gets a restart hint in place of `Unrecognized control request.`
- The Docker image pins the Claude Code version (`CLAUDE_CODE_VERSION`, overridable from `docker-compose.yml`) and disables both auto-updaters, so a container runs the CLI version it was built with.

## [0.4.0] - 2026-09-03

### Added

- `fable` joins the model aliases accepted by `/model` and `settings.json` (`monitor.model`, `executor.model`, `summarizer.model`), with the full `low` to `max` effort range. Defaults are unchanged.

## [0.3.1] - 2026-07-13

### Changed

- Upgraded runtime dependencies, notably ink 6 → 7 and zod 3 → 4.

### Fixed

- Suppress the `ExperimentalWarning: SQLite is an experimental feature` message that Node printed on each invocation. The CLI shebang and the spawned memory MCP server now pass `--disable-warning=ExperimentalWarning`, and so do the `start` and `dev` scripts. `kikimora --version`, `kikimora update` and the other commands start without the warning.

## [0.3.0] - 2026-07-09

### Added

- Self-update.
  - `kikimora update` (with `--check`) compares the installed version against the npm registry and installs the newest release with the package manager that installed it (npm, pnpm, yarn or bun).
  - A running worker also checks in the background. When `autoUpdate` is on (the default), it installs new versions, which apply on the next restart. The dashboard header and the `update.available` / `update.installed` headless events report them.
  - Configure it in the new global `~/.kikimora/config.json`, or turn it off with `KIKIMORA_DISABLE_AUTOUPDATER=1`.

## [0.2.0] - 2026-07-09

### Changed

- The Docker image now ships Python 3 (with `pip` and `venv`) and the Docker CLI with the compose plugin, next to Node, plus a developer baseline: `gh`, `jq`, `ripgrep`, `make`, `build-essential`, `curl`.
- The agent provisions other runtimes itself through the host's Docker socket, which `docker-compose.yml` now mounts. Grant socket access on Linux with `DOCKER_GID`.
- Credentials (`gh`, `ssh`, `git`) configured inside the container persist across restarts and rebuilds in a named `kikimora-home` volume.

## [0.1.0] - 2026-07-08

Initial release.

### Added

- Two-agent worker loop: a monitor that checks your sources on an interval and reports tasks as structured JSON, and an executor that completes them one at a time with full tool access.
- Long-term memory (SQLite + FTS5), written by a summarizer after each executor session and exposed to the executor over MCP (`memory_search`, `memory_get`).
- Interactive TUI modelled on Claude Code: live agent status, dashboard, agent, task and memory views, slash commands with history and tab completion.
- Runtime configuration (`/model`, `/effort`, `/interval`, `/hours`, `/days`, `/prompt`), saved to `.kikimora/settings.json` and applied without a restart.
- Working hours and days for the monitor. In a terminal the agents start paused and run after `/start`.
- Usage-limit handling: when Claude Code reports its 5-hour or weekly limit, both agents wait with a countdown and resume after the reset. Interrupted tasks return to the queue without using up a retry.
- Retries for transient failures; other failures mark the task failed at once. Stalled tasks recover on restart.
- Headless mode for servers: line logs (pretty or NDJSON), a local control socket, and the `kikimora status` / `pause` / `resume` commands.
- Non-interactive `kikimora init` for provisioning, plus a first-run wizard in the terminal.
- Reference `Dockerfile` and `docker-compose.yml`.

[Unreleased]: https://github.com/kikimoradev/kikimora/compare/v0.15.1...HEAD
[0.15.1]: https://github.com/kikimoradev/kikimora/compare/v0.15.0...v0.15.1
[0.15.0]: https://github.com/kikimoradev/kikimora/compare/v0.14.0...v0.15.0
[0.14.0]: https://github.com/kikimoradev/kikimora/compare/v0.13.0...v0.14.0
[0.13.0]: https://github.com/kikimoradev/kikimora/compare/v0.12.0...v0.13.0
[0.12.0]: https://github.com/kikimoradev/kikimora/compare/v0.11.0...v0.12.0
[0.11.0]: https://github.com/kikimoradev/kikimora/compare/v0.10.0...v0.11.0
[0.10.0]: https://github.com/kikimoradev/kikimora/compare/v0.9.2...v0.10.0
[0.9.2]: https://github.com/kikimoradev/kikimora/compare/v0.9.1...v0.9.2
[0.9.1]: https://github.com/kikimoradev/kikimora/compare/v0.9.0...v0.9.1
[0.9.0]: https://github.com/kikimoradev/kikimora/compare/v0.8.1...v0.9.0
[0.8.1]: https://github.com/kikimoradev/kikimora/compare/v0.8.0...v0.8.1
[0.8.0]: https://github.com/kikimoradev/kikimora/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/kikimoradev/kikimora/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/kikimoradev/kikimora/compare/v0.5.1...v0.6.0
[0.5.1]: https://github.com/kikimoradev/kikimora/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/kikimoradev/kikimora/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/kikimoradev/kikimora/compare/v0.3.1...v0.4.0
[0.3.1]: https://github.com/kikimoradev/kikimora/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/kikimoradev/kikimora/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/kikimoradev/kikimora/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/kikimoradev/kikimora/releases/tag/v0.1.0
