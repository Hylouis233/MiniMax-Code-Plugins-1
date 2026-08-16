#!/usr/bin/env node
// cli-agent-bridge: a dependency-free stdio MCP server that lets MiniMax Code
// delegate coding tasks to locally installed coding CLIs (Claude Code, Codex,
// Kimi Code, ZCode, DSH). The server makes no network calls of its own; each
// backend CLI runs headless with the local user authentication.
//
// License: MIT. See NOTICE for upstream credits.

import { spawn } from "node:child_process";
import { readFile, realpath, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { isProcessTreeAlive, signalProcessTree, waitForChildExit, waitForProcessTreeExit } from "./process-tree.mjs";

const SERVER_NAME = "cli-agent-bridge";
const SERVER_VERSION = "0.1.0";
const PROTOCOL_VERSION = "2025-06-18";
const DEFAULT_TIMEOUT_MS = 1_200_000;
const MIN_TIMEOUT_MS = 5_000;
const MAX_TIMEOUT_MS = 3_600_000;
const VERSION_CHECK_TIMEOUT_MS = 15_000;
const GIT_TIMEOUT_MS = 30_000;
const KILL_GRACE_MS = 10_000;
const MAX_CAPTURE_CHARS = 5_000_000;
const RAW_TAIL_CHARS = 60_000;

// Built-in defaults. The sibling backends.json (or the CLI_AGENT_BRIDGE_BACKENDS
// environment variable) overrides these; a missing or invalid file falls back
// to this table.
const FALLBACK_BACKENDS = {
  claude: {
    label: "Claude Code",
    command: "claude",
    buildArgs: ["-p", "<task>", "--output-format", "text", "--permission-mode", "acceptEdits"],
    resumeArgs: ["-p", "<task>", "--output-format", "text", "--permission-mode", "acceptEdits", "--resume", "<session>"],
    experimental: false,
  },
  codex: {
    label: "OpenAI Codex CLI",
    command: "codex",
    buildArgs: ["exec", "--", "<task>"],
    resumeArgs: ["exec", "resume", "<session>", "--", "<task>"],
    experimental: false,
  },
  kimi: {
    label: "Kimi Code",
    command: "kimi",
    buildArgs: ["-p", "<task>"],
    resumeArgs: ["-S", "<session>", "-p", "<task>"],
    experimental: false,
  },
  zcode: {
    label: "ZCode",
    command: "zcode",
    buildArgs: ["-p", "<task>"],
    resumeArgs: null,
    experimental: true,
    notes: "Desktop ZCode builds have no verified headless mode; set command to your CLI if your distribution provides one.",
  },
  dsh: {
    label: "DeepSeek Harness (dsh)",
    command: "dsh",
    buildArgs: ["--profile", "headless", "<task>"],
    resumeArgs: null,
    experimental: true,
    notes: "Uses the documented headless profile; requires a headless profile under DSH_HOME/profiles.",
  },
};

const TOOLS = [
  {
    name: "list_backends",
    title: "List Delegation Backends",
    description:
      "List the configured coding-CLI backends (claude, codex, kimi, zcode, dsh) and report which ones are installed and available on this machine. Read-only.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "workspace_status",
    title: "Workspace Git Status",
    description:
      "Return git status, diff stat, and changed files for a workspace before delegating work. Read-only.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        workspacePath: {
          type: "string",
          minLength: 1,
          description: "Absolute or resolvable path to the target git repository.",
        },
      },
      required: ["workspacePath"],
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "delegate_task",
    title: "Delegate Task To A Coding CLI",
    description:
      "Run a coding task with a locally installed coding CLI (backend: claude, codex, kimi, zcode, or dsh) inside the given workspace, headless. Returns the CLI exit code, readable output tail, stderr tail, and the git snapshot (staged, unstaged, untracked, and committed deltas) produced by the run. Refuses to run when the working tree is dirty unless allowDirty=true. Paths that resolve to the same canonical Git worktree are serialized.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        backend: {
          type: "string",
          minLength: 1,
          description: "Backend name as listed by list_backends (claude, codex, kimi, zcode, dsh).",
        },
        task: {
          type: "string",
          minLength: 1,
          description: "Self-contained task to hand to the backend CLI. Include file paths and acceptance criteria; never include credentials.",
        },
        workspacePath: {
          type: "string",
          minLength: 1,
          description: "Absolute or resolvable path to the target git repository.",
        },
        allowDirty: {
          type: "boolean",
          default: false,
          description: "When false (default), refuse to run if git status --short is non-empty.",
        },
        resumeSessionId: {
          type: "string",
          minLength: 1,
          description: "Optional existing session id to resume in the backend CLI (where the backend template supports it).",
        },
        timeoutMs: {
          type: "integer",
          minimum: MIN_TIMEOUT_MS,
          maximum: MAX_TIMEOUT_MS,
          default: DEFAULT_TIMEOUT_MS,
          description: "Execution timeout in milliseconds. Defaults to 1200000 (20 minutes). Timeout terminates the entire worker process tree; POSIX workers receive SIGTERM then SIGKILL after a 10 second grace period, while Windows uses taskkill /T /F.",
        },
      },
      required: ["backend", "task", "workspacePath"],
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
];

async function loadBackends() {
  const override = process.env.CLI_AGENT_BRIDGE_BACKENDS;
  const candidates = [];
  if (override) candidates.push(path.resolve(override));
  candidates.push(path.join(path.dirname(fileURLToPath(import.meta.url)), "backends.json"));
  for (const file of candidates) {
    try {
      const raw = await readFile(file, "utf8");
      const parsed = JSON.parse(raw);
      const backends = parsed && typeof parsed === "object" && parsed.backends && typeof parsed.backends === "object"
        ? parsed.backends
        : FALLBACK_BACKENDS;
      if (Object.keys(backends).length > 0) return backends;
    } catch {
      // fall through to the next candidate
    }
  }
  return FALLBACK_BACKENDS;
}

function substituteArgs(template, task, session) {
  return template.map((arg) => {
    let out = arg;
    if (typeof session === "string" && session.trim()) out = out.replaceAll("<session>", session.trim());
    return out.replaceAll("<task>", task);
  });
}

// Bounded capture: chunks are kept in a ring buffer with a running length, so a
// runaway CLI never triggers repeated multi-megabyte string copies.
function capture() {
  let chunks = [];
  let length = 0;
  return {
    push(chunk) {
      if (typeof chunk !== "string" || chunk.length === 0) return;
      chunks.push(chunk);
      length += chunk.length;
      while (length > MAX_CAPTURE_CHARS && chunks.length > 0) {
        const dropped = chunks.shift();
        length -= dropped.length;
      }
    },
    text() { return chunks.join(""); },
  };
}

async function runCommand(command, args, options = {}) {
  const spawnOnce = (argv, shellArgs) => new Promise((resolve) => {
    if (typeof options.shouldCancel === "function" && options.shouldCancel()) {
      resolve({
        stdout: "", stderr: "", exitCode: null, timedOut: false, killed: false,
        orphanedProcesses: false, treeTerminated: true, terminationError: "",
        errorMessage: "command cancelled before spawn", spawnError: null,
      });
      return;
    }
    const manageProcessTree = options.manageProcessTree === true;
    const child = shellArgs
      ? spawn(shellArgs[0], shellArgs.slice(1), {
          cwd: options.cwd,
          env: process.env,
          detached: manageProcessTree && process.platform !== "win32",
          windowsHide: true,
          stdio: [options.stdinText === undefined ? "ignore" : "pipe", "pipe", "pipe"],
        })
      : spawn(command, argv, {
          cwd: options.cwd,
          env: process.env,
          detached: manageProcessTree && process.platform !== "win32",
          windowsHide: true,
          stdio: [options.stdinText === undefined ? "ignore" : "pipe", "pipe", "pipe"],
        });
    const stdoutBuf = capture();
    const stderrBuf = capture();
    let settled = false;
    let spawnError = null;
    let timedOut = false;
    let killed = false;
    let orphanedProcesses = false;
    let treeTerminated = true;
    let terminationError = "";
    let exitCode = null;
    let terminationPromise = null;
    const treeState = { knownPids: new Set(Number.isInteger(child.pid) ? [child.pid] : []) };
    const timeoutMs = options.timeoutMs ?? 30_000;
    const settle = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        stdout: stdoutBuf.text(),
        stderr: stderrBuf.text(),
        exitCode,
        timedOut,
        killed,
        orphanedProcesses,
        treeTerminated,
        terminationError,
        errorMessage: "",
        spawnError,
      });
    };

    const terminate = (reason) => {
      if (reason === "timeout") timedOut = true;
      if (reason === "orphaned") orphanedProcesses = true;
      if (terminationPromise) return terminationPromise;
      terminationPromise = (async () => {
        if (manageProcessTree) await signalProcessTree(child, "SIGTERM", treeState);
        else try { child.kill("SIGTERM"); } catch { /* already gone */ }
        const exited = manageProcessTree
          ? await waitForProcessTreeExit(child, KILL_GRACE_MS, treeState)
          : await waitForChildExit(child, KILL_GRACE_MS);
        if (!exited) {
          killed = true;
          if (manageProcessTree) await signalProcessTree(child, "SIGKILL", treeState);
          else try { child.kill("SIGKILL"); } catch { /* already gone */ }
          treeTerminated = manageProcessTree
            ? await waitForProcessTreeExit(child, KILL_GRACE_MS, treeState)
            : await waitForChildExit(child, KILL_GRACE_MS);
          if (!treeTerminated) {
            terminationError = "process tree still appears alive after forceful termination";
          }
        }
        settle();
      })().catch((error) => {
        treeTerminated = false;
        terminationError = error.message;
        settle();
      });
      return terminationPromise;
    };

    if (typeof options.onChild === "function" && Number.isInteger(child.pid)) {
      options.onChild({ child, terminate });
    }
    if (child.stdin) child.stdin.end(options.stdinText);

    const timer = setTimeout(() => { void terminate("timeout"); }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdoutBuf.push(chunk); });
    child.stderr.on("data", (chunk) => { stderrBuf.push(chunk); });

    child.on("error", (error) => {
      spawnError = error;
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        stdout: stdoutBuf.text(),
        stderr: stderrBuf.text(),
        exitCode: null,
        timedOut,
        killed,
        orphanedProcesses,
        treeTerminated,
        terminationError,
        errorMessage: error.message,
        spawnError,
      });
    });
    child.on("close", async (code) => {
      if (settled) return;
      exitCode = code;
      if (terminationPromise) return;
      if (manageProcessTree && await isProcessTreeAlive(child, treeState)) {
        await terminate("orphaned");
        return;
      }
      settle();
    });
  });

  const direct = await spawnOnce(args, null);
  if (process.platform !== "win32" || !direct.spawnError) return direct;
  if (typeof options.shouldCancel === "function" && options.shouldCancel()) return direct;

  // Windows shim fallback: .ps1/.cmd npm shims cannot be launched by CreateProcess,
  // so retry through the bundled PowerShell runner, which forwards every argument
  // verbatim (no cmd.exe re-interpretation).
  const runner = path.join(path.dirname(fileURLToPath(import.meta.url)), "ps1-runner.ps1");
  return await spawnOnce(null, [
    "powershell.exe",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    runner,
    command,
    ...args,
  ]);
}

function tail(text, count) {
  return text.length > count ? text.slice(-count) : text;
}

async function validateWorkspace(workspacePath) {
  if (typeof workspacePath !== "string" || !workspacePath.trim()) {
    throw new Error("workspacePath must be a non-empty string");
  }
  const resolved = path.resolve(workspacePath);
  let stats;
  try {
    stats = await stat(resolved);
  } catch (error) {
    throw new Error("workspacePath does not exist: " + resolved);
  }
  if (!stats.isDirectory()) throw new Error("workspacePath must be a directory: " + resolved);
  return resolved;
}

async function requireGitRepo(workspacePath) {
  const result = await runCommand("git", ["rev-parse", "--is-inside-work-tree"], {
    cwd: workspacePath, timeoutMs: 15_000,
  });
  if (result.exitCode !== 0 || result.stdout.trim() !== "true") {
    throw new Error("workspacePath is not a git repository: " + workspacePath);
  }
}

async function gitWorktreeRoot(workspacePath) {
  const result = await runCommand("git", ["rev-parse", "--show-toplevel"], {
    cwd: workspacePath, timeoutMs: GIT_TIMEOUT_MS,
  });
  const failure = snapshotFailure("git rev-parse --show-toplevel", result);
  if (failure || !result.stdout.trim()) {
    throw new Error("cannot identify Git worktree root: " + (failure || "empty output"));
  }
  try {
    return await realpath(result.stdout.trim());
  } catch (error) {
    throw new Error("cannot canonicalize Git worktree root: " + error.message);
  }
}

function workspaceLockKey(worktreeRoot) {
  const normalized = path.normalize(worktreeRoot);
  return "git-worktree:" + (process.platform === "win32" ? normalized.toLowerCase() : normalized);
}

function snapshotFailure(label, result) {
  if (result.timedOut) return label + " timed out";
  if (result.exitCode !== 0) return label + " failed with exit code " + String(result.exitCode);
  return "";
}

async function gitSnapshot(workspacePath) {
  const jobs = [
    ["git status --short", "status", ["status", "--short"]],
    ["git diff --stat", "diffStat", ["diff", "--stat"]],
    ["git diff --name-only -z", "diffNames", ["diff", "--name-only", "-z"]],
    ["git diff --cached --stat", "cachedDiffStat", ["diff", "--cached", "--stat"]],
    ["git diff --cached --name-only -z", "cachedDiffNames", ["diff", "--cached", "--name-only", "-z"]],
    ["git ls-files --others --exclude-standard -z", "untracked", ["ls-files", "--others", "--exclude-standard", "-z"]],
    ["git rev-parse --verify --quiet HEAD", "head", ["rev-parse", "--verify", "--quiet", "HEAD"], true],
  ];
  // Run serially: status/diff may both refresh the index, so concurrent Git
  // processes can race for .git/index.lock on the same repository.
  const results = [];
  for (const job of jobs) {
    results.push(await runCommand("git", job[2], { cwd: workspacePath, timeoutMs: GIT_TIMEOUT_MS }));
  }
  const failures = [];
  const out = {};
  results.forEach((result, i) => {
    if (jobs[i][3] === true && result.exitCode === 1 && !result.timedOut) {
      out[jobs[i][1]] = "";
      return;
    }
    const failure = snapshotFailure(jobs[i][0], result);
    if (failure) { failures.push(failure); return; }
    out[jobs[i][1]] = result.stdout;
  });
  if (failures.length > 0) {
    // Fail closed: an unreliable snapshot must never authorize a delegation.
    throw new Error("git snapshot unreliable: " + failures.join("; "));
  }
  const seen = new Set();
  const nulNames = (value) => String(value ?? "").split("\0").filter((name) => name.length > 0);
  const changedFiles = [
    ...nulNames(out.diffNames),
    ...nulNames(out.cachedDiffNames),
    ...nulNames(out.untracked),
  ].filter((f) => (seen.has(f) ? false : (seen.add(f), true)));
  const diffStat = [String(out.diffStat ?? "").trim(), String(out.cachedDiffStat ?? "").trim()]
    .filter(Boolean)
    .map((s, i) => (i === 0 ? s : s.split(/\r?\n/).map((l) => "staged: " + l).join("\n")))
    .join("\n");
  return {
    statusShort: String(out.status ?? "").trim(),
    diffStat,
    changedFiles,
    head: String(out.head ?? "").trim(),
  };
}

async function committedDelta(workspacePath, beforeHead, afterHead) {
  if (!afterHead || beforeHead === afterHead) return null;
  let range;
  if (beforeHead) {
    range = beforeHead + ".." + afterHead;
  } else {
    const emptyTree = await runCommand("git", ["mktree"], {
      cwd: workspacePath,
      timeoutMs: GIT_TIMEOUT_MS,
      stdinText: "",
    });
    const failure = snapshotFailure("git mktree", emptyTree);
    if (failure || !emptyTree.stdout.trim()) {
      throw new Error("cannot compute committed delta from unborn HEAD: " + (failure || "empty tree id missing"));
    }
    range = emptyTree.stdout.trim() + ".." + afterHead;
  }
  const log = await runCommand("git", ["log", "--oneline", beforeHead ? range : afterHead], {
    cwd: workspacePath, timeoutMs: GIT_TIMEOUT_MS,
  });
  const stat = await runCommand("git", ["diff", "--stat", range], {
    cwd: workspacePath, timeoutMs: GIT_TIMEOUT_MS,
  });
  const failures = [snapshotFailure("git log", log), snapshotFailure("git diff --stat", stat)].filter(Boolean);
  if (failures.length > 0) throw new Error("committed delta unreliable: " + failures.join("; "));
  return {
    range,
    log: String(log.stdout ?? "").trim(),
    diffStat: String(stat.stdout ?? "").trim(),
  };
}

async function listBackends() {
  const backends = await loadBackends();
  const entries = [];
  for (const [name, spec] of Object.entries(backends)) {
    if (!spec || typeof spec.command !== "string") continue;
    const check = await runCommand(spec.command, ["--version"], { timeoutMs: VERSION_CHECK_TIMEOUT_MS });
    entries.push({
      name,
      label: typeof spec.label === "string" ? spec.label : name,
      command: spec.command,
      available: check.exitCode === 0,
      experimental: Boolean(spec.experimental),
      version: check.exitCode === 0 ? tail(check.stdout, 200).trim() : null,
      error: check.exitCode === 0 ? "" : (check.errorMessage || "command not found or not executable"),
      resumeSupported: Array.isArray(spec.resumeArgs),
      notes: typeof spec.notes === "string" ? spec.notes : "",
    });
  }
  return entries;
}

// Per-workspace mutex: concurrent delegations to the same checkout are
// serialized so workers cannot interleave edits or snapshot each other.
const workspaceLocks = new Map();
const quarantinedWorkspaces = new Set();
async function withWorkspaceLock(key, fn) {
  const prev = workspaceLocks.get(key) ?? Promise.resolve();
  let release;
  const gate = new Promise((r) => { release = r; });
  const next = prev.catch(() => {}).then(() => gate);
  workspaceLocks.set(key, next);
  await prev.catch(() => {});
  try {
    return await fn();
  } finally {
    release();
    if (workspaceLocks.get(key) === next) workspaceLocks.delete(key);
  }
}

function cancelledDelegation({ backend, workspacePath, worktreeRoot, spec, before = null }) {
  return {
    ok: false,
    error: "delegation cancelled by client before the worker started",
    backend,
    workspacePath,
    worktreeRoot,
    exitCode: null,
    timedOut: false,
    killed: false,
    cancelled: true,
    treeTerminated: true,
    outputTail: "",
    stderrTail: "",
    gitBefore: before,
    git: before,
    commits: null,
    experimental: Boolean(spec.experimental),
  };
}

async function delegateTask(rawArgs, cancel) {
  const backends = await loadBackends();
  if (!rawArgs || typeof rawArgs.backend !== "string" || !rawArgs.backend.trim()) {
    throw new Error("backend must be a non-empty string");
  }
  const backend = rawArgs.backend.trim();
  const spec = backends[backend];
  if (!spec || typeof spec.command !== "string") {
    throw new Error("unknown backend \"" + backend + "\"; use list_backends to see configured backends");
  }
  if (typeof rawArgs.task !== "string" || !rawArgs.task.trim()) {
    throw new Error("task must be a non-empty string");
  }
  const workspacePath = await validateWorkspace(rawArgs.workspacePath);
  await requireGitRepo(workspacePath);
  const worktreeRoot = await gitWorktreeRoot(workspacePath);
  const lockKey = workspaceLockKey(worktreeRoot);

  return await withWorkspaceLock(lockKey, async () => {
    if (quarantinedWorkspaces.has(lockKey)) {
      return {
        ok: false,
        error: "this workspace is quarantined because a previous worker process tree could not be confirmed terminated; restart the bridge after checking for leftover processes",
        backend, workspacePath, worktreeRoot, exitCode: null, timedOut: false, killed: false, cancelled: false,
        treeTerminated: false, outputTail: "", stderrTail: "",
        gitBefore: null, git: null, commits: null,
        experimental: Boolean(spec.experimental),
      };
    }
    if (cancel && cancel.cancelled) {
      return cancelledDelegation({ backend, workspacePath, worktreeRoot, spec });
    }
    const allowDirty = rawArgs.allowDirty === true;
    const before = await gitSnapshot(worktreeRoot);
    if (cancel && cancel.cancelled) {
      return cancelledDelegation({ backend, workspacePath, worktreeRoot, spec, before });
    }
    if (!allowDirty && before.statusShort) {
      return {
        ok: false,
        error: "working tree is dirty; review current changes first or set allowDirty=true deliberately",
        backend, workspacePath, worktreeRoot, exitCode: null, timedOut: false, killed: false, cancelled: false,
        treeTerminated: true,
        outputTail: "", stderrTail: "",
        gitBefore: before, git: before, commits: null,
        experimental: Boolean(spec.experimental),
      };
    }

    let template;
    if (typeof rawArgs.resumeSessionId === "string" && rawArgs.resumeSessionId.trim() && Array.isArray(spec.resumeArgs)) {
      template = spec.resumeArgs;
    } else if (Array.isArray(spec.buildArgs)) {
      template = spec.buildArgs;
    } else {
      return {
        ok: false,
        error: "backend \"" + backend + "\" has no command template configured",
        backend, workspacePath, worktreeRoot, exitCode: null, timedOut: false, killed: false, cancelled: false,
        treeTerminated: true,
        outputTail: "", stderrTail: "",
        gitBefore: before, git: before, commits: null,
        experimental: Boolean(spec.experimental),
      };
    }

    const timeoutMs = Number.isInteger(rawArgs.timeoutMs)
      ? Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, rawArgs.timeoutMs))
      : DEFAULT_TIMEOUT_MS;
    const args = substituteArgs(template, rawArgs.task.trim(), rawArgs.resumeSessionId ?? "");

    // Cancellation can arrive while this request waits for the mutex or while
    // the read-only preflight snapshot runs. Never spawn after that signal.
    if (cancel && cancel.cancelled) {
      return cancelledDelegation({ backend, workspacePath, worktreeRoot, spec, before });
    }

    const result = await runCommand(spec.command, args, {
      cwd: workspacePath,
      timeoutMs,
      manageProcessTree: true,
      shouldCancel: () => Boolean(cancel && cancel.cancelled),
      onChild: (controller) => { if (cancel) cancel.controller = controller; },
    });
    if (!result.treeTerminated) quarantinedWorkspaces.add(lockKey);
    const after = result.treeTerminated ? await gitSnapshot(worktreeRoot) : before;
    const commits = result.treeTerminated ? await committedDelta(worktreeRoot, before.head, after.head) : null;
    let error = "";
    if (!result.treeTerminated) {
      error = "backend process tree could not be confirmed terminated; the workspace is quarantined until the bridge restarts";
    } else if (cancel && cancel.cancelled) {
      error = "delegation cancelled by client";
    } else if (result.timedOut) {
      error = "backend \"" + backend + "\" timed out after " + timeoutMs + " ms" + (result.killed ? " and was force-killed" : "");
    } else if (result.orphanedProcesses) {
      error = "backend exited while descendant processes were still running; the bridge terminated the remaining process tree";
    } else if (result.exitCode !== 0) {
      error = "backend \"" + backend + "\" exited with code " + String(result.exitCode);
    }

    return {
      ok: !error,
      error,
      backend,
      workspacePath,
      worktreeRoot,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      killed: result.killed,
      cancelled: Boolean(cancel && cancel.cancelled),
      orphanedProcesses: result.orphanedProcesses,
      treeTerminated: result.treeTerminated,
      terminationError: result.terminationError,
      outputTail: tail(result.stdout, RAW_TAIL_CHARS),
      stderrTail: tail(result.stderr, RAW_TAIL_CHARS),
      gitBefore: before,
      git: after,
      commits,
      experimental: Boolean(spec.experimental),
    };
  });
}

function textResult(header, obj) {
  const lines = ["# " + header, ""];
  for (const [key, value] of Object.entries(obj)) {
    if (["outputTail", "stderrTail", "git", "gitBefore", "commits"].includes(key)) continue;
    lines.push("- " + key + ": " + String(value ?? ""));
  }
  const gitBlock = (label, git) => {
    if (!git) return;
    lines.push("", "## " + label + " git status --short", "", "~~~text", git.statusShort || "(clean)", "~~~");
    lines.push("", "## " + label + " git diff stat", "", "~~~text", git.diffStat || "(empty)", "~~~");
    lines.push("", "## " + label + " changed files", "", "~~~text", (git.changedFiles ?? []).join("\n") || "(none)", "~~~");
    lines.push("", "## " + label + " HEAD", "", "~~~text", git.head || "(unborn)", "~~~");
  };
  gitBlock("before", obj.gitBefore);
  gitBlock("after", obj.git);
  if (obj.commits) {
    lines.push("", "## commits made by the worker", "", "~~~text", obj.commits.log || "(none)", "~~~");
    lines.push("", "## commit diff stat", "", "~~~text", obj.commits.diffStat || "(empty)", "~~~");
  }
  if (obj.outputTail) lines.push("", "## output tail", "", "~~~text", obj.outputTail, "~~~");
  if (obj.stderrTail) lines.push("", "## stderr tail", "", "~~~text", obj.stderrTail, "~~~");
  if (obj.error) lines.push("", "## error", "", obj.error);
  return lines.join("\n");
}

function jsonRpcResult(id, result) { return { jsonrpc: "2.0", id, result }; }
function jsonRpcError(id, code, message) { return { jsonrpc: "2.0", id, error: { code, message } }; }

// In-flight delegate_task requests, keyed by JSON-RPC request id, so a
// notifications/cancelled can terminate the worker process.
const activeRequests = new Map();

async function handleMessage(message) {
  if (!message || typeof message !== "object" || message.jsonrpc !== "2.0") {
    return jsonRpcError(null, -32600, "Invalid JSON-RPC request");
  }
  if (message.method === "notifications/cancelled") {
    const requestId = message.params?.requestId ?? message.params?.id;
    const entry = activeRequests.get(requestId);
    if (entry && entry.cancel) {
      entry.cancel.cancelled = true;
      if (entry.cancel.controller) {
        void entry.cancel.controller.terminate("cancelled");
      }
    }
    return null;
  }
  if (message.id === undefined) return null; // other notification

  try {
    switch (message.method) {
      case "initialize":
        return jsonRpcResult(message.id, {
          // Negotiate honestly: this server implements exactly one protocol
          // version, so it always reports that version rather than echoing an
          // unsupported client request.
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: SERVER_NAME, title: "CLI Agent Bridge", version: SERVER_VERSION },
          instructions:
            "Delegate coding tasks to locally installed coding CLIs. Prefer workspace_status first, then delegate_task, then review the returned git snapshot. Never put credentials in task text.",
        });
      case "ping":
        return jsonRpcResult(message.id, {});
      case "tools/list":
        return jsonRpcResult(message.id, { tools: TOOLS });
      case "tools/call": {
        const params = message.params ?? {};
        if (typeof params.name !== "string") return jsonRpcError(message.id, -32602, "tools/call requires params.name");
        const args = params.arguments ?? {};
        if (params.name === "list_backends") {
          const entries = await listBackends();
          const lines = ["# Delegation Backends", ""];
          for (const e of entries) {
            lines.push("- " + e.name + " (" + e.label + "): " + (e.available ? "available" : "unavailable") + (e.experimental ? " [experimental]" : ""));
            if (e.version) lines.push("  version: " + e.version);
            if (e.error) lines.push("  error: " + e.error);
            if (e.notes) lines.push("  note: " + e.notes);
          }
          return jsonRpcResult(message.id, {
            content: [{ type: "text", text: lines.join("\n") }],
            structuredContent: { backends: entries },
          });
        }
        if (params.name === "workspace_status") {
          const workspacePath = await validateWorkspace(args.workspacePath);
          await requireGitRepo(workspacePath);
          const worktreeRoot = await gitWorktreeRoot(workspacePath);
          const git = await withWorkspaceLock(workspaceLockKey(worktreeRoot), () => gitSnapshot(worktreeRoot));
          return jsonRpcResult(message.id, {
            content: [{ type: "text", text: textResult("Workspace Status", { workspacePath, git }) }],
            structuredContent: { ok: true, workspacePath, worktreeRoot, git },
          });
        }
        if (params.name === "delegate_task") {
          const cancel = { controller: null, cancelled: false };
          const entry = { cancel };
          activeRequests.set(message.id, entry);
          try {
            const out = await delegateTask(args, cancel);
            return jsonRpcResult(message.id, {
              content: [{ type: "text", text: textResult("Delegated Task Result", out) }],
              structuredContent: out,
              isError: !out.ok,
            });
          } finally {
            if (activeRequests.get(message.id) === entry) activeRequests.delete(message.id);
          }
        }
        return jsonRpcError(message.id, -32602, "Unknown tool: " + params.name);
      }
      default:
        return jsonRpcError(message.id, -32601, "Method not found: " + String(message.method));
    }
  } catch (error) {
    return jsonRpcError(message.id, -32603, error.message);
  }
}

function startStdioServer({ stdin = process.stdin, stdout = process.stdout } = {}) {
  stdin.setEncoding("utf8");
  let buffer = "";
  stdin.on("data", (chunk) => {
    buffer += chunk;
    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      newlineIndex = buffer.indexOf("\n");
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        stdout.write(JSON.stringify(jsonRpcError(null, -32700, "Parse error")) + "\n");
        continue;
      }
      handleMessage(message).then((response) => {
        if (response) stdout.write(JSON.stringify(response) + "\n");
      }).catch((error) => {
        stdout.write(JSON.stringify(jsonRpcError(null, -32603, error.message)) + "\n");
      });
    }
  });
}

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  startStdioServer();
}
