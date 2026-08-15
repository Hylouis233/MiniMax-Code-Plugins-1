# CLI Agent Bridge

## The problem

MiniMax Code users who also run Claude Code, Codex, Kimi Code, ZCode, or DSH want to keep
MiniMax Code as the single orchestrator while handing well-scoped implementation work to those
CLIs. Without a bridge, delegation means copying prompts between terminals and pasting results
back, with no record of what the worker changed.

## What this Plugin does

This Plugin ships one dependency-free stdio MCP server and one Skill. MiniMax Code calls the
three MCP tools to drive headless sessions of the other coding CLIs inside the same git
repository:

- list_backends: report which coding CLIs are installed and available on this machine.
- workspace_status: git status, diff stat, and changed files before delegating work.
- delegate_task: run a self-contained task with a chosen backend CLI and return its exit
  code, output tail, stderr tail, and the git diff the worker produced.

The Skill teaches MiniMax Code when and how to delegate, and to review the returned diff before
reporting completion.

## Try it

```text
Use the cli-agent-bridge skill, then delegate the login-form refactor in this repository to codex.
```

Expected result: MiniMax Code checks workspace_status, confirms the tree is clean, runs
delegate_task with backend=codex and a self-contained task, then reviews the returned git status,
diff stat, changed files, and output tail before continuing.

```text
Use cli-agent-bridge to have claude and kimi implement the same small feature independently,
then compare the two diffs.
```

Expected result: two delegate_task runs (backend=claude and backend=kimi) against the same
workspace, followed by a comparison of the two diffs reported to the user.

## Requirements

- Node.js 20 or newer to run the MCP server (the server has no npm dependencies).
- git available on PATH; the target workspace must be a git repository.
- Each backend CLI must be installed, on PATH, and signed in with your own account before use:

| Backend | CLI | Status | Headless form used |
|---|---|---|---|
| claude | Claude Code | verified | claude -p <task> --output-format text |
| codex | OpenAI Codex CLI | verified | codex exec <task> |
| kimi | Kimi Code | verified | kimi -p <task> |
| zcode | ZCode | experimental | zcode -p <task> (verify locally) |
| dsh | DeepSeek Harness | experimental | dsh run <task> (verify locally) |

Experimental backends ship with a sensible template that must be verified against your local
CLI version. Edit backends.json (or set the CLI_AGENT_BRIDGE_BACKENDS environment variable to a
custom file) to adjust command, args, or binary paths.

## Data and network

- This Plugin makes no network calls of its own and stores no credentials, tokens, or logs.
- delegate_task passes the task text to the backend CLI you choose, which runs with your own
  local authentication and may contact that vendor or service for the requested work.
- The task text and workspace files are processed by the chosen backend provider. Never include
  credentials, private endpoints, or personal data in a task.
- The server captures only the command output and the resulting git diff; nothing is transmitted
  anywhere by the server itself.
- Workers run with whatever permission or sandbox configuration that CLI has. Review the
  returned diff before accepting the work.

## Customizing backends

backends.json maps each backend to a command template. The placeholders <task> and <session>
are substituted at run time. To use a differently named binary (for example a zcode wrapper),
change the command field. resumeSessionId is honored only for backends whose resumeArgs is set.

## Limitations

- MiniMax Code Agent Plugins 1.0 does not expose hooks, so context metering and automatic
  orchestration switches from the upstream subagent-mcp design are out of scope here; the Skill
  plays that role instead.
- The bridge delegates tasks; it does not merge code, commit, or push. The user reviews every
  diff.
- zcode and dsh backends are experimental because their headless modes vary by version.

## License

MIT. See LICENSE. Upstream credits: see NOTICE.
