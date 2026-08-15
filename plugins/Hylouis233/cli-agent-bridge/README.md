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
  code, output tail, stderr tail, and the before/after git snapshots (staged, unstaged,
  untracked, and committed deltas) the worker produced. Runs against the same workspace are
  serialized; dirty trees are refused unless allowDirty=true; cancellation kills the worker.

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
then compare the two diffs. Create two independent worktrees first.
```

Expected result: the orchestrator creates two git worktrees (`git worktree add ../ws-claude`,
`git worktree add ../ws-kimi`), delegates the same task to backend=claude in the first and
backend=kimi in the second, then compares the two diffs reported to the user. Independent
comparison runs need separate worktrees: the first run leaves its checkout dirty, so a
same-workspace second run would be rejected by the allowDirty=false guard (same-checkout runs
are serialized into a queue, which suits follow-up work, not parallel comparisons).

## Requirements

- Node.js 20 or newer to run the MCP server (the server has no npm dependencies).
- git available on PATH; the target workspace must be a git repository.
- Supported operating systems: Windows, macOS, and Linux. The server is plain Node.js; on Windows,
  shim-based CLIs additionally go through the bundled PowerShell 5.1 runner. End-to-end verified on
  Windows (Claude Code 2.1.226, Kimi Code 0.30.0) and validated on Linux in a Node 22 container;
  macOS uses the same POSIX path and is not yet machine-verified.
- Each backend CLI must be installed, on PATH, and signed in with your own account before use:

| Backend | CLI | Status | Headless form used |
|---|---|---|---|
| claude | Claude Code | verified end-to-end (2.1.226) | claude -p <task> --output-format text --permission-mode acceptEdits |
| codex | OpenAI Codex CLI | documented non-interactive form | codex exec -- <task> |
| kimi | Kimi Code | headless invocation verified (0.30.0) | kimi -p <task> |

The claude template passes `--permission-mode acceptEdits` so the headless worker can edit files
in the workspace without an interactive approval prompt; other permission levels can be selected
by editing backends.json. The kimi prompt mode (`-p`) accepts no permission flags on current
versions, so the worker runs with kimi's own non-interactive defaults.

Experimental backends ship with a documented template and a note in list_backends:

| Backend | CLI | Status | Headless form used |
|---|---|---|---|
| zcode | ZCode | experimental | zcode -p <task> (desktop builds have no verified headless mode) |
| dsh | DeepSeek Harness | experimental | dsh --profile headless <task> (requires a headless profile) |

ZCode desktop builds have no verified headless CLI; point the command field at your own CLI if
your ZCode distribution provides one. The dsh template uses its documented headless profile
(dsh --profile headless), which must exist under DSH_HOME/profiles. Edit backends.json (or set
the CLI_AGENT_BRIDGE_BACKENDS environment variable to a custom file) to adjust command, args, or
binary paths.

On Windows, npm-style .ps1/.cmd shims cannot be launched directly, so the server retries them
through the bundled ps1-runner.ps1 using the built-in Windows PowerShell 5.1. Arguments pass
through verbatim with no cmd.exe re-interpretation. If a custom wrapper shim re-binds parameters
(for example a proxy autostart shim) and mangles dashed flags, set the backend command to the
underlying real executable in backends.json.

## Data and network

- This Plugin makes no network calls of its own and stores no credentials, tokens, or logs.
- delegate_task passes the task text to the backend CLI you choose, which runs with your own
  local authentication and may contact that vendor or service for the requested work.
- The task text and workspace files are processed by the chosen backend provider. Never include
  credentials, private endpoints, or personal data in a task.
- The server captures only the command output and the resulting git diff; nothing is transmitted
  anywhere by the server itself.
- Workers run with the permission level baked into their template (claude: acceptEdits, which
  auto-approves workspace file edits but still gates other tool classes) or with that CLI's own
  non-interactive defaults. Review the returned diff before accepting the work.

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
- zcode and dsh backends are experimental: ZCode desktop builds have no verified headless CLI,
  and dsh needs a headless profile present under DSH_HOME/profiles.
- Custom wrapper shims that re-bind dashed flags can misreport a backend as unavailable; point
  the backend command at the real executable to bypass the wrapper.

## License

MIT. See LICENSE. Upstream credits: see NOTICE.
