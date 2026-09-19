# Headless mode and deployment

Kikimora runs unattended on servers. Without a TTY (systemd, Docker, CI, a pipe) it skips the dashboard, starts the agents immediately and prints one log line per event to stdout. A second shell controls the running worker with `kikimora status`, `kikimora pause`, `kikimora resume` and the other [control commands](control.md).

## Headless mode

Headless mode turns on when stdin or stdout is not a TTY. `--headless` forces it in a terminal.

| Flag / env                    | Default  | Effect                                                                                            |
| ----------------------------- | -------- | ------------------------------------------------------------------------------------------------- |
| `--headless`                  | auto     | skip the dashboard even in a terminal; agents start                                               |
| `--log-format <pretty\|json>` | `pretty` | line format on stdout                                                                             |
| `KIKIMORA_LOG_FORMAT`         | unset    | fallback for `--log-format` when the flag is absent                                               |
| `--verbose`                   | off      | also log session text, tool calls and failed tool results                                         |
| `--paused`                    | off      | start both agents paused; `kikimora resume` starts them (the TUI starts agents paused regardless) |
| `KIKIMORA_START_PAUSED`       | unset    | fallback for `--paused` (`1` or `true`)                                                           |

- `pretty` is for `journalctl -f` and reading by eye.
- `json` is NDJSON, one JSON object per line, for log aggregators such as Loki, Datadog or CloudWatch.

In both formats, session transcripts go to `.kikimora/logs/`. Stdout carries lifecycle events, plus session content with `--verbose`.

### Log events

Each JSON line carries an envelope plus the event's own fields:

- `ts`: ISO 8601 timestamp;
- `level`: `info`, `warn` or `error`;
- `agent`: `monitor`, `executor` or `summarizer`, absent on worker-level events;
- `event`: the event name.

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
| `worker.started`                                              | `version`, `claudeVersion` (when readable), `nodeVersion`, `authKind`, `pid`, `projectDir`, `paused` (when started paused)              |
| `worker.draining`                                             | `reason` (`drain`, or `SIGTERM` under a shutdown grace), `timeoutMs` (when the drain has a deadline)                                    |
| `worker.stopped`                                              | `signal` (when stopped by SIGINT/SIGTERM), `drained` (exited through a drain), `forced` (a deadline or a signal cut the drain short)    |
| `control.changed`                                             | `state`: an agent moved between `running`, `pausing` and `paused`                                                                       |
| `update.available` / `update.installed`                       | `from`, `to`; `update.available` adds `installError` when a background install failed                                                   |
| `cycle.started` / `cycle.finished`                            | `cycle`; finished adds `ok`, `durationMs`, `costUsd`, `addedTasks`, `skippedDuplicates`, `error`, `sessionId`                           |
| `monitor.sleeping` / `monitor.offHours` / `monitor.limitWait` | `nextCycleAt` / `resumeAt`                                                                                                              |
| `task.started` / `task.finished`                              | `taskId`, `title`; finished adds `ok`, `durationMs`, `costUsd`, `numTurns`, `willRetry`, `attempt`, `maxAttempts`, `error`, `sessionId` |
| `task.retryScheduled`                                         | `taskId`, `resumeAt`                                                                                                                    |
| `executor.waiting` / `executor.limitWait`                     | none / `resumeAt`                                                                                                                       |
| `monitor.authBlocked` / `executor.authBlocked`                | `reason`: credentials were rejected; both agents stay paused until `kikimora resume`                                                    |
| `summary.started` / `summary.finished`                        | `taskId`; finished adds `ok`, `durationMs`, `costUsd`, `error`, `sessionId`                                                             |
| `session.init`                                                | `model`, `sessionId`, plus `taskId` (executor, summarizer) or `cycle` (monitor)                                                         |
| `session.stderr` / `session.procError` / `session.killed`     | `line` / `message` / `reason`                                                                                                           |
| `session.text` / `session.tool` / `session.toolError`         | only with `--verbose`                                                                                                                   |

Unset optional fields are omitted; they are not written as `null`. A `*.finished` event carries `sessionId` when Claude Code reported a result, which links the outcome to the session transcript below. A session killed by a timeout or a shutdown has no `sessionId` on its `*.finished` event.

## Session transcripts

Each session writes two files side by side under `.kikimora/logs/<agent>/<YYYY-MM-DD>/<HH-MM-SS>-<sessionId>.*`, named in the machine's local time:

- **`.log`**: the readable transcript the dashboard shows, one `[HH:MM:SS] …` line per event. The summarizer reads this file.
- **`.jsonl`**: the raw Claude Code stream, one JSON object per line. Each line is wrapped in an envelope, `{"ts":"2026-09-14T15:44:12.531Z","event":{…}}`, where `ts` is UTC and `event` is the object Claude Code emitted, unchanged. New message types are therefore kept as they arrive.
  - Token-by-token `stream_event` lines are left out; the assistant blocks already hold the full text.
  - A line the CLI printed that is not JSON is kept as `{"ts":…,"raw":"…"}`, cut to 500 characters with whitespace collapsed.

`kikimora sessions list` and `kikimora sessions show` find the files by session id ([the session index](control.md#the-session-index)). Kikimora does not delete them. On a long-lived server, prune them yourself:

```bash
find ~/your-project/.kikimora/logs -type f -mtime +30 -delete
```

## Controlling a running worker

The worker creates a local control socket at startup; it needs no configuration. From a shell in the same project directory:

```bash
kikimora status           # agent states and phases, task counts, cost
kikimora status --json    # the same as JSON
kikimora version          # kikimora, Claude Code and Node versions, auth kind, pid
kikimora pause            # both agents finish their session, then stop
kikimora pause monitor    # one agent only
kikimora resume           # resume paused agents
kikimora drain            # finish the current sessions, then exit
kikimora sessions list    # what ran, when, at what cost
```

- `kikimora status --json` works as a health check: it exits `1` when no worker is running.
- Its document starts with the worker's identity (kikimora, Claude Code and Node versions, `authKind`, pid, start time), which `kikimora version` prints alone.
- The socket also blocks double starts: a second `kikimora` in the same project exits with `kikimora is already running in this project (pid …)`.

[docs/control.md](control.md) covers editing tasks, settings, prompts and memory over the socket, reaching it from outside a container, and the wire protocol.

## Stopping the worker

By default `SIGINT` (Ctrl+C) and `SIGTERM` (`systemctl stop`, `docker stop`) stop the worker at once:

1. A running session is killed (`session.killed reason=abort`).
2. Its task stays `in_progress` and returns to the queue on the next start.
3. The worker closes its logs and socket and logs `worker.stopped signal=…`.

A drain stops the worker after the running work finishes. `kikimora drain`, `/drain` and the `drain` control command start one:

- Both agents are paused, and the worker exits `0` once both are idle, logging `worker.stopped drained=true`.
- A running session finishes. For the executor, that includes the memory summary after it.
- No new work starts. A monitor cycle about to begin is skipped. A task the executor has claimed but not started goes back to the queue with its attempt given back.
- `--timeout <ms>` (at most 24 hours) sets a deadline after which what still runs is killed (`forced=true`).
- The command returns at once. A repeated request returns the first acknowledgement and does not move the deadline.
- `resume` is refused until the worker exits, and `kikimora status` shows the drain.

To drain on `SIGTERM`, set a grace in `.kikimora/settings.json`:

```json
{ "shutdownGraceMs": 120000 }
```

`SIGTERM` then drains like `kikimora drain --timeout 120000` and logs `worker.stopped signal=SIGTERM drained=true`.

- The default `0` keeps the immediate stop.
- A patched value applies to the next signal.
- `SIGINT` stops at once regardless of the grace.
- A signal during a drain stops the worker at once, as without a grace. A further signal after that ends the process without cleanup.

The supervisor's stop timeout must be longer than the grace. Otherwise it sends `SIGKILL` in the middle of the drain. Kikimora cannot catch `SIGKILL`: no `worker.stopped` is logged, and the session dies with the process. Give the supervisor at least 10 s on top of the grace, to kill what still runs and close the logs:

- **Docker Compose**: `stop_grace_period`, which `docker compose stop` and `docker stop` without `-t` use:

  ```yaml
  services:
    kikimora:
      stop_grace_period: 130s
  ```

  An explicit `docker stop -t 10` sends `SIGKILL` after 10 s regardless of the grace. So does a plain `docker stop` on a container started without a stop timeout.

- **systemd**: `KillMode=mixed` and `TimeoutStopSec=130` in the `[Service]` section; the default timeout is 90 s. With the default `KillMode=control-group`, `systemctl stop` sends `SIGTERM` to every process of the service at once. The `claude` sessions then die as the grace begins, and the executor's task is marked failed. `mixed` sends `SIGTERM` to kikimora alone and keeps `SIGKILL` for what is left when the timeout runs out.

## Staying up to date

```bash
kikimora update           # check npm and install the newest kikimora
kikimora update --check   # only report whether a newer version exists
```

`kikimora update` detects the package manager that installed kikimora (npm, pnpm, yarn or bun) and runs its global install. A newly installed version takes effect on the next start.

A running worker also checks the npm registry at startup and every 30 minutes. It skips the checks when it cannot detect the package manager, for example when run from a clone. `~/.kikimora/config.json` controls what happens with a new version:

```json
{ "autoUpdate": true }
```

- With `autoUpdate` on (the default), the worker installs the new version in the background. The dashboard header and the `update.installed` log event report it, and it applies after a restart.
- With `autoUpdate` off, the worker only reports the new version (`update.available`), and you run `kikimora update` yourself.
- `KIKIMORA_DISABLE_AUTOUPDATER=1` (or `true`) turns the background checks off.

## Provisioning without a terminal

The first-run wizard needs a TTY. A headless machine has two options:

- **Commit `.kikimora/` to the project repository.** The `.kikimora/.gitignore` written at setup excludes only `data/` and `logs/`, so `settings.json` and `prompts/` come with a clone. Cloning the repository on the server completes the setup.
- **Run `kikimora init`**, the wizard's non-interactive counterpart, for cloud-init or Ansible:

```bash
kikimora init --force \
  --settings settings.json \
  --monitor-prompt monitor.md \
  --executor-prompt executor.md \
  --context context.md
```

One invocation writes the whole of `.kikimora/`: the settings file, both prompts, the optional [context file](prompts.md) and the `.gitignore`.

- `--settings` is validated against the worker's schema **before** anything is written. A typo fails with the worker's own `Invalid configuration (.kikimora/settings.json): …` on stderr and exit code 1, and the project is left unchanged.
- The settings document is stored with the keys and values you wrote, re-serialized with two-space indentation; defaults are not filled in.
- `--context` accepts an empty file, which means no context.
- Without `--settings`, the settings file is created as `{}` when missing and left unchanged when present. Without `--context`, no context file is written.
- Without `--force`, the command refuses and lists each file that already exists. With `--force`, it overwrites every file the invocation writes, settings and context included, so a server can re-run it on each boot.
- `--monitor-prompt` and `--executor-prompt` must be given together. `--settings` or `--context` alone is a complete invocation that updates the configuration and nothing else.
- In a terminal, `kikimora init` with no flags opens the wizard.

## Authentication

The server needs a logged-in Claude Code. Two options:

- **OAuth token**: run `claude setup-token` on your own machine and put the result in the `CLAUDE_CODE_OAUTH_TOKEN` environment variable on the server.
- **API key**: set `ANTHROPIC_API_KEY`. Usage is then billed to the Anthropic Console account, not to a subscription.

Put either in the systemd unit or the container environment; no browser login on the server is needed.

At startup kikimora runs `claude auth status --json` and refuses to start when no login is configured. `kikimora version` and the `authKind` field of `kikimora status --json` show which kind the worker started with: `apiKey`, `oauth`, `claude.ai` or `unknown`, in Claude Code's order of precedence. This shows whether the credential in the unit file or a login stored in the keychain is in use.

Credentials rejected at runtime, such as an expired token or a revoked key, put both agents in the `authBlocked` phase:

- the task returns to the queue without using an attempt;
- `kikimora status` shows the reason;
- `kikimora resume` restarts the agents once the credentials are fixed.

## A droplet runbook (systemd)

Run kikimora as a regular user, not root. Agent sessions use `--permission-mode bypassPermissions`, which Claude Code refuses to run as root, and a new DigitalOcean droplet logs you in as root.

```bash
adduser kikimora
su - kikimora

# Node 22 + the two CLIs
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash - && sudo apt-get install -y nodejs git
sudo npm install -g @anthropic-ai/claude-code@2.1.268 @kikimoradev/kikimora

# the project kikimora will work on (with .kikimora/ committed, or run kikimora init)
git clone git@github.com:you/your-project.git ~/your-project
```

The agents work on the real repository, so the server also needs the project's toolchain (test runner, `gh`, linters), as a CI runner would.

`/etc/systemd/system/kikimora.service`:

```ini
[Unit]
Description=kikimora worker
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=kikimora
WorkingDirectory=/home/kikimora/your-project
ExecStart=/usr/bin/kikimora --log-format json
KillMode=mixed
Restart=on-failure
RestartSec=10
Environment=TZ=Europe/Warsaw
Environment=CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-…

[Install]
WantedBy=multi-user.target
```

Set `TZ`: `activeHours` and `activeDays` use local time, and droplets default to UTC. Without `TZ`, a `08:00-18:00` window means UTC hours.

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now kikimora
journalctl -u kikimora -f                      # the pretty/json event stream
sudo -u kikimora kikimora status                # from the project directory
```

`systemctl stop` sends SIGTERM, with `KillMode=mixed` to kikimora alone. Kikimora stops its own sessions, finishes writing logs, closes the socket and exits (`worker.stopped signal=SIGTERM`). To let running sessions finish first, set `shutdownGraceMs` and a `TimeoutStopSec` above it ([Stopping the worker](#stopping-the-worker)).

## Docker

The repository ships a reference `Dockerfile` and `docker-compose.yml`. From your project directory:

```bash
export CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-…
export DOCKER_GID=$(getent group docker | cut -d: -f3)   # Linux, see "Docker access" below
docker compose up -d
docker compose logs -f                        # NDJSON event stream
docker compose exec kikimora kikimora status
```

The current directory is mounted as `/workspace`, so the project, its `.kikimora/` and the runtime state stay on the host. The image's health check runs `kikimora status --json`, so `docker ps` shows `healthy` only while the worker answers on its socket.

### Prebuilt images

Each release is also published to GHCR for `linux/amd64` and `linux/arm64`, so a server can pull an image:

```bash
docker pull ghcr.io/kikimoradev/kikimora:latest           # the default image
docker pull ghcr.io/kikimoradev/kikimora:latest-browser   # the same plus Chromium for Playwright MCP
```

| Variant    | Tags                                                             | Contents                                                                                                                                   |
| ---------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| default    | `<version>`, `<major>.<minor>`, `latest`                         | the `runtime` stage of the reference `Dockerfile`: Node, Python, the Docker CLI, the developer baseline                                    |
| `-browser` | `<version>-browser`, `<major>.<minor>-browser`, `latest-browser` | the default image plus the full Chromium build (Chrome for Testing, run headless) with its system libraries and a pinned `@playwright/mcp` |

When the images were introduced in 0.5.0, the default image measured about 1.2 GB on disk and the `-browser` image about 1.9 GB.

- `<version>` pins one release (`0.5.0`).
- `<major>.<minor>` follows its patch releases (`0.5`).
- `latest` follows each release.

Both variants ship the Claude Code version kikimora was released with; the `dev.kikimora.claude-code.version` label names it. To run a different version, build locally as described below.

To use a prebuilt image, replace the `build:` block in `docker-compose.yml` with `image:`. Volumes, `DOCKER_GID` and the environment stay as they are. `docker compose pull && docker compose up -d` then moves to a newer release:

```yaml
services:
  kikimora:
    image: ghcr.io/kikimoradev/kikimora:0.5
```

The `-browser` variant is for agents that use a browser through MCP:

- `@playwright/mcp` is installed globally as `playwright-mcp` and preconfigured for the bundled Chromium (`PLAYWRIGHT_MCP_BROWSER=chromium`). Chromium runs headless because the container has no display.
- Chromium is installed at image build time, so `playwright-mcp` starts without downloading a browser.
- Browsers live in `/opt/playwright` (`PLAYWRIGHT_BROWSERS_PATH`), owned by `kikimora`, so a project's own Playwright can add other browsers or versions next to the bundled one.

Turn it on in `.kikimora/settings.json`. Kikimora writes the MCP configuration itself. Preflight refuses to start when the binary is missing, so the wrong image fails at startup and not in the middle of a session:

```json
{ "browser": true }
```

Agent sessions run with `--strict-mcp-config`, so a repository's `.mcp.json` and the user's own Claude Code MCP configuration are ignored. The servers an agent gets are declared in `.kikimora/settings.json` ([MCP servers](configuration.md#mcp-servers)).

Both variants come from the same `Dockerfile`. `runtime` is its default target, so `docker build .` and `docker compose build` produce the default image. `docker build --target browser .` produces the `-browser` variant locally.

### Pinned Claude Code version

The image installs one Claude Code version (`CLAUDE_CODE_VERSION`, default `2.1.268`) and disables both auto-updaters (`DISABLE_AUTOUPDATER=1`, `KIKIMORA_DISABLE_AUTOUPDATER=1`). A container runs the CLI version it was built with. To change it:

```bash
CLAUDE_CODE_VERSION=2.1.300 docker compose build --pull && docker compose up -d
docker compose exec kikimora kikimora version   # the claude line shows the version the worker runs
```

### What the image contains

- Node, Python 3 with `pip` and `venv`, and the Docker CLI with the compose and buildx plugins;
- a developer baseline: `git`, `gh`, `jq`, `ripgrep`, `make`, `build-essential`, `curl`.

For other runtimes, databases or services, the agent starts its own containers through Docker. Adding a toolchain does not require rebuilding the image.

### Docker access

The host's Docker socket is mounted into the container so the agent can run `docker`. The agent runs as the non-root user `kikimora`; grant it access with `DOCKER_GID`:

- **Linux:** set it to the host's `docker` group id before `docker compose up`:

  ```bash
  export DOCKER_GID=$(getent group docker | cut -d: -f3)
  ```

  Unset, it falls back to the compose default `999`. If that does not match the host's group, `docker` in the container fails with `permission denied` on the socket.

- **Docker Desktop on macOS:** the socket is bridged through the VM and usually works without `DOCKER_GID`. If `docker` in the container reports `permission denied`, check the socket's group with `docker compose exec kikimora ls -ln /var/run/docker.sock` and set `DOCKER_GID` to that number.

### Credentials

Configure `gh`, `ssh` and `git` **once, inside the container**. They are stored in the named volume `kikimora-home` and persist across restarts and rebuilds:

```bash
docker compose exec kikimora bash
gh auth login
ssh-keygen -t ed25519
git config --global user.name "…"
```

The home directory (`~/.config/gh`, `~/.ssh`, `~/.gitconfig` and the rest) is on that volume, so `docker compose build && docker compose up -d` keeps your logins.

### Multiple agents, multiple accounts

To run several workers with different credentials, start each as its own compose project:

```bash
docker compose -p acme up -d
docker compose -p globex up -d
```

Each `-p <name>` gets its own home volume, so the `gh`, `ssh` and `git` identities stay separate.

## Costs of unattended runs

[Security and costs](../README.md#security-and-costs) applies to servers as well, where no one watches the dashboard. Start with a conservative `intervalMinutes` and narrow `activeHours`. Use `kikimora status` or the `costUsd` fields of `cycle.finished` and `task.finished` to measure what a day of patrols costs before you shorten the interval.
