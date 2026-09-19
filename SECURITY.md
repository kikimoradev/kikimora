# Security Policy

## Supported versions

Security fixes go into the latest release only.

## Reporting a vulnerability

Report security issues through [GitHub private vulnerability reporting](https://github.com/kikimoradev/kikimora/security/advisories/new), not in public GitHub issues. Reports get a response within 7 days. Fixes for confirmed vulnerabilities are released on a schedule set by their severity.

## Threat model

Kikimora runs Claude Code sessions with `--permission-mode bypassPermissions` and full tool access in the directory it is started from. It provides no sandbox. The prompts are the safety boundary, and the operator decides what the agents may touch. The README documents this design, and it is not a vulnerability in itself.

**In scope**, for example:

- another local user reading or controlling a running worker (control socket, log files, task store);
- kikimora writing credentials or other secrets to an unexpected place (logs, memory database, task files);
- a crafted project or configuration writing outside the documented `.kikimora/` layout (path traversal, symlinks);
- the MCP memory server exposing more than its `memory_search` and `memory_get` tools.

**Out of scope**:

- an agent action that the configured prompts allowed; prompt design is the operator's responsibility;
- prompt injection through content the agents read while working, a limitation of autonomous agents (see "Security and costs" in the README);
- vulnerabilities in Claude Code itself; report those to [Anthropic](https://www.anthropic.com/security).
