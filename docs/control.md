# Controlling a running worker

A running worker listens on a local control socket: a unix domain socket, or a named pipe on Windows. Its path is `<tmpdir>/kikimora-<uid>-<hash>.sock`, where the hash is derived from the project directory. A shell in the same directory finds the socket without configuration. The socket exposes the dashboard's functions to the subcommands below and to your own tooling over the wire protocol.

Changes apply live:

- a patched setting from the next session;
- a replaced prompt or context file from the next iteration;
- an added task as soon as the executor is idle.

Commands exit `1` when no worker is running, when the worker rejects the request, and when `retry` or `cancel` matches no task.

## Commands

| Command                                                                                     | Effect                                                                                                  |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `kikimora status [--json]`                                                                  | agent states and phases, task counts, cost; exits `1` without a worker, so it works as a health check   |
| `kikimora version [--json]`                                                                 | the worker's identity: kikimora, Claude Code and Node versions, auth kind, pid, start time, project     |
| `kikimora pause [monitor\|executor]`                                                        | pause after the current session finishes                                                                |
| `kikimora resume [monitor\|executor]`                                                       | resume paused agents, including after an `authBlocked` stop                                             |
| `kikimora drain [--timeout <ms>] [--json]`                                                  | let the current sessions finish, then exit; see below                                                   |
| `kikimora tasks list [--status <s>] [--json]`                                               | the task queue, optionally filtered by status                                                           |
| `kikimora tasks add <description> [--id <id>] [--title <t>] [--json]`                       | queue a task by hand; the id defaults to a generated `manual-…` id, the title to the first line         |
| `kikimora tasks retry <id>` / `kikimora tasks cancel <id>`                                  | requeue a failed task / cancel a pending one                                                            |
| `kikimora settings get [--json]`                                                            | effective settings, defaults filled in                                                                  |
| `kikimora settings patch <json\|-> [--json]`                                                | merge a sparse patch into `settings.json`; `null` deletes a key, the result is validated before writing |
| `kikimora prompt get <agent> [--json]`                                                      | print a project prompt                                                                                  |
| `kikimora prompt set <agent> [file\|-]`                                                     | replace it from a file or stdin; empty input is refused                                                 |
| `kikimora context get [--json]`                                                             | print the workspace context file; empty output when there is none                                       |
| `kikimora context set [file\|-]`                                                            | replace it from a file or stdin; empty input clears it                                                  |
| `kikimora memory search <query> [--limit <n>] [--json]`                                     | full-text search over task summaries (1 to 100 entries, default 10)                                     |
| `kikimora memory recent [--limit <n>] [--json]`                                             | the newest task summaries (same limits)                                                                 |
| `kikimora sessions list [--agent <a>] [--task <id>] [--before <ts>] [--limit <n>] [--json]` | the indexed sessions, newest first (1 to 100 entries, default 20)                                       |
| `kikimora sessions show <id> [--log] [--json]`                                              | one session's metadata and the paths of its two transcript files; `--log` prints the readable one       |

- `--json` prints the raw payload for scripts.
- `prompt set` and `context set` read stdin when the file argument is `-` or missing; `settings patch -` reads the patch from stdin.
- `kikimora version` describes the _running_ worker and fails without one. `kikimora --version` prints the installed CLI's version and needs no worker.

`kikimora drain` lets the running sessions finish and then stops the worker. [Stopping the worker](deployment.md#stopping-the-worker) describes what it waits for, its deadline and the `SIGTERM` equivalent.

## In containers

A socket inside a container is not reachable from the host by default. `KIKIMORA_CONTROL_SOCKET` moves it to an absolute path, shorter than 104 bytes, on a volume both sides can see. The worker creates the directory, and the CLI reads the same variable:

```yaml
volumes:
  - /tmp/kikimora-run:/run/kikimora
environment:
  KIKIMORA_CONTROL_SOCKET: /run/kikimora/control.sock
```

From the host: `KIKIMORA_CONTROL_SOCKET=/tmp/kikimora-run/control.sock kikimora status`.

- The worker sets the socket to mode `0600`, so a user with a different uid gets `Permission denied`.
- When you run several workers, give each its own directory.
- A second `kikimora` in the same project exits with an error while one is running.

## Wire protocol

Each connection carries one request and one response:

- The request is a JSON object terminated by `\n`.
- The response is one JSON line: `{"ok":true,"data":…}` or `{"ok":false,"error":"…"}`.
- `data` is omitted when a command returns nothing. Optional fields inside it are omitted when unset; they are not sent as `null`.
- Requests over 1 MiB are refused. Connections idle for 5 s are closed.

| Request                                                                         | `data`                                           |
| ------------------------------------------------------------------------------- | ------------------------------------------------ |
| `{"cmd":"status"}`                                                              | the document `kikimora status --json` prints     |
| `{"cmd":"version"}`                                                             | the identity block alone (see below)             |
| `{"cmd":"pause","agent":"monitor"\|"executor"\|"all"}`                          | none                                             |
| `{"cmd":"resume","agent":…}`                                                    | none; refused while the worker drains            |
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
| `{"cmd":"prompt.set","agent":…,"content":"…"}`                                  | none; blank `content` is refused                 |
| `{"cmd":"context.get"}`                                                         | `{"content":"…"}`; `""` when there is no file    |
| `{"cmd":"context.set","content":"…"}`                                           | none; an empty `content` clears the file         |
| `{"cmd":"sessions.list","agent"?:…,"taskId"?:"…","before"?:"…","limit"?:1-100}` | `SessionRecord[]`, newest first                  |
| `{"cmd":"sessions.get","sessionId":"…"}`                                        | one `SessionRecord`; an unindexed id is an error |

Errors:

- An unknown `cmd` or non-JSON input returns `Unrecognized control request.`
- A bad payload names the field: `Invalid tasks.add request: description: …`.
- A rejected settings patch returns `Invalid configuration (.kikimora/settings.json):` followed by the offending paths.

### The session index

Kikimora indexes each session it runs in `.kikimora/data/memory.db`, next to long-term memory. A record holds:

- from the start: `sessionId`, `agent` (`monitor`, `executor` or `summarizer`), `taskId` or `cycle`, `model`, `startedAt`;
- from the end: `finishedAt`, `ok`, `failureReason`, `costUsd`, `numTurns`;
- `logPath` and `jsonlPath`, relative to `.kikimora/`, so the index stays valid in a container and on its host.

A session is indexed when Claude Code reports its `init` event. A session killed before Claude Code reported a result is closed with `ok: false`, a `failureReason` and no cost.

`sessions.list` returns the newest first. `before` is a keyset cursor: pass the `startedAt` of the last row you received to fetch the next page. `sessions.get` returns **metadata only, never the transcript**: a reply is one line, and an executor session's JSON transcript can run to megabytes. Read the files with `kikimora sessions show <id> --log` locally, or from the volume on a server. [Session transcripts](deployment.md#session-transcripts) describes the two files per session.

### The identity block

`version` returns the identity block alone. The `status` document starts with the same fields, followed by `headless`, `agents`, `stats`, `taskCounts` and, while the worker drains, `drain`. The `drain` object holds `since`, `until` when the drain has a deadline, and `reason` (`drain`, or `SIGTERM` under a shutdown grace).

| Field           | Value                                                                                                       |
| --------------- | ----------------------------------------------------------------------------------------------------------- |
| `version`       | the kikimora version the worker runs                                                                        |
| `claudeVersion` | the Claude Code CLI version, read once at startup from `claude --version`; absent when it could not be read |
| `nodeVersion`   | the Node.js version of the worker process                                                                   |
| `pid`           | the worker's process id                                                                                     |
| `startedAt`     | ISO 8601 start time                                                                                         |
| `projectDir`    | the project the worker operates on                                                                          |
| `authKind`      | `apiKey`, `oauth`, `claude.ai` or `unknown`; the secret itself is not included                              |

`authKind` follows Claude Code's own precedence:

1. `apiKey` when `ANTHROPIC_API_KEY` is set (it outranks an OAuth token, as in `claude -p`), or when `claude auth status` reports an `apiKeySource` such as an `apiKeyHelper` or a Console-created key;
2. `oauth` when `CLAUDE_CODE_OAUTH_TOKEN` is set or the CLI reports `oauth_token`;
3. `claude.ai` for a stored `claude auth login`;
4. `unknown` otherwise.

Cloud-provider setups (`CLAUDE_CODE_USE_BEDROCK|VERTEX|FOUNDRY`), gateways and `ANTHROPIC_AUTH_TOKEN` are outside this mapping and report `unknown`. A leftover `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` next to them still sets the field.

New releases add fields and do not remove or rename existing ones, so a consumer that ignores unknown fields keeps working across upgrades. Against a worker started from an older kikimora, `kikimora status` shows `claude unknown · auth unknown`, and `kikimora version` answers `does not support "version"` with a hint to restart the worker.
