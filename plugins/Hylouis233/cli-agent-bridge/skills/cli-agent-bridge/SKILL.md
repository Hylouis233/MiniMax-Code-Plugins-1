---
name: cli-agent-bridge
description: Delegate a coding task from MiniMax Code to a locally installed coding CLI (Claude Code, Codex, Kimi Code, ZCode, or DSH). Use this Skill whenever the user asks to offload implementation to another coding agent, cross-check work with a second agent, parallelize independent subtasks, or run a long self-contained task outside the current context.
---

# CLI Agent Bridge

MiniMax Code stays the orchestrator. The other coding CLIs run as headless workers
inside the target git repository, and their results come back as a git diff for review.

## When to use

- The user names another CLI explicitly (for example: delegate this to codex).
- A task is long and self-contained and should not fill the current context.
- Independent subtasks in separate workspaces can run in parallel across different CLIs;
  same-workspace delegations queue behind each other.
- The user wants a second opinion or a cross-check from another agent.

## Workflow

1. Run workspace_status with the workspace path and confirm the working tree is clean.
2. Pick a backend from list_backends and confirm it is available on this machine.
3. Run delegate_task with a self-contained task, the workspace path, and the backend name.
   Delegations to the same workspace are serialized across bridge server processes, so parallel
   runs from separate MCP clients still queue instead of interleaving edits.
4. Review the returned result: the before and after git snapshots (status, diff stat, changed
   files including staged and new files), changed refs and the commits block when the worker committed, the
   output and stderr tails, and the exit code. A failed, timed-out, or cancelled run reports
   ok=false (and isError=true at the protocol level); never treat such a result as success.
5. If the result is wrong, delegate a follow-up task. delegate_task results do not carry the
   backend's own session id, so use resumeSessionId only when the user already knows one (for
   example from the backend CLI's session history); otherwise start a fresh delegation with the
   needed context in the task text.

## Backend guidance

- claude: general implementation and cross-model review of Codex output.
- codex: implementation and targeted edits.
- kimi: independent implementation pass or comparison run.
- zcode: marked experimental; verify the command template in backends.json first.
- dsh: marked experimental; verify the command template in backends.json first.

## Safety rules

- Never include credentials, tokens, private endpoints, or personal data in the task text.
- Keep allowDirty=false (the default) unless the user explicitly accepts running on a dirty tree.
- Default templates let the worker edit workspace files autonomously (for example claude runs
  with --permission-mode acceptEdits); treat every returned diff as untrusted until reviewed.
- Review every change the worker produced before reporting completion. New files the worker
  created are listed under changed files even though they do not appear in git diff --stat.
- Run independent or comparison workers in separate clean Git worktrees at the same starting
  commit. A second run in one checkout inherits the first run's edits and is not independent.
- Timeouts: the default is 20 minutes; adjust timeoutMs for very large tasks. The deadline starts
  after lock acquisition and covers preflight Git checks, the worker, and post-run snapshots. A
  timed-out worker has its complete process tree terminated before the lock is released; safe
  termination may use the additional kill grace period.
- Cancellation: cancelling an in-flight delegate_task call terminates the complete worker process
  tree and the result reports cancelled=true. If tree termination cannot be confirmed, the bridge
  writes a shared quarantine marker that blocks every bridge process. After checking for leftover
  processes, an operator must deliberately remove the reported quarantinePath. The workspace may
  still contain edits made before cancellation, so still review the returned snapshot.
- Snapshot reliability: a worker's changes to Git refs are compared as well as final HEAD, and a
  truncated Git capture fails closed. If outputTruncated/stderrTruncated is true, treat the returned
  backend tail as partial.
- Cancelling workspace_status while it is queued or snapshotting returns promptly with
  cancelled=true; it does not run a delayed status snapshot after the active delegation finishes.

## Notes

- This Skill only instructs the agent. The MCP server shipped with this Plugin launches the CLIs.
- The Plugin stores no credentials and makes no network calls of its own.
