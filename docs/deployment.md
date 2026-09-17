# Headless & deployment

Brownie runs unattended just as happily as it runs in a terminal. Without a TTY (systemd, Docker, CI, piping) it skips the dashboard entirely, boots the agents immediately, and prints structured line logs to stdout — one line per event, 12-factor style. A running worker is controlled from a second shell with `brownie status`, `brownie pause`, and `brownie resume`.

## Headless mode

Headless activates automatically when stdin or stdout is not a TTY. Force it in a terminal with `--headless`.

| Flag / env                    | Default  | Effect                                                                                |
| ----------------------------- | -------- | ------------------------------------------------------------------------------------- |
| `--headless`                  | auto     | skip the dashboard even in a terminal, agents start                                   |
| `--log-format <pretty\|json>` | `pretty` | line format on stdout                                                                 |
| `BROWNIE_LOG_FORMAT`          | —        | fallback for `--log-format` when the flag is absent                                   |
| `--verbose`                   | off      | also log session text, tool calls, and failed results                                 |
| `--paused`                    | off      | boot both agents paused — wake them with `brownie resume` (a TTY always boots paused) |
| `BROWNIE_START_PAUSED`        | —        | fallback for `--paused` (`1` or `true`)                                               |

`pretty` is made for `journalctl -f` and human eyes; `json` (NDJSON — one JSON object per line) is made for log aggregators (Loki, Datadog, CloudWatch). Session transcripts are always written to `.brownie/logs/` in both modes, so stdout stays a timeline, not a firehose.

### Log events

Every JSON line carries the envelope `ts` (ISO 8601), `level` (`info`/`warn`/`error`), `event`, and `agent` (`monitor`/`executor`/`summarizer`, absent on worker-level events), plus the event's own fields:

```json
{
  "ts": "2026-07-08T09:05:03.000Z",
  "level": "info",
  "agent": "executor",
  "event": "task.finished",
  "taskId": "ci-42",
  "title": "Fix the build",
  "ok": true,
  "durationMs": 183000,
  "costUsd": 0.4183,
  "numTurns": 24
}
```

| Event                                                         | Fields                                                                                                                                  |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `worker.started`                                              | `version`, `claudeVersion` (when readable), `nodeVersion`, `authKind`, `pid`, `projectDir`, `paused` (when booted paused)               |
| `worker.draining`                                             | `reason` (`drain`, or `SIGTERM` under a shutdown grace), `timeoutMs` (when the drain has a deadline)                                    |
| `worker.stopped`                                              | `signal` (when stopped by SIGINT/SIGTERM), `drained` (exited through a drain), `forced` (a deadline or a signal cut the drain short)    |
| `control.changed`                                             | `state` — an agent moved between `running`/`pausing`/`paused`                                                                           |
| `update.available` / `update.installed`                       | `from`, `to`; available adds `installError` when a background install failed                                                            |
| `cycle.started` / `cycle.finished`                            | `cycle`; finished adds `ok`, `durationMs`, `costUsd`, `addedTasks`, `skippedDuplicates`, `error`, `sessionId`                           |
| `monitor.sleeping` / `monitor.offHours` / `monitor.limitWait` | `nextCycleAt` / `resumeAt`                                                                                                              |
| `task.started` / `task.finished`                              | `taskId`, `title`; finished adds `ok`, `durationMs`, `costUsd`, `numTurns`, `willRetry`, `attempt`, `maxAttempts`, `error`, `sessionId` |
| `task.retryScheduled`                                         | `taskId`, `resumeAt`                                                                                                                    |
| `executor.waiting` / `executor.limitWait`                     | — / `resumeAt`                                                                                                                          |
| `monitor.authBlocked` / `executor.authBlocked`                | `reason` — credentials rejected; both agents park until `brownie resume`                                                                |
| `summary.started` / `summary.finished`                        | `taskId`; finished adds `ok`, `durationMs`, `costUsd`, `error`, `sessionId`                                                             |
| `session.init`                                                | `model`, `sessionId`, plus `taskId` (executor, summarizer) or `cycle` (monitor)                                                         |
| `session.stderr` / `session.procError` / `session.killed`     | `line` / `message` / `reason`                                                                                                           |
| `session.text` / `session.tool` / `session.toolError`         | only with `--verbose`                                                                                                                   |

Optional fields are omitted, never `null` — the schema is stable and safe to index. A `*.finished` event carries `sessionId` whenever Claude Code reported a result, which ties the outcome back to the session transcript below; a session killed by a timeout or a shutdown has none.

## Session transcripts

Every session writes two files side by side under `.brownie/logs/<agent>/<YYYY-MM-DD>/<HH-MM-SS>-<sessionId>.*`, named in the machine's local time:

- **`.log`** — the readable transcript the dashboard shows, one `[HH:MM:SS] …` line per event. The summarizer reads this one.
- **`.jsonl`** — the raw Claude Code stream, one JSON object per line, each wrapped in an envelope so the file survives new message types: `{"ts":"2026-09-14T15:44:12.531Z","event":{…}}`, where `ts` is UTC and `event` is the object Claude Code emitted, untouched. Token-by-token `stream_event` lines are left out — they carry single characters and the assistant blocks already hold the full text. A line the CLI printed that is not JSON is kept as `{"ts":…,"raw":"…"}`.

`brownie sessions list` and `brownie sessions show` find them by session id (see [docs/control.md](control.md#the-session-index)). Brownie never deletes them — on a long-lived server, prune them yourself:

```bash
find ~/your-project/.brownie/logs -type f -mtime +30 -delete
```

## Controlling a running worker

The worker exposes a local control socket, created automatically — nothing to configure. From any shell in the same project directory:

```bash
brownie status           # who's running, phases, task counts, cost
brownie status --json    # the same as machine-readable JSON
brownie version          # brownie, Claude Code and Node versions, auth kind, pid
brownie pause            # both agents finish their session, then park
brownie pause monitor    # just one agent
brownie resume           # back to work
brownie drain            # finish the current sessions, then exit
brownie sessions list    # what ran, when, at what cost
```

`brownie status --json` doubles as a health check — it exits non-zero when no worker is running. Its document opens with the worker's identity (brownie, Claude Code and Node versions, `authKind`, pid, start time), which `brownie version` prints on its own. The socket also guards against double starts: a second `brownie` in the same project refuses to boot with `brownie is already running in this project (pid …)`. The same socket edits tasks, settings, prompts and memory, reaches out of a container, and has a documented wire protocol — see [docs/control.md](control.md).

## Stopping the worker

`SIGINT` (ctrl+c) and `SIGTERM` (`systemctl stop`, `docker stop`) stop the worker at once by default: a session still running is killed (`session.killed reason=abort`), its task goes back to the queue on the next start, and the worker closes its logs and socket and exits with `worker.stopped signal=…`.

Draining stops it without throwing work away. `brownie drain` (also `/drain` and the `drain` control command) pauses both agents and exits the worker `0` the moment both are idle, with `worker.stopped drained=true`. A session in flight finishes — for the executor, together with the memory summary after it — and nothing new starts: a monitor cycle about to begin is skipped, and a task the executor has claimed but not started goes back to the queue with its attempt given back. `--timeout <ms>` (up to 24 hours) adds a deadline after which whatever still runs is killed (`forced=true`). The command returns at once; asking again answers with the first acknowledgement and never moves the deadline, `resume` is refused until the worker is gone, and `brownie status` shows the drain.

To drain on `SIGTERM` instead of stopping at once, give it a grace in `.brownie/settings.json`:

```json
{ "shutdownGraceMs": 120000 }
```

`SIGTERM` then drains exactly like `brownie drain --timeout 120000` (`worker.stopped signal=SIGTERM drained=true`). The default `0` keeps the immediate stop, a patched value applies to the next signal, and `SIGINT` always stops at once. Any signal during a drain is the emergency exit: it stops the worker at once, as without a grace, and a further signal after that ends the process without cleanup.

The supervisor has to wait longer than the grace, or it kills the worker in the middle of it with `SIGKILL`, which brownie cannot catch — no `worker.stopped`, and the session dies with the process. Give it at least 10 s on top of the grace, enough to kill what still runs and close the logs:

- **Docker Compose** — `stop_grace_period`, which `docker compose stop` and `docker stop` without `-t` use:

  ```yaml
  services:
    brownie:
      stop_grace_period: 130s
  ```

  An explicit `docker stop -t 10` (and a plain `docker stop` on a container started without a stop timeout) sends `SIGKILL` after 10 s, whatever the grace.

- **systemd** — `KillMode=mixed` and `TimeoutStopSec=130` in the `[Service]` section (the default timeout is 90 s). With the default `KillMode=control-group`, `systemctl stop` sends `SIGTERM` to every process of the service at once: the `claude` sessions die as the grace begins and the executor's task is marked failed. `mixed` signals brownie alone and keeps `SIGKILL` for whatever is left when the timeout runs out.

## Staying up to date

```bash
brownie update           # check npm and install the newest brownie
brownie update --check   # only report whether a newer version exists
```

`brownie update` detects how brownie was installed (npm/pnpm/yarn/bun) and runs the matching global install. A newly installed version takes effect on the next start.

A running worker also checks for updates in the background. Auto-update is controlled by `~/.brownie/config.json`:

```json
{ "autoUpdate": true }
```

With `autoUpdate` on (the default) the worker installs new versions in the background — the dashboard header and the `update.installed` log event announce it, and it applies after a restart. With it off, the worker only reports availability (`update.available`) so you can run `brownie update` yourself. Set `BROWNIE_DISABLE_AUTOUPDATER=1` to switch the background checks off entirely.

## Provisioning without a terminal

The first-run wizard needs a TTY, but headless machines have two clean paths:

- **Commit `.brownie/` to the project repo.** The wizard-written `.brownie/.gitignore` excludes only `data/` and `logs/`, so `settings.json` and `prompts/` travel with a clone. Cloning the repo on the server is the whole setup.
- **`brownie init`** — the wizard's non-interactive twin, made for cloud-init/Ansible:

```bash
brownie init --force \
  --settings settings.json \
  --monitor-prompt monitor.md \
  --executor-prompt executor.md \
  --context context.md
```

One invocation provisions the whole of `.brownie/`: the settings file, both prompts, the optional [context file](prompts.md) and the `.gitignore`. `--settings` is checked against the same schema the worker uses **before** anything is written, so a typo fails with the worker's own `Invalid configuration (.brownie/settings.json): …` on stderr and exit 1, leaving the project as it was; the file is then stored exactly as you wrote it, defaults left to brownie. `--context` accepts an empty file, which means "no context". Both flags are optional: without `--settings` the file is still created as `{}` when it is missing and left alone when it exists, and without `--context` no context file is written.

Without `--force` the command refuses and lists every file that is in the way; with it, every file the invocation writes is overwritten — settings and context included — so a server can re-run it on each boot. The two prompt flags still go together, but `--settings` and/or `--context` on their own are a complete invocation that updates the configuration and nothing else. In a terminal, `brownie init` with no flags simply opens the wizard.

## Authentication

The server needs a logged-in Claude Code. Two options:

- **OAuth token** — run `claude setup-token` on your own machine and put the result in the `CLAUDE_CODE_OAUTH_TOKEN` environment variable on the server.
- **API key** — set `ANTHROPIC_API_KEY` (Anthropic Console billing instead of your subscription).

Either goes into the systemd unit or the container environment — no browser login on the server.

Brownie checks the login at startup (`claude auth status --json`, no network call) and refuses to start when none is configured. `brownie version` (and the `authKind` field of `brownie status --json`) tells you which kind the worker started with — `apiKey`, `oauth`, `claude.ai` or `unknown`, in Claude Code's own order of precedence — so a unit file and a login left in the keychain can't quietly disagree. Credentials rejected at runtime — an expired token, a revoked key — park both agents in the `authBlocked` phase instead of burning retries: the task goes back to the queue, `brownie status` shows the reason, and `brownie resume` wakes them once the credentials are fixed.

## A droplet runbook (systemd)

One thing before anything else: **run brownie as a regular user, not root.** Agent sessions use `--permission-mode bypassPermissions`, which Claude Code refuses to run as root — and a fresh droplet logs you in as root.

```bash
adduser brownie
su - brownie

# Node 22 + the two CLIs
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash - && sudo apt-get install -y nodejs git
sudo npm install -g @anthropic-ai/claude-code@2.1.268 @brownie-labs/brownie

# the project brownie will work on (with .brownie/ committed, or run brownie init)
git clone git@github.com:you/your-project.git ~/your-project
```

The server also needs whatever the executor needs — the agents work on the real repo, so install the project's toolchain (test runner, `gh`, linters…) like you would for CI.

`/etc/systemd/system/brownie.service`:

```ini
[Unit]
Description=brownie worker
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=brownie
WorkingDirectory=/home/brownie/your-project
ExecStart=/usr/bin/brownie --log-format json
KillMode=mixed
Restart=on-failure
RestartSec=10
Environment=TZ=Europe/Warsaw
Environment=CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-…

[Install]
WantedBy=multi-user.target
```

Set `TZ` deliberately: `activeHours`/`activeDays` use local time, and droplets default to UTC — a `08:00-18:00` window means UTC hours until you say otherwise.

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now brownie
journalctl -u brownie -f                      # the pretty/json event stream
sudo -u brownie brownie status                # from the project directory
```

`systemctl stop` sends SIGTERM — with `KillMode=mixed` to brownie alone, which stops its own sessions, finishes writing logs, closes the socket, and exits cleanly (`worker.stopped signal=SIGTERM`). To let running sessions finish first, set `shutdownGraceMs` and a `TimeoutStopSec` above it ([Stopping the worker](#stopping-the-worker)).

## Docker

The repo ships a reference `Dockerfile` and `docker-compose.yml`. From your project directory:

```bash
export CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-…
export DOCKER_GID=$(getent group docker | cut -d: -f3)   # Linux — see "Docker access" below
docker compose up -d
docker compose logs -f                        # NDJSON event stream
docker compose exec brownie brownie status
```

The current directory is mounted as `/workspace`, so the project, its `.brownie/`, and all runtime state stay on the host. `docker ps` shows `healthy` only while the worker actually answers.

### Prebuilt images

Every release is also published to GHCR for `linux/amd64` and `linux/arm64`, so a server can pull instead of building:

```bash
docker pull ghcr.io/brownie-labs/brownie:latest           # the default image
docker pull ghcr.io/brownie-labs/brownie:latest-browser   # the same plus Chromium for Playwright MCP
```

| Variant    | Tags                                                             | What's inside                                                                                                                                                     |
| ---------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| default    | `<version>`, `<major>.<minor>`, `latest`                         | the `runtime` stage of the reference `Dockerfile` — Node, Python, the Docker CLI, the developer baseline (about 1.2 GB on disk)                                   |
| `-browser` | `<version>-browser`, `<major>.<minor>-browser`, `latest-browser` | the default image plus the full Chromium build (Chrome for Testing, run headless) with its system libraries and a pinned `@playwright/mcp` (about 1.9 GB on disk) |

`<version>` pins one release (`0.5.0`), `<major>.<minor>` follows its patch releases (`0.5`), `latest` follows every release. Both variants ship the Claude Code version brownie was released with (the `ai.brownie.claude-code.version` label says which) — to run a different one, build locally as described below.

To use a prebuilt image, replace the `build:` block in `docker-compose.yml` with `image:` — volumes, `DOCKER_GID`, and the environment stay as they are — and `docker compose pull && docker compose up -d` moves to a newer release:

```yaml
services:
  brownie:
    image: ghcr.io/brownie-labs/brownie:0.5
```

The `-browser` variant is for agents that need a browser through MCP. `@playwright/mcp` is installed globally as `playwright-mcp`, preconfigured for the bundled Chromium (`PLAYWRIGHT_MCP_BROWSER=chromium`, headless because there is no display), and starts without touching the network. Browsers live in `/opt/playwright` (`PLAYWRIGHT_BROWSERS_PATH`), owned by `brownie`, so a project's own Playwright can add other browsers or versions next to the bundled one. Turn it on in `.brownie/settings.json` — brownie writes the MCP configuration itself, and preflight refuses to start when the binary is missing, so the wrong image fails at boot instead of mid-session:

```json
{ "browser": true }
```

Agent sessions run with `--strict-mcp-config`, so a repository's `.mcp.json` and the user's own Claude Code MCP configuration are ignored: every server an agent gets is declared in `.brownie/settings.json` ([docs/configuration.md](configuration.md#mcp-servers)).

Both variants come from the same `Dockerfile`: the `runtime` stage is its default target, so a plain `docker build .` and `docker compose build` produce the default image, and `docker build --target browser .` produces the `-browser` variant locally.

### Pinned Claude Code version

The image installs exactly one Claude Code version (`CLAUDE_CODE_VERSION`, defaulting to the version brownie was tested with) and disables both auto-updaters, so every container runs the CLI you tested. Move deliberately:

```bash
CLAUDE_CODE_VERSION=2.1.300 docker compose build --pull && docker compose up -d
docker compose exec brownie brownie version   # the claude line confirms what the worker actually runs
```

### What the image gives your agent

The image ships **Node, Python 3 (with `pip`/`venv`), and the Docker CLI + the compose and buildx plugins**, plus a developer baseline: `git`, `gh`, `jq`, `ripgrep`, `make`, `build-essential`, `curl`. It deliberately does not bundle every language — for anything else (other runtimes, databases, services) the agent starts its own containers via Docker, so you don't rebuild the image to add a toolchain.

### Docker access

The host's Docker socket is mounted into the container so the agent can run `docker`. Because the agent runs as a non-root user, grant it access with `DOCKER_GID`:

- **Linux:** set it to the host's `docker` group id before `docker compose up`:

  ```bash
  export DOCKER_GID=$(getent group docker | cut -d: -f3)
  ```

  Leave it unset and the compose default (`999`) is used, which usually won't match — you'll get `permission denied` on the socket.

- **Docker Desktop on macOS:** the socket is bridged through the VM and usually works without setting `DOCKER_GID`. If `docker` inside the container reports `permission denied`, check the socket's group with `docker compose exec brownie ls -ln /var/run/docker.sock` and set `DOCKER_GID` to that number.

### Credentials

Configure `gh`, `ssh`, and `git` **once, inside the container** — they're stored in a named volume (`brownie-home`) and survive restart and rebuild:

```bash
docker compose exec brownie bash
gh auth login
ssh-keygen -t ed25519
git config --global user.name "…"
```

Everything under the home directory (`~/.config/gh`, `~/.ssh`, `~/.gitconfig`, …) persists, so `docker compose build && docker compose up -d` keeps your logins.

### Multiple agents, multiple accounts

To run several agents with different credentials, start each as its own compose project:

```bash
docker compose -p acme up -d
docker compose -p globex up -d
```

Each `-p <name>` gets its own home volume, so the `gh`/`ssh`/`git` identity in one never leaks into another.

## Costs, unattended

Everything from [Security & costs](../README.md#security--costs) applies double when nobody is watching: start with a conservative `intervalMinutes`, keep `activeHours` tight, and let `brownie status` (or the `cycle.finished` cost fields in the logs) tell you what a day of patrols actually costs before you shorten the leash.
