# Prompts

The sprite's personality is split between the package and your project. **System prompts** define who each agent is and how it behaves — they ship with the npm package and you normally never touch them. **Project prompts** carry your business context: what to watch, where, and how to work on it — they live in `.kikimora/prompts/` and are yours to write (the first-run wizard collects the first version — paste markdown straight into its editor, Enter adds a line, Ctrl+D submits). Later, view and edit them without leaving the dashboard: `/prompt monitor` or `/prompt executor` opens the same editor with the current file content — Ctrl+D saves (the next session already uses it, since the agents re-read the prompt files every cycle), Esc closes without saving. From a shell, `kikimora prompt get|set <agent>` does the same ([docs/control.md](control.md)). Next to them lives an optional **context file** — what the workspace itself is: the repositories, the APIs, the machine. It is edited the same way (`/context`, or `kikimora context get|set`) and both agents get it on top of their prompt.

| File                                   | Lives in     | Role                                                              |
| -------------------------------------- | ------------ | ----------------------------------------------------------------- |
| `prompts/monitor.system.md`            | the package  | who the monitor is and how it decides what counts as a task       |
| `prompts/executor.system.md`           | the package  | the executor's working rules                                      |
| `prompts/summarizer.system.md`         | the package  | how to distill a session into findings worth remembering          |
| `.kikimora/prompts/monitor.prompt.md`  | your project | what the monitor should check on every patrol                     |
| `.kikimora/prompts/executor.prompt.md` | your project | the task template (the task description is appended at the end)   |
| `.kikimora/prompts/context.md`         | your project | optional: what the workspace is, appended to both project prompts |

## How the prompts compose

- The **monitor** session gets `monitor.prompt.md` as its prompt and must answer with a JSON task report (the schema is enforced): each task has a stable `id`, a `title`, and a `description` with everything needed to complete it in a separate session.
- The **executor** session gets `executor.prompt.md` with a `## Task to complete` section appended at the end, containing the task's title and description. One session = one task.
- The optional **context file** is appended to both project prompts, after a blank line: at the end of the monitor's prompt, and between the executor's prompt and the `## Task to complete` section. Missing, empty or blank it adds nothing, so a project that does not use it sends exactly the prompt it always did. Like the prompts, it is re-read before every session, so an edit applies to the next one.
- The **summarizer** has no project prompt and no context — it reads the executor's session log and writes findings to long-term memory.

## Example: a repo caretaker

`.kikimora/prompts/monitor.prompt.md` — what to look for:

```markdown
# Monitor: acme-shop repository

Check the following sources and report actionable tasks:

1. **CI on main** — run `gh run list --branch main --limit 5`. If the latest
   run failed, report a task to investigate and fix it. Use the run ID in the
   task id: `ci-<run-id>`.
2. **Issues labeled `good-first-issue` or `bug`** — run
   `gh issue list --label bug --state open`. For each issue that describes a
   concrete, self-contained code change, report a task with id `issue-<number>`.
   Skip discussions, feature requests, and anything that needs a product decision.
3. **Outdated dependencies** — once in a while run `pnpm outdated`. Report a
   single task (id `deps-patch`) only when there are pending **patch** updates.

Include in every description: the exact commands or links you used, the error
output if any, and what "done" means for the task.
```

`.kikimora/prompts/executor.prompt.md` — how to work:

```markdown
# Executor: acme-shop repository

You work in the acme-shop repository (pnpm, TypeScript, vitest).

Rules:

- Create a branch `kikimora/<task-id>` off `main` for every task.
- Run `pnpm check` before committing; never commit red.
- Open a pull request with `gh pr create` and a description of what you did
  and why. Never push to `main` directly and never merge PRs.
- If the task turns out to be bigger than expected, stop, describe what you
  found in the summary, and leave the branch for a human.
```

## Tips

- **Stable task ids matter.** The monitor reports the whole picture on every patrol; tasks are deduplicated by `id`. Derive the id from the source (`issue-142`, `ci-9182634`) so the same problem never becomes two tasks.
- **The description is the whole briefing.** The executor session starts fresh — no chat history, no monitor context. Anything it needs (links, error output, acceptance criteria) must be in the task description.
- **Draw the safety boundaries in the prompts.** The executor runs with `--permission-mode bypassPermissions` — the prompts are the fence. Spell out what is off-limits (pushing to main, deploying, touching secrets) instead of assuming it.
- **Let the memory work.** The executor can search past findings with `memory_search` / `memory_get` — mention in the executor prompt when it should look things up (e.g. "check memory for previous attempts at this task id").
