# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/kikimoradev/kikimora/compare/v0.8.0...HEAD
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
