# Security Policy

## Supported versions

Only the latest release receives security fixes.

## Reporting a vulnerability

Please do not report security issues in public GitHub issues.

Use [GitHub private vulnerability reporting](https://github.com/kikimoradev/kikimora/security/advisories/new) to report privately. You will get a response within 7 days; fixes for confirmed vulnerabilities are released as fast as severity demands.

## Threat model

Kikimora deliberately runs Claude Code sessions with `--permission-mode bypassPermissions` and full tool access in the directory it is started from. There is no sandbox — the prompts are the safety boundary, and the operator chooses what the agents may touch. That design is documented in the README and is not itself a vulnerability.

**In scope** — examples of what we want to hear about:

- another local user being able to read or control a running worker (control socket, log files, task store)
- kikimora itself writing credentials or other secrets somewhere unexpected (logs, memory database, task files)
- a crafted project or configuration escaping the documented `.kikimora/` layout (path traversal, symlink tricks)
- the MCP memory server exposing more than the `memory_search` / `memory_get` contract

**Out of scope**:

- an agent doing something undesirable that the configured prompts allowed — prompt design is the operator's responsibility
- prompt injection through content the agents read while working; this is an inherent limitation of autonomous agents (see "Security & costs" in the README)
- vulnerabilities in Claude Code itself — report those to [Anthropic](https://www.anthropic.com/security)
