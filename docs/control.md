# Controlling a running worker

A running worker listens on a local control socket — a unix domain socket (a named pipe on Windows) at `<tmpdir>/brownie-<uid>-<hash>.sock`, derived from the project directory, so any shell in the same directory finds it without configuration. Everything the dashboard can do is available over it: from a shell through the subcommands below, or straight over the wire from your own tooling.

Changes apply live — a patched setting on the next session, a replaced prompt on the next iteration, an added task as soon as the executor is idle. Commands exit `1` when no worker is running, when the worker rejects the request, and when `retry`/`cancel` matches no task.

## Commands

| Command                                                                           | Effect                                                                                                 |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `brownie status [--json]`                                                         | who's running, phases, task counts, cost — non-zero without a worker, so it doubles as a health check  |
| `brownie version [--json]`                                                        | the worker's identity: brownie, Claude Code and Node versions, auth kind, pid, start time, project     |
| `brownie pause [monitor\|executor]`                                               | graceful pause — the current session finishes first                                                    |
| `brownie resume [monitor\|executor]`                                              | resume paused agents (also after an `authBlocked` stop)                                                |
| `brownie drain [--timeout <ms>] [--json]`                                         | let the current sessions finish, then exit — see below                                                 |
| `brownie tasks list [--status <s>] [--json]`                                      | the task queue, optionally one status                                                                  |
| `brownie tasks add <description> [--id <id>] [--title <t>]`                       | queue a task by hand                                                                                   |
| `brownie tasks retry <id>` / `brownie tasks cancel <id>`                          | requeue a failed task / drop a pending one                                                             |
| `brownie settings get [--json]`                                                   | effective settings, defaults filled in                                                                 |
| `brownie settings patch <json\|-> [--json]`                                       | merge a sparse patch into `settings.json` — `null` deletes a key, the file is validated before writing |
| `brownie prompt get <agent> [--json]`                                             | print a project prompt                                                                                 |
| `brownie prompt set <agent> [file\|-]`                                            | replace it from a file or stdin                                                                        |
| `brownie context get [--json]`                                                    | print the workspace context file — empty output when there is none                                     |
| `brownie context set [file\|-]`                                                   | replace it from a file or stdin; empty input clears it                                                 |
| `brownie memory search <query> [--limit <n>]`                                     | full-text search over task summaries (1–100 entries, default 10)                                       |
| `brownie memory recent [--limit <n>]`                                             | the newest task summaries                                                                              |
| `brownie sessions list [--agent <a>] [--task <id>] [--before <ts>] [--limit <n>]` | the indexed sessions, newest first (1–100 entries, default 20)                                         |
| `brownie sessions show <id> [--log]`                                              | one session's metadata and the paths of its two transcript files; `--log` prints the readable one      |

`--json` prints the raw payload for scripts; `-` reads the body from stdin. `brownie version` describes the _running_ worker and fails without one — `brownie --version` prints the installed CLI's version and needs no worker.

`brownie drain` stops a worker without throwing work away. Both agents finish what they are doing — for the executor that is its session and the memory summary after it — start nothing new, and the process exits `0` once both are idle, logging `worker.stopped` with `drained: true`. The command returns as soon as the worker accepts the request. `--timeout <ms>` (up to 24 hours) adds a deadline: whatever still runs then is killed, and `worker.stopped` adds `forced: true`. Asking again answers with the first acknowledgement and never moves the deadline, `resume` is refused until the worker is gone, and any signal during a drain stops the worker at once. `SIGTERM` drains the same way when `shutdownGraceMs` is set ([deployment](deployment.md#stopping-the-worker)).

## In containers

The socket is invisible from outside the container. `BROWNIE_CONTROL_SOCKET` moves it to an absolute path (shorter than 104 bytes) that both sides can see — the worker creates the directory, the CLI reads the same variable:

```yaml
volumes:
  - /tmp/brownie-run:/run/brownie
environment:
  BROWNIE_CONTROL_SOCKET: /run/brownie/control.sock
```

From the host: `BROWNIE_CONTROL_SOCKET=/tmp/brownie-run/control.sock brownie status`. The socket is `chmod 0600` by the worker's user, so a different uid gets `Permission denied`; give each agent its own directory when you run several. A second `brownie` in the same project refuses to start while one is already running.

## Wire protocol

One connection carries one request — a JSON object terminated by `\n` — and receives one JSON line back: `{"ok":true,"data":…}` or `{"ok":false,"error":"…"}`. `data` is omitted when a command returns nothing; optional fields inside it are omitted, never `null`. Requests over 1 MiB are refused, idle connections dropped after 5 s.

| Request                                                                         | `data`                                           |
| ------------------------------------------------------------------------------- | ------------------------------------------------ |
| `{"cmd":"status"}`                                                              | the document `brownie status --json` prints      |
| `{"cmd":"version"}`                                                             | the identity block alone (see below)             |
| `{"cmd":"pause","agent":"monitor"\|"executor"\|"all"}`                          | —                                                |
| `{"cmd":"resume","agent":…}`                                                    | —; refused while the worker drains               |
| `{"cmd":"drain","timeoutMs"?:1-86400000}`                                       | `{"state":"draining","since":"…","until"?:"…"}`  |
| `{"cmd":"settings.get"}`                                                        | effective settings                               |
| `{"cmd":"settings.patch","patch":{…}}`                                          | the resulting settings; `null` deletes a key     |
| `{"cmd":"tasks.list","status"?:…}`                                              | `Task[]`                                         |
| `{"cmd":"tasks.add","description":"…","id"?:"…","title"?:"…"}`                  | the created `Task`; a duplicate id is an error   |
| `{"cmd":"tasks.retry","id":"…"}`                                                | `true` when a failed task was requeued           |
| `{"cmd":"tasks.cancel","id":"…"}`                                               | `true` when a pending task was cancelled         |
| `{"cmd":"memory.search","query":"…","limit"?:1-100}`                            | task summaries, best match first                 |
| `{"cmd":"memory.recent","limit"?:1-100}`                                        | the newest task summaries                        |
| `{"cmd":"prompt.get","agent":"monitor"\|"executor"}`                            | `{"agent":…,"content":"…"}`                      |
| `{"cmd":"prompt.set","agent":…,"content":"…"}`                                  | —                                                |
| `{"cmd":"context.get"}`                                                         | `{"content":"…"}`; `""` when there is no file    |
| `{"cmd":"context.set","content":"…"}`                                           | —; an empty `content` clears the file            |
| `{"cmd":"sessions.list","agent"?:…,"taskId"?:"…","before"?:"…","limit"?:1-100}` | `SessionRecord[]`, newest first                  |
| `{"cmd":"sessions.get","sessionId":"…"}`                                        | one `SessionRecord`; an unindexed id is an error |

An unknown `cmd` or non-JSON input answers `Unrecognized control request.`; a bad payload names the field (`Invalid tasks.add request: description: …`); a rejected settings patch answers `Invalid configuration (.brownie/settings.json):` with the offending paths.

### The session index

Every session brownie runs is indexed in `.brownie/data/memory.db`, next to long-term memory: `sessionId`, `agent` (`monitor`/`executor`/`summarizer`), `taskId` or `cycle`, `model`, `startedAt`, and — once it ends — `finishedAt`, `ok`, `failureReason`, `costUsd`, `numTurns`. A session killed before Claude Code reported a result is closed with `ok: false` and a `failureReason`, without a cost. `logPath` and `jsonlPath` are relative to `.brownie/`, so the index travels between a container and its host.

`sessions.list` returns the newest first; `before` is a keyset cursor — pass the `startedAt` of the last row you saw to fetch the next page. `sessions.get` returns **metadata only, never the transcript**: a reply is one line, and an executor session's JSON transcript runs to megabytes. Read the files instead — `brownie sessions show <id> --log` locally, or the volume directly on a server. The two files per session are described in [deployment](deployment.md#session-transcripts).

### The identity block

`version` returns it on its own; the `status` document opens with the same fields, followed by `headless`, `agents`, `stats`, `taskCounts` and — only while the worker drains — `drain`: `since`, `until` when the drain has a deadline, and `reason` (`drain`, or `SIGTERM` under a shutdown grace):

| Field           | Value                                                                                                       |
| --------------- | ----------------------------------------------------------------------------------------------------------- |
| `version`       | the brownie version the worker runs                                                                         |
| `claudeVersion` | the Claude Code CLI version, read once at startup from `claude --version`; absent when it could not be read |
| `nodeVersion`   | the Node.js version of the worker process                                                                   |
| `pid`           | the worker's process id                                                                                     |
| `startedAt`     | ISO 8601 start time                                                                                         |
| `projectDir`    | the project the worker operates on                                                                          |
| `authKind`      | `apiKey`, `oauth`, `claude.ai` or `unknown` — never the secret                                              |

`authKind` follows Claude Code's own precedence: `apiKey` when `ANTHROPIC_API_KEY` is set (it outranks an OAuth token, as it does in `claude -p`) or when `claude auth status` reports any `apiKeySource` — an `apiKeyHelper`, a Console-created key; `oauth` when `CLAUDE_CODE_OAUTH_TOKEN` is set or the CLI reports `oauth_token`; `claude.ai` for a stored `claude auth login`; `unknown` otherwise. Cloud-provider (`CLAUDE_CODE_USE_BEDROCK|VERTEX|FOUNDRY`), gateway and `ANTHROPIC_AUTH_TOKEN` setups are outside this mapping and report `unknown` — a leftover key or token variable next to them is still what the field names.

Fields are only ever added, so a consumer that ignores what it does not know keeps working across upgrades. The other direction degrades gracefully too: against a worker started from an older brownie, `brownie status` shows `claude unknown · auth unknown`, and `brownie version` answers `does not support "version"` with a hint to restart the worker.
