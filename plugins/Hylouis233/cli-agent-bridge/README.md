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
  serialized across independent bridge processes; dirty trees are refused unless allowDirty=true;
  cancellation and timeout terminate the complete worker process tree before the lock is released.

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
then compare the two diffs. Create two independent clones first.
```

Expected result: the orchestrator creates two clones at the same starting commit, delegates the
same task to backend=claude in the first and backend=kimi in the second, then compares the two
diffs reported to the user. Linked worktrees share refs and therefore queue behind the same
repository lock; use separate clones when the comparison must run in parallel.

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

- This Plugin makes no network calls of its own and stores no credentials, tokens, or session logs.
  Per-user temporary lock records contain only process identity; if termination cannot be confirmed,
  a quarantine marker containing the workspace path/backend/error persists until an operator removes it.
- delegate_task passes the task text to the backend CLI you choose, which runs with your own
  local authentication and may contact that vendor or service for the requested work.
- The task text and workspace files are processed by the chosen backend provider. Never include
  credentials, private endpoints, or personal data in a task.
- The server returns bounded command-output tails and Git snapshots to its MCP client; nothing is
  transmitted elsewhere by the server itself.
- Workers run with the permission level baked into their template (claude: acceptEdits, which
  auto-approves workspace file edits but still gates other tool classes) or with that CLI's own
  non-interactive defaults. Review the returned diff before accepting the work.

## Customizing backends

backends.json maps each backend to a command template. The placeholders <task> and <session>
are substituted at run time. To use a differently named binary (for example a zcode wrapper),
change the command field. resumeSessionId is honored only for backends whose resumeArgs is set.
The bridge does not discover or parse session IDs from CLI output; pass resumeSessionId only when
you already obtained a valid ID from that backend outside this Plugin.

## Limitations

- MiniMax Code Agent Plugins 1.0 does not expose hooks, so context metering and automatic
  orchestration switches from the upstream subagent-mcp design are out of scope here; the Skill
  plays that role instead.
- The bridge delegates tasks; it does not merge code, commit, or push. The user reviews every
  diff.
- Delegations and status snapshots targeting the same Git common directory are serialized even
  when callers name a subdirectory, different path casing, symlink, or linked worktree, and even
  when separate MCP clients launched separate bridge server processes. Use separate clean clones
  for parallel comparison runs. The cross-process lock is an owner blob referenced by an atomic Git-ref
  compare-and-swap. A stale idle lock is reclaimed only when its same-host owner is positively
  confirmed dead; owner records include the bridge process start identity so a reused PID cannot
  pin the queue. The host identity also includes the OS user, so another user cannot interpret a
  user-scoped quarantine marker as cleared. Malformed, foreign-user/host, starting, running, or
  uncertain records fail closed.
  A crashed bridge cannot reconstruct descendants that escaped into another POSIX session from the
  recorded worker PID alone, so inspect leftover processes and clear those hidden refs manually.
- Linked worktrees share refs and therefore intentionally share one repository lock. The
  `repositoryConcurrency` field remains as a fail-safe disclosure if an older bridge instance or
  an external writer updates bridge history during a snapshot, but current bridge instances do
  not run linked-worktree delegations concurrently.
- Locking leaves the worktree and index unchanged, but it requires writable Git object/ref metadata:
  each acquisition writes an owner blob and temporarily updates a hidden ref. Repository
  reference-transaction hooks can observe or reject those updates, and released owner blobs remain
  unreachable until normal Git garbage collection. For that reason workspace_status is not marked
  read-only in its MCP annotations even though the snapshot itself does not edit worktree files.
- Cancellation and timeout confirm that the delegated process tree has exited before releasing
  the workspace mutex. A lightweight ancestry monitor records descendants that create a new POSIX
  session/process group so cancellation still terminates them; tracked PIDs are matched against
  their recorded start identity (process start time on POSIX, creation time on Windows) so a
  reused PID is never signaled, and a POSIX process group is only signaled while its original
  leader identity still matches. On Linux, descendants also inherit a per-run environment marker;
  if the parent exits before ancestry polling, the close path performs one marker scan to recover
  reparented children without continuously scanning all of `/proc`. If termination cannot be
  confirmed, the bridge writes a shared
  quarantine marker, moves its lease into the recoverable `quarantined` state, and every bridge
  process refuses further delegation until an operator checks for leftovers and deliberately
  removes the reported quarantinePath - removing that marker also authorizes the next delegation
  to reclaim the quarantined lease. If the bridge crashes mid-run, a lease recording a running
  worker still cannot be reclaimed automatically (descendant liveness cannot be proven); delete
  the hidden lock ref recorded in the quarantine marker (or run `git update-ref -d` on the ref
  under `refs/cli-agent-bridge/workspace-locks/`) after checking for leftover processes. The
  quarantine marker itself lives in a current-user-scoped OS temporary directory.
  On Linux, zombie-only tracked trees count as terminated; zombies cannot edit the workspace and
  may otherwise persist when container PID 1 does not reap them.
- Cancelling a workspace_status request interrupts its queued lock wait or Git snapshot and returns
  a cancelled tool result instead of performing a stale snapshot later.
- timeoutMs is an overall deadline that includes workspace lock acquisition, preflight Git checks,
  the worker, and post-run snapshots. Safe process-tree termination can
  extend beyond that deadline by the documented kill grace period.
- Snapshots include all Git refs as well as HEAD, so a worker that commits on a new branch and
  returns to the original branch still reports the created ref and commit. Commits are attributed
  to the worker only when they are not reachable from any pre-delegation ref, so checking out an
  existing divergent branch is reported as a HEAD move with no new commits, and refs pointing at
  non-commit objects (for example a blob tag) are reported without failing the delegation. A commit
  reached through multiple moved refs is counted and logged once with all contributing labels;
  remote-tracking updates are treated as externally sourced fetch history and excluded from worker
  attribution, including when a local worker commit builds on the fetched tip. Any
  bounded Git capture that truncates is rejected as an unreliable snapshot; backend output
  truncation is disclosed.
- zcode and dsh backends are experimental: ZCode desktop builds have no verified headless CLI,
  and dsh needs a headless profile present under DSH_HOME/profiles.
- Custom wrapper shims that re-bind dashed flags can misreport a backend as unavailable; point
  the backend command at the real executable to bypass the wrapper.

## Verification

Run the dependency-free fake-backend suites from the repository root:

```text
node --test plugins/Hylouis233/cli-agent-bridge/test/server.test.mjs
node --test plugins/Hylouis233/cli-agent-bridge/tests/server.test.mjs
node --test plugins/Hylouis233/cli-agent-bridge/tests/workspace-lock.test.mjs
```

They cover the full MCP flow plus in-process and cross-process canonical worktree locking, stale
owner compare-and-swap, live-owner non-steal, quarantined-lease recovery after the operator
removes the marker, interruptible lease state updates, shared quarantine markers, queued and
discovery-phase cancellation (including list_backends probes), overall deadlines, cancel/timeout
process-tree termination, escaped POSIX descendants and zombie-only Linux groups, PID-reuse
identity checks before signaling, unusual Git pathnames (including a trailing-space worktree
root), JSON-RPC id typing, unborn HEAD and non-HEAD ref changes, checkout-only HEAD moves,
single-count attribution for commits on the checked-out branch, fork-point diff baselines for
new branches, non-commit refs, fetched-history exclusion, repository-wide serialization and
failed-release recovery between linked worktrees,
capture truncation, and Codex prompt delimiters on Windows and POSIX.

## License

MIT. See LICENSE. Upstream credits: see NOTICE.
