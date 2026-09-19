# Prompts

Agent prompts are split between the package and your project:

- **System prompts** define each agent's role and rules. They ship with the npm package and are not meant to be edited per project.
- **Project prompts** carry your business context: what to watch, where, and how to work on it. They live in `.kikimora/prompts/` and you write them.
- The optional **context file** describes the workspace itself: the repositories, the APIs, the machine. Both agents get it appended to their project prompt.

The first-run wizard collects the first version of the project prompts. Its editor accepts pasted markdown; Enter adds a line and Ctrl+D submits. Edit the files later with these tools:

| Tool                                  | Effect                                                                           |
| ------------------------------------- | -------------------------------------------------------------------------------- |
| `/prompt monitor`, `/prompt executor` | open the prompt in the dashboard editor; Ctrl+D saves, Esc closes without saving |
| `/context`                            | open the context file in the same editor                                         |
| `kikimora prompt get\|set <agent>`    | read or replace a prompt from a shell ([docs/control.md](control.md))            |
| `kikimora context get\|set`           | read or replace the context file from a shell                                    |

The agents re-read these files before each session, so a saved change applies to the next session.

| File                                   | Lives in     | Role                                                        |
| -------------------------------------- | ------------ | ----------------------------------------------------------- |
| `prompts/monitor.system.md`            | the package  | the monitor's role and how it decides what counts as a task |
| `prompts/executor.system.md`           | the package  | the executor's working rules                                |
| `prompts/summarizer.system.md`         | the package  | how to distill a session into findings worth remembering    |
| `.kikimora/prompts/monitor.prompt.md`  | your project | what the monitor checks on each patrol                      |
| `.kikimora/prompts/executor.prompt.md` | your project | the task template (the task is appended at the end)         |
| `.kikimora/prompts/context.md`         | your project | optional: the workspace, appended to both project prompts   |

## How the prompts compose

- The **monitor** session gets `monitor.prompt.md` as its prompt. It must answer with a JSON task report that matches an enforced schema. Each task has a stable `id`, a `title`, and a `description` with everything needed to complete it in a separate session.
- The **executor** session gets `executor.prompt.md` followed by a `## Task to complete` section with the task's ID, title and description. One session handles one task.
- The optional **context file** is appended to both project prompts after a blank line: at the end of the monitor's prompt, and between the executor's prompt and the `## Task to complete` section. A missing, empty or blank file adds nothing.
- The **summarizer** has no project prompt and no context. It reads the executor's session log and writes findings to long-term memory.

## Example: a repository caretaker

`.kikimora/prompts/monitor.prompt.md`, what to look for:

```markdown
# Monitor: acme-shop repository

Check the following sources and report actionable tasks:

1. **CI on main**: run `gh run list --branch main --limit 5`. If the latest
   run failed, report a task to investigate and fix it. Use the run ID in the
   task id: `ci-<run-id>`.
2. **Issues labeled `good-first-issue` or `bug`**: run
   `gh issue list --label bug --state open`. For each issue that describes a
   concrete, self-contained code change, report a task with id `issue-<number>`.
   Skip discussions, feature requests, and anything that needs a product decision.
3. **Outdated dependencies**: once in a while run `pnpm outdated`. Report a
   single task (id `deps-patch`) only when there are pending **patch** updates.

Include in every description: the exact commands or links you used, the error
output if any, and what "done" means for the task.
```

`.kikimora/prompts/executor.prompt.md`, how to work:

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

- **Derive task ids from the source.** The monitor session has no record of its earlier reports, so it can report the same problem on each patrol. The task store skips any id it already holds, whatever that task's status. An id derived from the source (`issue-142`, `ci-9182634`) keeps one problem as one task.
- **Put the whole briefing in the description.** An executor session's input is the executor prompt, the context file and the task; earlier sessions reach it only through memory search. Links, error output and acceptance criteria must be in the task description.
- **Set the safety boundaries in the prompts.** The executor runs with `--permission-mode bypassPermissions`, so the prompts define what it may do. List what is off-limits: pushing to `main`, deploying, touching secrets.
- **Tell the executor when to use memory.** The executor can search past findings with `memory_search` and `memory_get`. Say in the executor prompt when to look things up, e.g. "check memory for previous attempts at this task id".
