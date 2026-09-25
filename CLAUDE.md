# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

`kikimora` is a CLI that runs Claude Code sessions in three roles: the **monitor** reports tasks, the **executor** completes them, and the **summarizer** writes findings to long-term memory.

- Stack: Node `^22.16.0 || >=24.0.0`, pnpm, ESM, TypeScript.
- npm package `@kikimoradev/kikimora`, binary `kikimora`.
- Code, messages and commits are in English.

Per-project state lives in `<cwd>/.kikimora/`, like Claude Code's `.claude/`:

- `settings.json`: configuration;
- `prompts/*.prompt.md`: project prompts, plus the optional `prompts/context.md`;
- `data/`: `tasks.json`, `memory.db`, `mcp/`, `playwright/`;
- `logs/`: session logs;
- `.gitignore`: ignores `data/` and `logs/`.

System prompts ship with the package (`<packageRoot>/prompts/*.system.md`). Agent sessions run in the project directory itself (`cwd`), without a sandbox. `src/paths.ts` defines the full path layout (`projectPaths`, `packagePromptsDir`, `systemPromptFiles`).

## Commands

```bash
pnpm dev                  # start with watch (tsx)
pnpm start                # start without watch (first run opens the two-prompt wizard)
pnpm check                # typecheck + lint + format:check + test (run before committing)
pnpm typecheck
pnpm lint / pnpm lint:fix
pnpm format / pnpm format:check
pnpm test                 # vitest run
pnpm test test/executor.test.ts        # a single test file
pnpm vitest run -t "test name"         # a single test by name
pnpm test:coverage        # coverage thresholds enforced in vitest.config.ts
pnpm build                # tsup -> dist/
```

## Architecture

### Entry point and setup

`src/index.ts` dispatches manually on the first `argv` token:

- `kikimora mcp …` goes to `mcpCommand` (`src/mcp-command.ts`), a citty group whose only subcommand, `serve`, is the memory MCP server.
- `kikimora init` goes to `initCommand` (`src/init-command.ts`), non-interactive scaffolding through `src/scaffold.ts`, which the wizard shares. It reads every input and validates `--settings` with `parseSettings` before writing the first file. `--force` covers every file the call writes. Without flags in a TTY it opens the wizard.
- `kikimora status|version|pause|resume|drain` go to `src/control-commands.ts`, and `tasks|settings|prompt|context|memory|sessions` to the `*-command.ts` groups. All of them are clients of the control socket.
- `kikimora update` goes to `src/update-command.ts`.
- Everything else goes to `mainCommand` (`src/main.ts`, citty). Flags: `--headless`, `--log-format pretty|json` (env fallback `KIKIMORA_LOG_FORMAT`), `--verbose`, `--paused` (env fallback `KIKIMORA_START_PAUSED`).

The manual dispatch exists because citty treats the first positional raw arg as a subcommand name and runs the parent `run` after a subcommand.

`runKikimora` in `main.ts` runs the first-run wizard (`runConfigure` in `configure.tsx`) only when setup is missing and only in a TTY. `isConfigured` requires `.kikimora/settings.json` and both project prompt files. It then starts the worker.

The wizard is a small standalone Ink app: `src/ui/wizard.tsx` plus the multi-line `src/ui/prompt-editor.tsx`. It runs in its own Ink instance, unmounted before the dashboard mounts. It asks **only** for the two project prompts: Enter inserts a newline, Ctrl+D submits, Esc cancels, pasted markdown is normalized. It writes `settings.json` as `{}` (the zod schema supplies the defaults) and does not overwrite an existing settings file.

Kikimora operates on `process.cwd()`; no flag points it elsewhere. Test code injects paths through the `ConfigDirs` object.

### The two loops

`src/start.ts` (`startWorker`) wires the worker. After preflight (`preflight.ts`) and loading the configuration, it runs **two loops in parallel** (`Promise.all`). They communicate only through shared objects.

- **`runMonitorLoop` (`monitor.ts`)**: every `intervalMs`, and only inside the window from `active-hours.ts`, it runs a Claude session with an enforced task-report JSON schema (`report.ts`). It adds the tasks to the `TaskStore`, which deduplicates by `id`, and wakes the executor through the `Waker`.
- **`runExecutorLoop` (`executor.ts`)**: pulls `pending` tasks from the `TaskStore`, appends a `## Task to complete` section (id, title, description) to the prompt, and runs a session with memory access over MCP. `isTransientFailure` treats a timeout, or an `is_error` result whose text matches a known pattern, as transient. Transient failures are retried up to `maxTaskAttempts` after `retryDelayMs`; other failures mark the task `failed`. After a success or an ordinary failure it runs the `SessionSummarizer`.

### Gates

Both loops and the summarizer share a **`UsageLimitGate` (`usage-limit.ts`)** that handles Claude Code usage limits (5-hour and weekly).

- `detectUsageLimit` recognizes a limit hit in a `SessionResult`. The structural signal is the `rate_limit_event` stream event with `rate_limit_info.status === "rejected"`, which `stream.ts` captures into `SessionResult.rateLimit` (`resetsAt` in unix seconds). A text pattern is the fallback for older CLI formats.
- On a hit the gate blocks both loops until `resetsAt` plus a 60 s buffer, or for 15 minutes when the reset time is unknown.
- Each loop checks `gate.msRemaining()` at the top of its iteration and shows a `limitWait` phase with a countdown.
- The executor returns the task with `TaskStore.release`: status back to `pending`, the attempt given back. Limit hits do not consume `maxTaskAttempts`. The summarizer is skipped.

The **`AuthGate` (`auth-gate.ts`)** handles rejected credentials.

- `detectAuthFailure` recognizes `api_retry` stream events with `error_status` 401/403, captured by `stream.ts` into `SessionResult.apiError`, plus a text fallback.
- It must run **before** `detectUsageLimit` and `isTransientFailure`, because their `/API Error/` pattern would otherwise retry a 401.
- The gate has no timeout. `engage` pauses both `AgentController`s (callback wired in `start.ts`). The loops report the `authBlocked` phase once and park in `controller.gate()`. A `resume` clears the gate through the controllers' `onChange`.

Both gates travel together as `LoopGates` (`gates.ts`). Preflight also runs `claude --version` and `claude auth status --json` once; both results reach `start.ts` as `PreflightResult.claude`. Preflight refuses to start without a login; with an older CLI that has no `auth status`, it logs a warning and continues.

### Pause and resume

Each loop gets an **`AgentController` (`control.ts`)**, the pause/resume primitive behind `/pause` and `/start`.

- `pause()` sets the state to `pausing`; the running session finishes.
- The loop's `gate(signal)` call at the top of each iteration flips the state to `paused` and blocks until `resume()` or abort.
- `controller.sleep()` wraps `sleep` from `timing.ts`, so a pause request cuts a sleep short.
- Between the gate and the session each loop prepares its inputs (prompt files, context, MCP config), then checks again. An abort breaks the loop. A pause means no session starts: the monitor skips the cycle before announcing it, and the executor hands its claimed task back with `TaskStore.release` (no reason, so the last error stays and the attempt is returned).
- Abort takes precedence and resolves every wait. The convention matches `Waker` and `sleep`: resolve, do not reject.

In an interactive terminal `start.ts` constructs both controllers as `paused`, so agents run only after `/start`. Without a TTY no one can type commands, so they start `running` unless `--paused` or `KIKIMORA_START_PAUSED=1` asks for a paused start.

### Drain and signals

**`DrainController` (`drain.ts`)** turns the pause primitive into a graceful exit for `kikimora drain`, the `drain` socket command and `/drain`.

- `request(reason, timeoutMs)` records a `DrainSnapshot`, announces it (`worker.draining`, `WorkerStatusStore.drainRequested`), pauses both controllers and arms an unref'd deadline.
- `start.ts` calls `noteSettled` from both controllers' `onChange`. When both are `paused`, both loops are parked in `gate()`, so no session and no summary is in flight, and the controller aborts.
- The deadline aborts in any case and kills what still runs.
- A second `request` returns the first snapshot and does not move the deadline.
- `resume` is refused while draining (socket and `/start`), because a resumed loop would pass its gate once more.
- The worker's single `AbortSignal` is `AbortSignal.any` of the signal handler's signal and the drain's.
- `worker.stopped` reports `drained`, and `forced` unless the drain `settled`.

**`abortOnSignals` (`shutdown.ts`)** asks a `SignalPolicy` what a signal means.

- A first signal with `graceMsFor(signal) > 0` calls `onDrain`.
- Any other signal, including every signal after a drain began, calls `onAbort` and aborts.
- After the abort the listeners detach, so a further signal gets Node's default and ends the process.

`start.ts` grants `SIGTERM` a grace of `config.shutdownGraceMs` unless a drain is already running. The value is read at signal time, so a patched setting applies to the next signal. `onDrain` requests a drain with that deadline.

### Components

- **`runner.ts`**: the only place that spawns the `claude` process. Arguments: `-p --model --effort --system-prompt --output-format stream-json --verbose --permission-mode bypassPermissions`, `--include-partial-messages` when `streamPartial` is on, `--mcp-config <path> --strict-mcp-config`, and `--json-schema` for the monitor and summarizer. The prompt goes in over stdin. On timeout or abort it sends SIGTERM, then SIGKILL after 5 s. `stream.ts` parses stream-json into `SessionEvent`s and builds a `SessionSummary`.
- **`tasks.ts` (`TaskStore`)**: a JSON task store (`.kikimora/data/tasks.json`) with atomic writes (tmp + rename). Operations are serialized through a promise chain. On startup it resets stalled `in_progress` tasks to `pending`.
- **`src/memory/`**: long-term memory.
  - `store.ts`: SQLite via `node:sqlite` with FTS5.
  - `summarizer.ts`: a session on the `summarizer.model` (default `sonnet`) that reads the executor session log and writes the result to the database.
  - `mcp.ts`: a stdio MCP server with the `memory_search` and `memory_get` tools. An MCP config points back at the same binary: `kikimora mcp serve --db ...`.
- **`mcp-config.ts`**: the MCP configuration handed to every session. `composeMcpConfig` builds the document in this order:
  1. `memory`, executor only (`memoryDbPath` is `null` for the monitor; the summarizer gets an empty document);
  2. `playwright` when `browser: true` (`playwright-mcp`, headless, isolated profile, `--output-dir .kikimora/data/playwright`; preflight checks that the binary is on `PATH`);
  3. the servers the agent's `mcpServers` list names, copied verbatim from `settings.mcpServers`.

  `writeMcpConfig` writes it atomically to `.kikimora/data/mcp/<agent>.json` and returns the path. Both loops and the summarizer call it at the top of an iteration, the same point where they re-read the prompt files, so a settings change applies to the next session. `runner.ts` passes `--mcp-config <path> --strict-mcp-config` on every session, even for an empty document. An agent sees exactly the servers in `settings.json`: a repository's `.mcp.json` (untrusted input) and the user's own Claude Code configuration are ignored. `settingsSchema` rejects the reserved server names (`memory`, `playwright`) and references to undeclared servers.

- **`src/headless/`**: headless mode, active without a TTY or with `--headless`. `start.ts` then skips `mountDashboard` and tees line logs to stdout.
  - `tee.ts` (`teeReporter`) fans out **every** reporter method into `reporters.ts`; `teeSession` tees only the `session` sink.
  - `reporters.ts` implements `MonitorReporter`, `ExecutorReporter` and `SummaryReporter`, mapping lifecycle callbacks to `HeadlessLogEvent`s (`events.ts`).
  - `format.ts` renders events as pretty lines or NDJSON: a stable envelope (`ts`, `level`, `agent`, `event`) plus fields, with undefined fields omitted. `docs/deployment.md` documents the schema.
  - `sink.ts` writes to stdout; tests inject `StartWorkerOptions.stdout`.
  - Session `text`, `toolUse` and `toolResult` events are logged only with `--verbose`.
  - The `WorkerStatusStore` keeps running headless because it feeds the control socket.
- **`control-server.ts`, `control-client.ts`, `control-protocol.ts`, `control-commands.ts`**: the control socket.
  - Transport: a unix domain socket (a named pipe on win32) at `controlSocketPath(projectDir)` in `paths.ts`. The path is tmpdir + uid + the first 16 hex characters of the sha256 of the resolved project path. It sits outside `.kikimora/` to stay under the 104-byte `sun_path` limit. `KIKIMORA_CONTROL_SOCKET` overrides it and is validated in the same function, so the worker and the CLI agree.
  - `start.ts` starts the server in both TUI and headless mode. Startup probes the socket first: a live listener means another instance, and the worker exits 1 with "already running (pid …)"; a stale file is unlinked.
  - Protocol: one newline-delimited JSON request per connection, validated by the zod discriminated union `controlRequestSchema`, answered with `{ok:true,data}` or `{ok:false,error}`, typed per command (`ControlResponseData`).
  - Commands: `status`, `version`, `pause`, `resume`, `drain`, plus mirrors of the TUI: `settings.get|patch`, `tasks.list|add|retry|cancel`, `memory.search|recent`, `prompt.get|set`, `context.get|set`, `sessions.list|get`. The server receives the same store instances as the dashboard through the neutral interfaces in `worker-controls.ts`. Do not import `src/ui/` there.
  - `version` answers the static `WorkerIdentity` (`worker-identity.ts`): kikimora, Claude Code and Node versions, pid, `startedAt`, `projectDir`, and `authKind`. `authKind` resolves `ANTHROPIC_API_KEY`, then `CLAUDE_CODE_OAUTH_TOKEN`, then the preflight `claude auth status` report, matching Claude Code's own precedence. `start.ts` builds the identity once; it is spread into the `status` document and logged in the headless `worker.started` event.
  - Protocol fields may only be added. Do not rename them or set them to `null`; omit optional ones.
  - The CLI side goes through `requestControl` in `control-commands.ts` and exits 1 when no worker answers or the request is rejected. An `Unrecognized control request.` from an older worker is reported as a version skew with a restart hint.
- **`src/sessions/`**: `SessionIndex`, the durable index of the sessions kikimora has run.
  - It shares `MemoryStore`'s single writable `node:sqlite` handle (`memory.connection`) and owns the `sessions` table in `.kikimora/data/memory.db`.
  - `runner.ts` feeds it through the narrow `SessionRecorder` port: `started` on the `init` event, the only point where the session id is certain (`result` may never arrive), and `finished` when the process ends.
  - `start.ts` builds one recorder per agent. It turns `SessionLog.pathsFor(sessionId)` into paths relative to `.kikimora/`, so the index stays valid on both sides of a bind mount.
  - `sessions.list`, `sessions.get` and `kikimora sessions` read it. None of them returns transcript content.
- **`status.ts` and `src/ui/`**: `WorkerStatusStore` collects events from both loops (phases, tails, control state, recent outcomes) and feeds the TUI (Ink/React).
  - `app.tsx` holds the **single `useInput` hook per Ink instance**, the view router and the input state. Do not add a second `useInput` in the dashboard: Ink delivers each keypress to every active subscriber. The wizard is a separate, sequential Ink instance with its own `useInput` in `prompt-editor.tsx`.
  - `commands.ts` is the pure slash-command registry (`COMMANDS`, `parseCommand`, `commandMenu`, `argumentGhost`, `dispatchCommand`) and the single source for `/help` and tab completion. Each command has a `group` for `/help` and an optional `complete(argIndex)` for value completion. Handlers talk to narrow structural interfaces (`TaskControls`, `MemoryReader`, `SettingsController`), not to concrete stores.
  - Views live in `src/ui/views/`; presentational pieces in `command-input.tsx`, `agent-panel.tsx`, `task-table.tsx`, `status-bar.tsx` and `panel.tsx`. `Panel` draws a rounded frame with `title`/`aside` in the top border and `footer`/`footerAside` in the bottom one; every framed region uses it.
  - `theme.ts` holds colors, single-width `glyphs` (no emoji) and the spinner frames. The interface is black and white and color marks states only (`ok` green, `warn` yellow, `error` red, `info` cyan for work in progress, `muted` gray), applied to the glyph or number, not to the whole line. Hierarchy comes from three weights: bold for titles and names, plain for content, `dimColor` for metadata and hints.
  - `format.ts` turns phases and outcomes into structured `StatusLine`/`OutcomeLine` values (`glyph`, `tone`, `text`, `aside`/`meta`, `busy`); components decide the layout. Durations and costs come from `src/units.ts`, which headless does not use.
  - `layout.ts` (`computeLayout`) is the only place that computes the content height and the narrow breakpoint. `scroll.ts` windows every list view; `line-editing.ts` holds the readline operations shared by the command input and the editor.
  - `Spinner` instances share one ticker; `AppProps.animate: false` (used in tests) holds the first frame.
  - Notices render in the status bar, not on their own line, so the layout keeps its height; while an editor is open, an error notice shows in the editor's hint row.
  - The dashboard mounts only in an interactive terminal. Without a TTY, or with `--headless`, `start.ts` does not call `mountDashboard` and the headless line logger takes over.
  - `/exit` and Ctrl+C both call `process.kill(pid, "SIGINT")`, which reaches `abortOnSignals`. This is the only immediate shutdown path. `/drain` goes through the `DrainController`.
  - Session events are also tee'd (`teeSession`) into persistent `SessionLog` files: `.kikimora/logs/<agent>/<day>/<HH-MM-SS>-<sessionId>.log` for people, and a `.jsonl` of the same name for machines.
- **`settings-controller.ts` and `settings-file.ts`**: runtime configuration changes behind `/model`, `/effort`, `/interval`, `/hours`, `/days` and the `/config` view.
  - `patchSettings` (`settings-file.ts`) applies a sparse patch to the raw `settings.json`, validates the result with `settingsSchema` **before** writing (tmp + rename), and returns the parsed `Settings`.
  - `createSettingsController` (built in `start.ts`, passed to the TUI) validates the value, persists it through `patchSettings`, then calls `applySettings(config, settings)`.
  - `applySettings` **mutates the shared `WorkerConfig` leaves in place**. Do not reassign `config.monitor`, `config.executor` or `config.summarizer`: `monitor.ts` and `executor.ts` hold destructured references to those objects and read `model`, `effort`, `intervalMs` and `schedule` on each iteration. This is how a change reaches the next session without a restart. `promptPath` changes only on restart.
  - `/prompt <monitor|executor>` edits a project prompt in place. It reads the file through `prompt-files.ts` (`PromptFileAccess`, atomic tmp + rename writes) and opens `PromptEditor` as a modal view. While the editor is mounted, the dashboard's main `useInput` is deactivated (`isActive`), so the editor is the only key subscriber. Saving needs no live apply, because both loops re-read the prompt files on each iteration.
- **`paths.ts`**: the single source of truth for the filesystem layout. `projectPaths(projectDir)` derives every `.kikimora/` path. `packageRootDir` and `packagePromptsDir` locate the installed package through `import.meta.url`, which works both under tsx in dev and in the tsup bundle `dist/index.js`.
- **`config.ts`**: all configuration in `.kikimora/settings.json`, nested JSON validated with zod (`settingsSchema`, `.strict()` at every level, so an unknown key fails with a named path).
  - A new configuration option needs a key in `settingsSchema`, a mapping in `loadWorkerConfig`, a leaf assignment in `applySettings` (`settings-controller.ts`), and usually a slash command in `src/ui/commands.ts`.
  - `ConfigDirs { projectDir?, systemPromptsDir? }` exists for test injection; production code passes `{}`.

## Prompts

Agent prompts live in markdown files. **Do not put prompt content in code constants.**

- **System prompts** (`prompts/*.system.md`) ship with the npm package (listed in `package.json` `files`) and resolve from the package root, not from the user's project. They are in English and do not impose an output language.
- **Project prompts** (`.kikimora/prompts/monitor.prompt.md`, `.kikimora/prompts/executor.prompt.md`) are written into the user's project by the wizard or `kikimora init`. They carry the business context: Redmine IDs, repositories, URLs.

## Tests

- Vitest. Tests in `test/` mirror the structure of `src/`.
- `vitest.config.ts` enforces coverage thresholds: statements 92%, branches 75%, functions 90%, lines 94%. New code needs tests.
- Claude sessions are tested without a real CLI. `test/fixtures/claude` is a fake binary driven by `FAKE_CLAUDE_*` variables (mode, result text, argument dump); a `_<MODEL>` suffix gives per-model variants.
- Helper factories for configs and reporters are in `test/helpers.ts`.

## Documentation

- Each user-facing change gets an entry in `CHANGELOG.md` under `## [Unreleased]`. Format: Keep a Changelog (`Added`, `Changed`, `Fixed`), one dense bullet per change, written for the user and not as a description of the diff.
- Each doc owns one topic and stays terse:
  - `README.md`: overview and command tables;
  - `docs/configuration.md`: settings;
  - `docs/prompts.md`: prompts;
  - `docs/deployment.md`: headless mode and servers;
  - `docs/control.md`: the control socket (CLI, containers, wire protocol).
- A feature that touches several topics gets one sentence with a link in each doc; do not copy the explanation. Prefer a short paragraph or a table row to a new section, and a new file to a section that mixes audiences.

## Conventions

- ESLint: `strictTypeChecked` + `stylisticTypeChecked`. `tsconfig` sets `exactOptionalPropertyTypes`, hence explicit `| undefined` in interfaces.
- User-facing messages, CLI descriptions, errors and commits are in English. No comments in the code.
- Agent sessions run in the project directory itself (`config.cwd = process.cwd()`). `.kikimora/` is runtime state, gitignored in this repo and ignored by ESLint; it is not part of the source code.
