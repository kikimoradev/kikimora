# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `brownie drain [--timeout <ms>] [--json]`, `/drain` in the dashboard and the `drain` control command stop a worker without throwing work away: both agents finish what they are doing — an executor session together with its memory summary — start nothing new, and the process exits `0` once both are idle. The command answers at once with `{"state":"draining","since":…,"until":…}`; `--timeout` (`timeoutMs` on the socket, up to 24 hours) sets a deadline after which whatever still runs is killed. A repeated request answers with the first acknowledgement and never moves the deadline, `resume` is refused while draining, and `brownie status` shows the drain (`drain` in the JSON document). The headless log gains `worker.draining`, and `worker.stopped` carries `drained`, plus `forced` when the deadline or a signal cut the drain short ([docs/control.md](docs/control.md)).

## [0.6.0] - 2026-09-14

### Added

- Your own MCP servers in `.brownie/settings.json`: declare them once under `mcpServers` (the Claude Code entry format — `command`/`args`/`env` for stdio, `type`/`url`/`headers` for `http` and `sse`, with `${VAR}` expansion so secrets stay in the environment), then hand each agent the ones it needs through `monitor.mcpServers` and `executor.mcpServers`. A name no server declares, or one of the reserved `memory` and `playwright`, fails validation at the offending path. The executor still gets the memory server on top of its list, the summarizer still gets none, and a change applies to the next session without a restart ([docs/configuration.md](docs/configuration.md#mcp-servers)).
- `browser: true` gives the monitor and the executor a browser: the bundled `playwright-mcp` runs headless with an isolated profile and writes screenshots and downloads to `.brownie/data/playwright` instead of into your repository. It needs the `-browser` image, and preflight says so at boot rather than letting the first session fail on a missing tool.
- The reference image carries the Docker buildx plugin next to the compose plugin, so an agent can run `docker buildx build` without installing it first.
- An optional `.brownie/prompts/context.md` describes the workspace the agents work in — repositories, APIs, whatever the project needs them to know. It is appended to both project prompts (for the executor, ahead of the `## Task to complete` section) and re-read before every session, so an edit applies to the next one; without the file the prompts go out exactly as before. Edit it with `/context` in the dashboard, with `brownie context get|set [file|-]` from a shell, or over the socket with `context.get` / `context.set` — an empty `context.set` clears it ([docs/prompts.md](docs/prompts.md), [docs/control.md](docs/control.md)).
- A machine-readable transcript next to every session log. Alongside `.brownie/logs/<agent>/<day>/<time>-<sessionId>.log` brownie now writes a `.jsonl` of the same name holding the raw Claude Code stream, one line per event in a `{"ts":…,"event":{…}}` envelope (`ts` in UTC, `event` untouched, so new message types survive). Token deltas are left out — the assistant blocks already carry the full text — and a non-JSON line from the CLI is kept as `{"ts":…,"raw":"…"}`. Brownie never deletes these files; prune them yourself ([docs/deployment.md](docs/deployment.md#session-transcripts)).
- `brownie sessions list [--agent] [--task] [--before] [--limit]` and `brownie sessions show <id> [--log]`, backed by a `sessions` table in `.brownie/data/memory.db` and the `sessions.list`/`sessions.get` control commands. Every session is indexed when it starts and closed with its outcome when it ends — agent, task or cycle, model, start and finish, `ok`, failure reason, cost, turns, and the paths of both transcript files (relative to `.brownie/`, so the index travels between a container and its host). A session killed before Claude Code reported a result is closed without a cost. `sessions.get` answers with metadata only — a socket reply is one line and an executor transcript is megabytes — so read the files through `--log` or straight from the volume ([docs/control.md](docs/control.md#the-session-index)).
- `sessionId` on `task.finished`, `cycle.finished` and `summary.finished`, and `taskId`/`cycle` on `session.init`, in the headless log and in the recent outcomes of `brownie status` — enough to join an outcome to the session that produced it without guessing.
- `brownie init` provisions a whole project in one non-interactive call: `--settings <file>` writes `.brownie/settings.json` and `--context <file>` the context file, next to the two prompts. The settings document is checked against the same schema the worker uses **before** anything is written, so a typo fails with the worker's own `Invalid configuration (.brownie/settings.json): …` and exit 1 with the project untouched, and it is stored exactly as you wrote it, defaults left to brownie. `--force` now covers every file the call writes, settings and context included, and `--settings` and `--context` on their own are a complete invocation — enough to refresh the configuration of a project that already has its prompts ([docs/deployment.md](docs/deployment.md#provisioning-without-a-terminal)).

### Changed

- Agent sessions no longer inherit MCP configuration from outside brownie. Every session gets `--mcp-config` pointing at a file brownie composes for that agent (`.brownie/data/mcp/<agent>.json`) plus `--strict-mcp-config`, so a repository's `.mcp.json`, `~/.claude.json` and `.claude/settings.json` are ignored — a checkout the agents work on is untrusted input and can no longer slip a server into a session. If you registered Playwright in `.mcp.json`, set `"browser": true` instead. The configuration also stopped travelling in `argv`, where any process in the container could read it with `ps`.

## [0.5.1] - 2026-09-14

### Changed

- The JSON log carries the whole of what an agent said. `session.text` and `session.toolError` were cut to 500 characters with their whitespace flattened before they ever left the worker, which is right for a terminal line and wrong for a log another program reads: a supervisor storing the stream had no way to recover the rest. The cut moved to where it belongs, the pretty formatter, so `--log-format pretty` looks as it always did while `--log-format json` keeps the text intact, newlines and all. Tool output on `session.toolError` joins its lines with newlines rather than spaces; it stays bounded by the existing twenty lines of three hundred characters.

## [0.5.0] - 2026-09-11

### Added

- `brownie tasks|settings|prompt|memory` subcommands and a documented wire protocol on the control socket: list, add, retry and cancel tasks, read or patch settings live (a sparse JSON merge where `null` deletes a key, validated before writing), read or replace the project prompts, and query long-term memory — everything the dashboard can do, from a shell or from your own tooling ([docs/control.md](docs/control.md)).
- `BROWNIE_CONTROL_SOCKET` moves the control socket to a path both a container and its host can see; the worker creates the directory and the CLI reads the same variable.
- `--paused` (env `BROWNIE_START_PAUSED=1`) boots a headless worker with both agents paused, so a supervisor decides when they start.
- Credential failures park the agents instead of burning retries: a rejected token (`401`, `Not logged in`) returns the task to the queue without consuming an attempt, pauses both agents in the new `authBlocked` phase — visible in the dashboard, `brownie status` and the `monitor.authBlocked` / `executor.authBlocked` log events — and waits for `brownie resume` or `/start`. Preflight runs `claude auth status --json` and refuses to start when no login is configured.
- Prebuilt container images on GHCR, published for `linux/amd64` and `linux/arm64` with every release: `ghcr.io/brownie-labs/brownie` is the image the reference `Dockerfile` builds, and the `-browser` variant adds Chromium (run headless) with a pinned `@playwright/mcp` (installed globally as `playwright-mcp`) for agents that browse the web through MCP. Tagged `<version>`, `<major>.<minor>` and `latest` — use them in `docker-compose.yml` with `image:` instead of `build:` ([docs/deployment.md](docs/deployment.md#prebuilt-images)).
- `brownie version [--json]` and the `{"cmd":"version"}` control request expose a running worker's identity — brownie, Claude Code CLI and Node versions, pid, start time, project directory, and `authKind` (`apiKey`, `oauth`, `claude.ai` or `unknown`, never the secret itself). `brownie status --json` carries the same fields and the headless `worker.started` event logs the versions and `authKind` too; `brownie --version` is unchanged.

### Changed

- The `Dockerfile` names its stages: `runtime` is the image it always built and stays the default target of a plain `docker build .`, `browser` is the new variant (`docker build --target browser .`); `docker-compose.yml` targets `runtime` explicitly.
- `brownie status` opens with an identity line (`brownie <version> · claude <version> · auth <kind> · pid <pid> · …`), and a CLI asking a worker started from an older brownie for a command it predates gets a restart hint instead of `Unrecognized control request.`
- The Docker image pins the Claude Code version (`CLAUDE_CODE_VERSION`, overridable from `docker-compose.yml`) and disables both auto-updaters, so every container runs the CLI it was built with.

## [0.4.0] - 2026-09-03

### Added

- `fable` joins the model aliases accepted by `/model` and `settings.json` (`monitor.model`, `executor.model`, `summarizer.model`), with the full `low`…`max` effort range. Defaults are unchanged.

## [0.3.1] - 2026-07-13

### Changed

- Upgraded runtime dependencies, notably ink 6 → 7 and zod 3 → 4.

### Fixed

- Suppress the `ExperimentalWarning: SQLite is an experimental feature` noise that Node prints on every invocation. The CLI shebang and the spawned memory MCP server now pass `--disable-warning=ExperimentalWarning`, and the `start`/`dev` scripts do the same, so `brownie --version`, `brownie update`, and every other command start clean.

## [0.3.0] - 2026-07-09

### Added

- Self-update: `brownie update` (with `--check`) compares the installed version against the npm registry and installs the newest release using whichever package manager put it there (npm/pnpm/yarn/bun). A running worker also checks in the background and, when `autoUpdate` is on (the default), installs new versions to apply on the next restart — surfaced in the dashboard header and as `update.available` / `update.installed` headless events. Configure it in the new global `~/.brownie/config.json`, or disable it entirely with `BROWNIE_DISABLE_AUTOUPDATER=1`.

## [0.2.0] - 2026-07-09

### Changed

- The Docker image now ships Python 3 (with `pip`/`venv`) and the Docker CLI + compose plugin alongside Node, plus a developer baseline (`gh`, `jq`, `ripgrep`, `make`, `build-essential`, `curl`). The agent provisions any other runtimes itself via the host's Docker socket, which `docker-compose.yml` now mounts. Credentials (`gh`/`ssh`/`git`) configured inside the container persist across restart and rebuild in a named `brownie-home` volume; grant socket access on Linux with `DOCKER_GID`.

## [0.1.0] - 2026-07-08

Initial release.

### Added

- Two-agent worker loop: a monitor that patrols your sources on an interval and reports tasks as structured JSON, and an executor that completes them one by one with full tool access.
- Long-term memory (SQLite + FTS5) written by a summarizer after every executor session and exposed back to the executor over MCP (`memory_search`, `memory_get`).
- Interactive TUI in the style of Claude Code: live agent status, dashboard/agent/task/memory views, slash commands with history and tab completion.
- Runtime configuration (`/model`, `/effort`, `/interval`, `/hours`, `/days`, `/prompt`) persisted to `.brownie/settings.json` and applied without restart.
- Working hours and days for the monitor; agents boot paused in a terminal and start with `/start`.
- Usage-limit awareness: when Claude Code hits its 5-hour or weekly limit both agents park with a countdown and resume after the reset; interrupted tasks return to the queue without burning a retry.
- Transient-failure retries with fail-fast for permanent errors; stalled tasks recover on restart.
- Headless mode for servers: structured line logs (pretty or NDJSON), a local control socket, and the `brownie status` / `pause` / `resume` commands.
- Non-interactive `brownie init` for provisioning, plus a first-run wizard in the terminal.
- Reference `Dockerfile` and `docker-compose.yml`.

[Unreleased]: https://github.com/brownie-labs/brownie/compare/v0.5.0...HEAD
[0.6.0]: https://github.com/brownie-labs/brownie/compare/v0.5.1...v0.6.0
[0.5.1]: https://github.com/brownie-labs/brownie/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/brownie-labs/brownie/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/brownie-labs/brownie/compare/v0.3.1...v0.4.0
[0.3.1]: https://github.com/brownie-labs/brownie/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/brownie-labs/brownie/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/brownie-labs/brownie/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/brownie-labs/brownie/releases/tag/v0.1.0
