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
- Independent subtasks can run in parallel across different CLIs.
- The user wants a second opinion or a cross-check from another agent.

## Workflow

1. Run workspace_status with the workspace path and confirm the working tree is clean.
2. Pick a backend from list_backends and confirm it is available on this machine.
3. Run delegate_task with a self-contained task, the workspace path, and the backend name.
4. Review the returned git status, diff stat, changed files, output tail, and exit code.
5. If the result is wrong, delegate a follow-up task with resumeSessionId where supported.

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
- Timeouts: the default is 20 minutes; adjust timeoutMs for very large tasks.

## Notes

- This Skill only instructs the agent. The MCP server shipped with this Plugin launches the CLIs.
- The Plugin stores no credentials and makes no network calls of its own.
