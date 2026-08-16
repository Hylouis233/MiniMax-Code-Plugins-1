#!/usr/bin/env node
// cli-agent-bridge: a dependency-free stdio MCP server that lets MiniMax Code
// delegate coding tasks to locally installed coding CLIs (Claude Code, Codex,
// Kimi Code, ZCode, DSH). The server makes no network calls of its own; each
// backend CLI runs headless with the local user authentication.
//
// License: MIT. See NOTICE for upstream credits.

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, readFile, realpath, stat, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { initializeProcessTree, isProcessTreeAlive, refreshProcessTree, signalProcessTree, waitForChildExit, waitForProcessTreeExit } from "./process-tree.mjs";
import {
  acquireGitWorkspaceLock,
  WORKSPACE_LOCK_REF_PREFIX,
  WorkspaceLockCancelledError,
  WorkspaceLockDeadlineError,
} from "./workspace-lock.mjs";

const SERVER_NAME = "cli-agent-bridge";
const SERVER_VERSION = "0.1.0";
const PROTOCOL_VERSION = "2025-06-18";
const DEFAULT_TIMEOUT_MS = 1_200_000;
const MIN_TIMEOUT_MS = 5_000;
const MAX_TIMEOUT_MS = 3_600_000;
const VERSION_CHECK_TIMEOUT_MS = 15_000;
const GIT_TIMEOUT_MS = 30_000;
const TEST_KILL_GRACE_MS = process.env.NODE_ENV === "test"
  ? Number(process.env.CLI_AGENT_BRIDGE_TEST_KILL_GRACE_MS)
  : NaN;
const KILL_GRACE_MS = Number.isInteger(TEST_KILL_GRACE_MS) && TEST_KILL_GRACE_MS >= 50
  ? Math.min(10_000, TEST_KILL_GRACE_MS)
  : 10_000;
const MAX_CAPTURE_CHARS = 5_000_000;
const RAW_TAIL_CHARS = 60_000;
function currentUserLockScope() {
  let identity;
  try {
    const user = os.userInfo();
    identity = Number.isInteger(user.uid) && user.uid >= 0
      ? process.platform + ":uid:" + String(user.uid)
      : process.platform + ":" + user.username + ":" + user.homedir;
  } catch {
    identity = process.platform + ":" + (process.env.USERNAME ?? process.env.USER ?? os.homedir());
  }
  return createHash("sha256").update(identity).digest("hex").slice(0, 20);
}

const WORKSPACE_LOCK_ROOT = path.join(
  os.tmpdir(), "minimax-cli-agent-bridge-locks-" + currentUserLockScope(),
);

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
      "Return git status, diff stat, and changed files for a workspace before delegating work. Does not change the worktree, but acquires and releases hidden Git-ref lock metadata while snapshotting.",
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
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: "delegate_task",
    title: "Delegate Task To A Coding CLI",
    description:
      "Run a coding task with a locally installed coding CLI (backend: claude, codex, kimi, zcode, or dsh) inside the given workspace, headless. Returns the CLI exit code, readable output tail, stderr tail, and the git snapshot (staged, unstaged, untracked, and committed deltas) produced by the run. Refuses to run when the working tree is dirty unless allowDirty=true. Paths that resolve to the same canonical Git worktree are serialized across bridge processes.",
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
          description: "Overall deadline in milliseconds, including workspace lock acquisition, preflight Git checks, the worker, and post-run snapshots. Defaults to 1200000 (20 minutes). Confirming safe process-tree termination may extend beyond the deadline by the kill grace period.",
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
  let truncated = false;
  return {
    push(chunk) {
      if (typeof chunk !== "string" || chunk.length === 0) return;
      chunks.push(chunk);
      length += chunk.length;
      while (length > MAX_CAPTURE_CHARS && chunks.length > 0) {
        const dropped = chunks.shift();
        length -= dropped.length;
        truncated = true;
      }
    },
    text() { return chunks.join(""); },
    truncated() { return truncated; },
  };
}

async function runCommand(command, args, options = {}) {
  const spawnOnce = (argv, shellArgs) => new Promise((resolve) => {
    if (typeof options.shouldCancel === "function" && options.shouldCancel()) {
      resolve({
        stdout: "", stderr: "", exitCode: null, timedOut: false, killed: false,
        orphanedProcesses: false, treeTerminated: true, terminationError: "",
        errorMessage: "command cancelled before spawn", spawnError: null,
        stdoutTruncated: false, stderrTruncated: false,
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
    const treeState = {
      knownPids: new Set(Number.isInteger(child.pid) ? [child.pid] : []),
      knownStarts: new Map(),
    };
    let treeRefreshPromise = null;
    let treeRefreshTimer = null;
    const refreshTree = () => {
      if (!manageProcessTree) return Promise.resolve();
      if (treeRefreshPromise) return treeRefreshPromise;
      treeRefreshPromise = refreshProcessTree(child, treeState)
        .catch((error) => { terminationError ||= "process-tree inspection failed: " + error.message; })
        .finally(() => { treeRefreshPromise = null; });
      return treeRefreshPromise;
    };
    const timeoutMs = options.timeoutMs ?? 30_000;
    const killGraceMs = options.killGraceMs ?? KILL_GRACE_MS;
    const settle = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (treeRefreshTimer) clearInterval(treeRefreshTimer);
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
        stdoutTruncated: stdoutBuf.truncated(),
        stderrTruncated: stderrBuf.truncated(),
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
          ? await waitForProcessTreeExit(child, killGraceMs, treeState)
          : await waitForChildExit(child, killGraceMs);
        if (!exited) {
          killed = true;
          if (manageProcessTree) await signalProcessTree(child, "SIGKILL", treeState);
          else try { child.kill("SIGKILL"); } catch { /* already gone */ }
          treeTerminated = manageProcessTree
            ? await waitForProcessTreeExit(child, killGraceMs, treeState, { ignoreZombieOnly: true })
            : await waitForChildExit(child, killGraceMs);
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
    if (manageProcessTree) {
      // Capture the root's start identity immediately so termination can later
      // detect a reused PID. Windows performs this one-shot inspection only;
      // POSIX keeps polling to track descendants that escape the process group.
      // Linux follows only tracked /proc task children, so a short interval
      // catches session escapes without scanning the host process table.
      treeState.initialRefresh = initializeProcessTree(child, treeState).catch((error) => {
        terminationError ||= "process-tree initialization failed: " + error.message;
      });
      if (process.platform !== "win32") {
        const refreshIntervalMs = process.platform === "linux" ? 25 : 250;
        treeRefreshTimer = setInterval(() => { void refreshTree(); }, refreshIntervalMs);
        treeRefreshTimer.unref?.();
      }
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
      if (treeRefreshTimer) clearInterval(treeRefreshTimer);
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
        stdoutTruncated: stdoutBuf.truncated(),
        stderrTruncated: stderrBuf.truncated(),
      });
    });
    child.on("close", async (code) => {
      if (settled) return;
      exitCode = code;
      if (terminationPromise) return;
      if (manageProcessTree) {
        let stillAlive = false;
        try {
          stillAlive = await isProcessTreeAlive(child, treeState);
        } catch (error) {
          // An inspection failure (for example WMI unavailable on Windows) must
          // settle through the fail-closed path, not surface as an unhandled
          // rejection that could take down the whole server.
          treeTerminated = false;
          terminationError = "process-tree inspection failed: " + error.message;
          settle();
          return;
        }
        if (stillAlive) {
          await terminate("orphaned");
          return;
        }
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

async function requireGitRepo(workspacePath, options = {}) {
  const result = await runGitCommand(["rev-parse", "--is-inside-work-tree"], {
    cwd: workspacePath, timeoutMs: 15_000, ...options,
  });
  if (result.exitCode !== 0 || result.stdout.trim() !== "true") {
    throw new Error("workspacePath is not a git repository: " + workspacePath);
  }
}

async function gitWorktreeRoot(workspacePath, options = {}) {
  const result = await runGitCommand(["rev-parse", "--show-toplevel"], {
    cwd: workspacePath, ...options,
  });
  const failure = snapshotFailure("git rev-parse --show-toplevel", result);
  // Strip only Git's trailing line terminator: a legitimate directory name can
  // end in whitespace, which .trim() would silently delete.
  const output = result.stdout.replace(/\r?\n$/u, "");
  if (failure || !output) {
    throw new Error("cannot identify Git worktree root: " + (failure || "empty output"));
  }
  try {
    return await realpath(output);
  } catch (error) {
    throw new Error("cannot canonicalize Git worktree root: " + error.message);
  }
}

async function gitCommonDirectory(workspacePath, options = {}) {
  const result = await runGitCommand(["rev-parse", "--git-common-dir"], {
    cwd: workspacePath, ...options,
  });
  const failure = snapshotFailure("git rev-parse --git-common-dir", result);
  if (failure || !result.stdout.trim()) {
    throw new Error("cannot identify Git common directory: " + (failure || "empty output"));
  }
  try {
    return await realpath(path.resolve(workspacePath, result.stdout.trim()));
  } catch (error) {
    throw new Error("cannot canonicalize Git common directory: " + error.message);
  }
}

function repositoryLockKey(gitCommonDir) {
  const normalized = path.normalize(gitCommonDir);
  return "git-common-dir:" + (process.platform === "win32" ? normalized.toLowerCase() : normalized);
}

function snapshotFailure(label, result) {
  if (result.timedOut) return label + " timed out";
  if (result.stdoutTruncated || result.stderrTruncated) {
    return label + " exceeded the " + String(MAX_CAPTURE_CHARS) + " character capture limit";
  }
  if (result.exitCode !== 0) return label + " failed with exit code " + String(result.exitCode);
  return "";
}

class OperationCancelledError extends Error {}
class DeadlineExceededError extends Error {}

async function runGitCommand(args, {
  cwd,
  cancel = null,
  deadline = null,
  stdinText,
  timeoutMs = GIT_TIMEOUT_MS,
} = {}) {
  if (cancel?.cancelled) throw new OperationCancelledError("operation cancelled by client");
  const remaining = deadline === null ? GIT_TIMEOUT_MS : deadline - Date.now();
  if (remaining <= 0) throw new DeadlineExceededError("delegation deadline exceeded");
  let controller = null;
  const result = await runCommand("git", args, {
    cwd,
    stdinText,
    timeoutMs: Math.max(1, Math.min(timeoutMs, remaining)),
    killGraceMs: 1_000,
    shouldCancel: () => Boolean(cancel?.cancelled),
    onChild: (current) => {
      controller = current;
      if (cancel) cancel.controller = current;
    },
  });
  if (cancel?.controller === controller) cancel.controller = null;
  if (cancel?.cancelled) throw new OperationCancelledError("operation cancelled by client");
  if (deadline !== null && result.timedOut && Date.now() >= deadline) {
    throw new DeadlineExceededError("delegation deadline exceeded");
  }
  return result;
}

// A lease owner counts as concurrently active while its heartbeat is fresh
// and its worker has not finished; linked worktrees share one ref store, so
// another worktree's delegation is visible here and can interleave commits.
const CONCURRENT_LEASE_STALE_MS = 30_000;

async function gitSnapshot(worktreeRoot, options = {}) {
  const ownLockRef = typeof options.ownLockRef === "string" ? options.ownLockRef : null;
  const jobs = [
    ["git status --short", "status", ["status", "--short"]],
    ["git diff --stat", "diffStat", ["diff", "--stat"]],
    ["git diff --name-only -z", "diffNames", ["diff", "--name-only", "-z"]],
    ["git diff --cached --stat", "cachedDiffStat", ["diff", "--cached", "--stat"]],
    ["git diff --cached --name-only -z", "cachedDiffNames", ["diff", "--cached", "--name-only", "-z"]],
    ["git ls-files --others --exclude-standard -z", "untracked", ["ls-files", "--others", "--exclude-standard", "-z"]],
    ["git rev-parse --verify --quiet HEAD", "head", ["rev-parse", "--verify", "--quiet", "HEAD"], true],
    ["git for-each-ref", "refs", ["for-each-ref", "--format=%(refname)%09%(objectname)", "refs"]],
  ];
  // Run serially: status/diff may both refresh the index, so concurrent Git
  // processes can race for .git/index.lock on the same repository.
  const results = [];
  for (const job of jobs) {
    results.push(await runGitCommand(job[2], { cwd: worktreeRoot, ...options }));
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
  const refs = {};
  const lockRefs = [];
  for (const line of String(out.refs ?? "").split(/\r?\n/u)) {
    if (!line) continue;
    const separator = line.indexOf("\t");
    if (separator <= 0) continue;
    const ref = line.slice(0, separator);
    if (ref.startsWith(WORKSPACE_LOCK_REF_PREFIX)) {
      if (ref !== ownLockRef) lockRefs.push(line.slice(separator + 1));
      continue;
    }
    refs[ref] = line.slice(separator + 1);
  }
  // Linked worktrees serialize per worktree but share repository refs, so a
  // commit from a parallel delegation can land between our two snapshots.
  // Detection combines two signals: leases that are active right now, and the
  // persistent run-history records completed delegations leave behind, whose
  // [acquiredAt, endedAt] window is checked against this snapshot's window.
  const windowStart = Number.isFinite(options.concurrencyWindowStart)
    ? options.concurrencyWindowStart
    : Number.POSITIVE_INFINITY;
  let concurrentDelegations = 0;
  for (const oid of lockRefs) {
    const blob = await runGitCommand(["cat-file", "blob", oid], { cwd: worktreeRoot, ...options });
    if (blob.exitCode !== 0) continue; // unreadable owner blob: ignore for disclosure
    try {
      const record = JSON.parse(blob.stdout);
      if (Number.isFinite(record?.endedAt)) {
        const acquiredAt = Number.isFinite(record.acquiredAt) ? record.acquiredAt : record.endedAt;
        if (acquiredAt <= Date.now() && record.endedAt >= windowStart) {
          concurrentDelegations += 1;
        }
        continue;
      }
      const active = record &&
        (record.workerState === "starting" || record.workerState === "running") &&
        Number.isFinite(record.heartbeatAt) &&
        Date.now() - record.heartbeatAt < CONCURRENT_LEASE_STALE_MS;
      if (active) concurrentDelegations += 1;
    } catch { /* malformed owner blob: ignore for disclosure */ }
  }
  return {
    statusShort: String(out.status ?? "").trim(),
    diffStat,
    changedFiles,
    head: String(out.head ?? "").trim(),
    refs,
    concurrentDelegations,
  };
}

// Peel an object id to a commit id. Returns null for blob/tree objects (legal
// ref targets) and for tags that do not dereference to a commit.
async function peelCommitish(worktreeRoot, oid, cache = new Map(), options = {}) {
  if (!oid || !/^[0-9a-f]{40,64}$/u.test(oid)) return null;
  if (cache.has(oid)) return cache.get(oid);
  const typeResult = await runGitCommand(["cat-file", "-t", oid], {
    cwd: worktreeRoot, ...options,
  });
  let commit = null;
  if (typeResult.exitCode === 0) {
    const type = typeResult.stdout.trim();
    if (type === "commit") {
      commit = oid;
    } else if (type === "tag") {
      const peeled = await runGitCommand(
        ["rev-parse", "--verify", "--quiet", oid + "^{commit}"],
        { cwd: worktreeRoot, ...options },
      );
      if (peeled.exitCode === 0 && peeled.stdout.trim()) commit = peeled.stdout.trim();
    }
  }
  cache.set(oid, commit);
  return commit;
}

async function committedDelta(worktreeRoot, before, after, options = {}) {
  const refNames = new Set([...Object.keys(before.refs ?? {}), ...Object.keys(after.refs ?? {})]);
  const refsChanged = [...refNames].sort().flatMap((ref) => {
    const beforeOid = before.refs?.[ref] ?? "";
    const afterOid = after.refs?.[ref] ?? "";
    return beforeOid === afterOid ? [] : [{ ref, before: beforeOid, after: afterOid }];
  });
  if (before.head === after.head && refsChanged.length === 0) return null;

  let emptyTreeId = "";
  async function emptyTree() {
    if (emptyTreeId) return emptyTreeId;
    const emptyTree = await runGitCommand(["mktree"], {
      cwd: worktreeRoot,
      ...options,
      stdinText: "",
    });
    const failure = snapshotFailure("git mktree", emptyTree);
    if (failure || !emptyTree.stdout.trim()) {
      throw new Error("cannot compute committed delta from unborn HEAD: " + (failure || "empty tree id missing"));
    }
    emptyTreeId = emptyTree.stdout.trim();
    return emptyTreeId;
  }

  const cache = new Map();
  // Baseline: every commit that already existed before the worker ran. New
  // commits are attributed to the worker only when they are reachable from the
  // after-state but from none of these, so merely checking out an existing
  // divergent branch is never reported as "commits made by the worker".
  const baselineCommits = [];
  async function addBaseline(oid) {
    const commit = await peelCommitish(worktreeRoot, oid, cache, options);
    if (commit && !baselineCommits.includes(commit)) baselineCommits.push(commit);
  }
  await addBaseline(before.head);
  for (const oid of new Set([
    ...Object.values(before.refs ?? {}),
    ...refsChanged.map((change) => change.before),
  ])) {
    await addBaseline(oid);
  }

  // A worker committing on the checked-out branch moves HEAD and its branch ref
  // across the same object pair; deduplicate by that pair so the log, diff, and
  // commit count are emitted once with both labels.
  const targets = [];
  const targetIndex = new Map();
  function addTarget(label, beforeOid, afterOid) {
    const key = (beforeOid || "") + "\0" + (afterOid || "");
    const existing = targetIndex.get(key);
    if (existing !== undefined) {
      targets[existing].labels.push(label);
      return;
    }
    targetIndex.set(key, targets.length);
    targets.push({ labels: [label], beforeOid, afterOid });
  }
  addTarget("HEAD", before.head, after.head);
  for (const change of refsChanged) {
    addTarget(change.ref, change.before, change.after);
  }

  const logs = [];
  const stats = [];
  let newCommitCount = 0;
  for (const { labels, beforeOid, afterOid } of targets) {
    if (!afterOid || beforeOid === afterOid) continue;
    const label = labels.join(", ");
    const target = await peelCommitish(worktreeRoot, afterOid, cache, options);
    if (!target) {
      // Legal non-commit ref (for example a tag pointing at a blob): report the
      // movement, never build a commit range from it.
      logs.push(label + " -> " + afterOid + " (non-commit object; no commit log)");
      stats.push(label + ": (non-commit ref target)");
      continue;
    }
    // Everything reachable from the pre-delegation state is excluded, so only
    // commits the worker actually created remain attributed to it.
    const exclusions = baselineCommits;
    const revList = await runGitCommand(
      exclusions.length > 0
        ? ["log", "--oneline", target, "--stdin"]
        : ["log", "--oneline", target],
      {
        cwd: worktreeRoot,
        ...options,
        stdinText: exclusions.length > 0
          ? exclusions.map((commit) => "^" + commit).join("\n") + "\n"
          : undefined,
      },
    );
    const revListFailure = snapshotFailure("git log " + target, revList);
    if (revListFailure) throw new Error("committed delta unreliable: " + revListFailure);
    const newCommits = String(revList.stdout ?? "").trim();
    if (!newCommits) {
      const note = labels.includes("HEAD") && beforeOid
        ? "HEAD moved from " + beforeOid.slice(0, 12) + " to " + afterOid.slice(0, 12) +
          " without creating commits (branch checkout or reset); the target history predates the delegation"
        : label + " now points to pre-existing history; no new commits";
      logs.push(label + ": " + note);
      stats.push(label + ": (no new commits)");
      continue;
    }
    newCommitCount += newCommits.split("\n").length;
    // For a ref that did not exist before, diff from its best common ancestor
    // with the pre-delegation state, not from the original HEAD: a new branch
    // created from another divergent branch would otherwise attribute every
    // pre-existing difference between those branches to the worker.
    let base;
    if (beforeOid) {
      base = beforeOid;
    } else if (baselineCommits.length > 0) {
      const mergeBase = await runGitCommand(
        ["merge-base", target, ...baselineCommits.slice(0, 256)],
        { cwd: worktreeRoot, ...options },
      );
      base = mergeBase.exitCode === 0 && mergeBase.stdout.trim()
        ? mergeBase.stdout.trim()
        : await emptyTree();
    } else {
      base = before.head || await emptyTree();
    }
    const range = base + ".." + target;
    const diff = await runGitCommand(["diff", "--stat", range], {
      cwd: worktreeRoot, ...options,
    });
    const diffFailure = snapshotFailure("git diff --stat " + range, diff);
    if (diffFailure) throw new Error("committed delta unreliable: " + diffFailure);
    logs.push(label + " [" + range + "]\n" + newCommits);
    stats.push(label + " [" + range + "]\n" + (String(diff.stdout ?? "").trim() || "(empty)"));
  }
  return {
    range: logs.length > 0 ? "attribution: new commits only (pre-existing history excluded)" : "",
    refsChanged,
    newCommitCount,
    log: logs.join("\n\n") || "(no ref or HEAD movements)",
    diffStat: stats.join("\n\n") || "(empty)",
  };
}

async function listBackends(cancel = null) {
  const backends = await loadBackends();
  const entries = [];
  for (const [name, spec] of Object.entries(backends)) {
    // A hung `--version` probe must not pin the request: the client can cancel
    // the discovery call, terminating the current probe and skipping the rest.
    if (cancel?.cancelled) break;
    if (!spec || typeof spec.command !== "string") continue;
    const check = await runCommand(spec.command, ["--version"], {
      timeoutMs: VERSION_CHECK_TIMEOUT_MS,
      shouldCancel: () => Boolean(cancel?.cancelled),
      onChild: (controller) => {
        if (cancel) cancel.controller = controller;
      },
    });
    if (cancel?.controller) cancel.controller = null;
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

function workspaceQuarantinePath(key) {
  const digest = createHash("sha256").update(key).digest("hex");
  return path.join(WORKSPACE_LOCK_ROOT, digest + ".quarantine");
}

async function readWorkspaceQuarantine(key) {
  const quarantinePath = workspaceQuarantinePath(key);
  try {
    const raw = await readFile(quarantinePath, "utf8");
    let details;
    try { details = JSON.parse(raw); } catch { details = { error: "invalid quarantine record" }; }
    return { quarantinePath, details };
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

// Quarantined leases become reclaimable through this check: the operator
// deliberately removed the shared marker after inspecting leftover processes.
async function quarantineFileAbsent(key) {
  try {
    return (await readWorkspaceQuarantine(key)) === null;
  } catch {
    return false;
  }
}

async function markWorkspaceQuarantined(key, details) {
  await mkdir(WORKSPACE_LOCK_ROOT, { recursive: true, mode: 0o700 });
  const quarantinePath = workspaceQuarantinePath(key);
  const token = process.pid + "-" + randomUUID();
  const temporaryPath = quarantinePath + ".owner-" + token;
  await writeFile(temporaryPath, JSON.stringify({
    ...details,
    serverPid: process.pid,
    processIdentity: await cachedProcessStartIdentity(process.pid),
    quarantinedAt: new Date().toISOString(),
  }), { flag: "wx", mode: 0o600 });
  try {
    try { await link(temporaryPath, quarantinePath); }
    catch (error) { if (error.code !== "EEXIST") throw error; }
  } finally {
    try { await unlink(temporaryPath); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  return quarantinePath;
}

let linuxBootIdPromise = null;
const processIdentityCache = new Map();
async function processStartIdentity(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (process.platform === "linux") {
    try {
      linuxBootIdPromise ??= readFile("/proc/sys/kernel/random/boot_id", "utf8")
        .then((value) => value.trim());
      const [bootId, raw] = await Promise.all([
        linuxBootIdPromise,
        readFile("/proc/" + String(pid) + "/stat", "utf8"),
      ]);
      const close = raw.lastIndexOf(")");
      if (close < 0) return null;
      const fields = raw.slice(close + 1).trim().split(/\s+/u);
      if (["Z", "X", "x"].includes(fields[0])) return null;
      return "linux:" + bootId + ":" + fields[19]; // field 22: start time since boot
    } catch (error) {
      if (error.code === "ENOENT") return null;
    }
  } else if (process.platform === "win32") {
    const script = "$p=Get-CimInstance Win32_Process -Filter 'ProcessId = " + String(pid) +
      "'; if ($null -ne $p) { $p.CreationDate.ToUniversalTime().Ticks }";
    const result = await runCommand("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-Command", script,
    ], { timeoutMs: 5_000 });
    if (result.exitCode === 0 && result.stdout.trim()) {
      return "windows:" + result.stdout.trim();
    }
  } else {
    const result = await runCommand("ps", ["-o", "lstart=", "-p", String(pid)], {
      timeoutMs: 5_000,
    });
    if (result.exitCode === 0 && result.stdout.trim()) {
      return process.platform + ":" + result.stdout.trim();
    }
  }
  return null;
}

async function cachedProcessStartIdentity(pid) {
  const cached = processIdentityCache.get(pid);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const value = await processStartIdentity(pid);
  processIdentityCache.set(pid, { value, expiresAt: Date.now() + 1_000 });
  return value;
}

// The in-memory queue preserves FIFO order within this server. A Git-ref CAS
// lease extends the same canonical-worktree mutex across independent stdio
// server processes without a read-then-unlink stale-owner race.
const workspaceLocks = new Map();
const quarantinedWorkspaces = new Set();
async function withWorkspaceLock(key, worktreeRoot, fn, {
  cancel = null,
  deadline = null,
  onCancelled = null,
  onDeadline = null,
  isUnavailable = null,
  onUnavailable = null,
  operatorCleared = null,
} = {}) {
  const prev = workspaceLocks.get(key) ?? Promise.resolve();
  const prevDone = prev.catch(() => {});
  let release;
  const gate = new Promise((r) => { release = r; });
  const next = prevDone.then(() => gate);
  workspaceLocks.set(key, next);
  let deadlineTimer = null;
  const waiters = [prevDone.then(() => "acquired")];
  if (cancel) waiters.push(cancel.promise.then(() => "cancelled"));
  if (deadline !== null) {
    waiters.push(new Promise((resolve) => {
      deadlineTimer = setTimeout(() => resolve("deadline"), Math.max(0, deadline - Date.now()));
    }));
  }
  const localResult = await Promise.race(waiters);
  clearTimeout(deadlineTimer);
  if (localResult !== "acquired") {
    release();
    // Keep the already-resolved gate chained behind its predecessor until the
    // predecessor releases. Deleting the map entry now would let a third
    // request bypass the still-running first holder.
    void next.finally(() => {
      if (workspaceLocks.get(key) === next) workspaceLocks.delete(key);
    });
    if (localResult === "cancelled") {
      return typeof onCancelled === "function" ? onCancelled() : undefined;
    }
    return typeof onDeadline === "function" ? onDeadline() : undefined;
  }
  let lease = null;
  try {
    if (typeof isUnavailable === "function" && await isUnavailable()) {
      return typeof onUnavailable === "function" ? onUnavailable() : undefined;
    }
    try {
      lease = await acquireGitWorkspaceLock({ cwd: worktreeRoot, key, cancel, deadline, operatorCleared });
    } catch (error) {
      if (error instanceof WorkspaceLockCancelledError) {
        return typeof onCancelled === "function" ? onCancelled() : undefined;
      }
      if (error instanceof WorkspaceLockDeadlineError) {
        return typeof onDeadline === "function" ? onDeadline() : undefined;
      }
      throw error;
    }
    return await fn(lease);
  } finally {
    try {
      if (lease) {
        try {
          await lease.release();
        } catch (error) {
          // Register the exact leftover OID before releasing the local FIFO
          // gate. This permits only this server's next local holder to repair
          // a failed delete, including starting/running owner records.
          lease.allowLocalRecovery();
          throw error;
        }
      }
    } finally {
      release();
      if (workspaceLocks.get(key) === next) workspaceLocks.delete(key);
    }
  }
}

function createCancellation() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  const listeners = new Set();
  return {
    controller: null,
    cancelled: false,
    promise,
    subscribe(listener) {
      if (this.cancelled) {
        queueMicrotask(listener);
        return () => {};
      }
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    cancel() {
      if (this.cancelled) return;
      this.cancelled = true;
      resolve();
      for (const listener of listeners) listener();
      listeners.clear();
      if (this.controller) void this.controller.terminate("cancelled");
    },
  };
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

function lockDeadlineDelegation({
  backend,
  workspacePath,
  worktreeRoot,
  spec,
  error = "delegation timed out while waiting for the workspace lock; the worker never started",
}) {
  return {
    ok: false,
    error,
    backend,
    workspacePath,
    worktreeRoot,
    exitCode: null,
    timedOut: true,
    killed: false,
    cancelled: false,
    treeTerminated: true,
    outputTail: "",
    stderrTail: "",
    gitBefore: null,
    git: null,
    commits: null,
    experimental: Boolean(spec.experimental),
  };
}

function quarantinedDelegation({ backend, workspacePath, worktreeRoot, spec }, sharedQuarantine = null) {
  return {
    ok: false,
    error: "this workspace is quarantined because a previous worker process tree could not be confirmed terminated; inspect leftover processes, then remove the reported quarantine file deliberately",
    backend, workspacePath, worktreeRoot, exitCode: null, timedOut: false, killed: false, cancelled: false,
    treeTerminated: false, outputTail: "", stderrTail: "",
    gitBefore: null, git: null, commits: null,
    quarantinePath: sharedQuarantine?.quarantinePath ?? "",
    quarantine: sharedQuarantine?.details ?? null,
    experimental: Boolean(spec.experimental),
  };
}

function cancelledWorkspaceStatus(id, { workspacePath = "", worktreeRoot = "" } = {}) {
  const out = {
    ok: false,
    error: "workspace status cancelled by client",
    cancelled: true,
    workspacePath,
    worktreeRoot,
    git: null,
  };
  return jsonRpcResult(id, {
    content: [{ type: "text", text: textResult("Workspace Status", out) }],
    structuredContent: out,
    isError: true,
  });
}

function quarantinedWorkspaceStatus(id, { workspacePath = "", worktreeRoot = "" } = {}, sharedQuarantine = null) {
  const out = {
    ok: false,
    error: "workspace status is unavailable because an earlier worker process tree could not be confirmed terminated",
    cancelled: false,
    workspacePath,
    worktreeRoot,
    git: null,
    quarantinePath: sharedQuarantine?.quarantinePath ?? "",
    quarantine: sharedQuarantine?.details ?? null,
  };
  return jsonRpcResult(id, {
    content: [{ type: "text", text: textResult("Workspace Status", out) }],
    structuredContent: out,
    isError: true,
  });
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
  const timeoutMs = Number.isInteger(rawArgs.timeoutMs)
    ? Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, rawArgs.timeoutMs))
    : DEFAULT_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  let workspacePath = "";
  let worktreeRoot = "";
  let gitCommonDir = "";
  try {
    if (cancel?.cancelled) {
      return cancelledDelegation({ backend, workspacePath, worktreeRoot, spec });
    }
    workspacePath = await validateWorkspace(rawArgs.workspacePath);
    if (Date.now() >= deadline) throw new DeadlineExceededError("delegation deadline exceeded");
    await requireGitRepo(workspacePath, { cancel, deadline });
    worktreeRoot = await gitWorktreeRoot(workspacePath, { cancel, deadline });
    gitCommonDir = await gitCommonDirectory(workspacePath, { cancel, deadline });
  } catch (error) {
    if (error instanceof OperationCancelledError) {
      return cancelledDelegation({ backend, workspacePath, worktreeRoot, spec });
    }
    if (error instanceof DeadlineExceededError) {
      return lockDeadlineDelegation({
        backend,
        workspacePath,
        worktreeRoot,
        spec,
        error: "delegation timed out while identifying the Git worktree; the worker never started",
      });
    }
    throw error;
  }
  const lockKey = repositoryLockKey(gitCommonDir);
  const existingQuarantine = await readWorkspaceQuarantine(lockKey);
  if (quarantinedWorkspaces.has(lockKey) || existingQuarantine) {
    return quarantinedDelegation({ backend, workspacePath, worktreeRoot, spec }, existingQuarantine);
  }
  let observedQuarantine = null;
  return await withWorkspaceLock(lockKey, worktreeRoot, async (workspaceLease) => {
    const sharedQuarantine = await readWorkspaceQuarantine(lockKey);
    if (quarantinedWorkspaces.has(lockKey) || sharedQuarantine) {
      return quarantinedDelegation({ backend, workspacePath, worktreeRoot, spec }, sharedQuarantine);
    }
    if (cancel && cancel.cancelled) {
      return cancelledDelegation({ backend, workspacePath, worktreeRoot, spec });
    }
    const allowDirty = rawArgs.allowDirty === true;
    // Attribution window for concurrency disclosure: everything between the
    // before-snapshot and the after-snapshot.
    const attributionWindowStart = Date.now();
    let before;
    try {
      before = await gitSnapshot(worktreeRoot, { cancel, deadline, ownLockRef: workspaceLease.ref });
    } catch (error) {
      if (error instanceof OperationCancelledError) {
        return cancelledDelegation({ backend, workspacePath, worktreeRoot, spec });
      }
      if (error instanceof DeadlineExceededError) {
        return {
          ok: false,
          error: "delegation timed out during the preflight git snapshot; the worker never started",
          backend, workspacePath, worktreeRoot, exitCode: null, timedOut: true, killed: false, cancelled: false,
          treeTerminated: true, outputTail: "", stderrTail: "",
          gitBefore: null, git: null, commits: null,
          experimental: Boolean(spec.experimental),
        };
      }
      throw error;
    }
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

    const args = substituteArgs(template, rawArgs.task.trim(), rawArgs.resumeSessionId ?? "");

    // Cancellation can arrive while this request waits for the mutex or while
    // the read-only preflight snapshot runs. Never spawn after that signal.
    if (cancel && cancel.cancelled) {
      return cancelledDelegation({ backend, workspacePath, worktreeRoot, spec, before });
    }

    // The lease state update shares the request's cancellation/deadline so a
    // hung reference-transaction hook cannot pin the request here.
    try {
      await workspaceLease.markWorkerStarting({ cancel, deadline });
    } catch (error) {
      if (error instanceof WorkspaceLockCancelledError) {
        return cancelledDelegation({ backend, workspacePath, worktreeRoot, spec, before });
      }
      if (error instanceof WorkspaceLockDeadlineError) {
        return {
          ok: false,
          error: "delegation timed out after preflight; the worker never started",
          backend, workspacePath, worktreeRoot, exitCode: null, timedOut: true, killed: false, cancelled: false,
          treeTerminated: true, outputTail: "", stderrTail: "",
          gitBefore: before, git: before, commits: null,
          experimental: Boolean(spec.experimental),
        };
      }
      throw error;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return {
        ok: false,
        error: "delegation timed out after preflight; the worker never started",
        backend, workspacePath, worktreeRoot, exitCode: null, timedOut: true, killed: false, cancelled: false,
        treeTerminated: true, outputTail: "", stderrTail: "",
        gitBefore: before, git: before, commits: null,
        experimental: Boolean(spec.experimental),
      };
    }
    // Keep this check immediately adjacent to the backend launch. The request
    // may have been cancelled during preflight or argument preparation.
    if (cancel?.cancelled) {
      return cancelledDelegation({ backend, workspacePath, worktreeRoot, spec, before });
    }
    let workerController = null;
    let workerFinished = false;
    let ownershipLostError = null;
    let ownershipTermination = Promise.resolve();
    let ownershipTerminationStarted = false;
    let ownershipTerminationError = null;
    const recordOwnershipLoss = (error) => {
      ownershipLostError ??= error;
      if (workerController && !workerFinished && !ownershipTerminationStarted) {
        ownershipTerminationStarted = true;
        ownershipTermination = workerController.terminate("workspace-lock-lost").catch((terminationError) => {
          ownershipTerminationError ??= terminationError;
        });
      }
      return ownershipTermination;
    };
    void workspaceLease.lost.then(recordOwnershipLoss).catch((error) => {
      ownershipLostError ??= error;
    });
    let workerLockUpdate = Promise.resolve();
    const result = await runCommand(spec.command, args, {
      cwd: workspacePath,
      timeoutMs: remaining,
      manageProcessTree: true,
      shouldCancel: () => Boolean(cancel && cancel.cancelled),
      onChild: (controller) => {
        workerController = controller;
        if (cancel) cancel.controller = controller;
        if (ownershipLostError) void recordOwnershipLoss(ownershipLostError);
        workerLockUpdate = workspaceLease.markWorkerRunning(controller.child.pid, { cancel, deadline })
          .catch((error) => {
            // Interruption of the state update is expected during cancellation
            // or timeout: the worker lifecycle itself is managed by terminate().
            if (error instanceof WorkspaceLockCancelledError ||
                error instanceof WorkspaceLockDeadlineError) {
              return;
            }
            return recordOwnershipLoss(error);
          });
      },
    });
    // Keep the controller live while runCommand is still inspecting or
    // terminating escaped descendants after the leader closes. Once the full
    // command result settles, clear it before any further await so a late lease
    // notification cannot signal a reused PID/process-group identifier.
    workerFinished = true;
    if (cancel?.controller === workerController) cancel.controller = null;
    workerController = null;
    await workerLockUpdate;
    let quarantinePath = "";
    if (!result.treeTerminated) {
      quarantinedWorkspaces.add(lockKey);
      workspaceLease.retain();
      // Move the retained lease into the recoverable "quarantined" state. A
      // running-state lease can never be reclaimed, which would leave the
      // workspace locked forever even after the operator removes the marker.
      try {
        await workspaceLease.markWorkerQuarantined();
      } catch { /* lease lost or interrupted: the marker file below still gates recovery */ }
      quarantinePath = await markWorkspaceQuarantined(lockKey, {
        backend,
        workspacePath,
        worktreeRoot,
        lockRef: workspaceLease.ref,
        terminationError: result.terminationError,
      });
      // The shared marker is now authoritative and removable by an operator;
      // retain the local fallback only when writing that marker failed.
      quarantinedWorkspaces.delete(lockKey);
    } else if (!ownershipLostError) {
      try {
        await workspaceLease.markWorkerIdle({ cancel, deadline });
      } catch (error) {
        if (!(error instanceof WorkspaceLockCancelledError) &&
            !(error instanceof WorkspaceLockDeadlineError)) {
          await recordOwnershipLoss(error);
        }
      }
    }
    if (ownershipLostError) {
      await ownershipTermination;
      if (ownershipTerminationError && ownershipLostError.cause === undefined) {
        ownershipLostError.cause = ownershipTerminationError;
      }
      throw ownershipLostError;
    }
    let after = null;
    let commits = null;
    let postRunDeadlineExceeded = false;
    if (result.treeTerminated) {
      try {
        after = await gitSnapshot(worktreeRoot, {
          cancel,
          deadline,
          ownLockRef: workspaceLease.ref,
          concurrencyWindowStart: attributionWindowStart,
        });
        commits = await committedDelta(worktreeRoot, before, after, { cancel, deadline });
      } catch (error) {
        if (error instanceof OperationCancelledError) {
          // The worker is already stopped; report cancellation without a
          // misleading partial snapshot assembled from interrupted Git calls.
          after = null;
        } else if (error instanceof DeadlineExceededError) {
          postRunDeadlineExceeded = true;
          after = null;
        } else {
          throw error;
        }
      }
    }
    // Linked worktrees of one repository serialize per worktree only. If any
    // other delegation held an active lease in the same repository during our
    // before/after snapshots, ref movements may include its commits: disclose
    // the overlap instead of presenting attribution as exact.
    const repositoryConcurrency = Boolean(
      (before.concurrentDelegations ?? 0) > 0 || (after?.concurrentDelegations ?? 0) > 0,
    );
    let error = "";
    if (!result.treeTerminated) {
      error = "backend process tree could not be confirmed terminated; the shared workspace quarantine remains until an operator checks for leftovers and removes quarantinePath";
    } else if (cancel && cancel.cancelled) {
      error = "delegation cancelled by client; post-run snapshot may be unavailable";
    } else if (result.timedOut || postRunDeadlineExceeded) {
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
      timedOut: result.timedOut || postRunDeadlineExceeded,
      killed: result.killed,
      cancelled: Boolean(cancel && cancel.cancelled),
      orphanedProcesses: result.orphanedProcesses,
      treeTerminated: result.treeTerminated,
      terminationError: result.terminationError,
      quarantinePath,
      repositoryConcurrency,
      outputTail: tail(result.stdout, RAW_TAIL_CHARS),
      stderrTail: tail(result.stderr, RAW_TAIL_CHARS),
      outputTruncated: Boolean(result.stdoutTruncated),
      stderrTruncated: Boolean(result.stderrTruncated),
      gitBefore: before,
      git: after,
      commits,
      experimental: Boolean(spec.experimental),
    };
  }, {
    cancel,
    deadline,
    onCancelled: () => cancelledDelegation({ backend, workspacePath, worktreeRoot, spec }),
    onDeadline: () => lockDeadlineDelegation({ backend, workspacePath, worktreeRoot, spec }),
    operatorCleared: () => quarantineFileAbsent(lockKey),
    isUnavailable: async () => {
      observedQuarantine = await readWorkspaceQuarantine(lockKey);
      return quarantinedWorkspaces.has(lockKey) || Boolean(observedQuarantine);
    },
    onUnavailable: () => quarantinedDelegation(
      { backend, workspacePath, worktreeRoot, spec }, observedQuarantine,
    ),
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
  };  gitBlock("before", obj.gitBefore);
  gitBlock("after", obj.git);
  if (obj.commits) {
    if (obj.commits.refsChanged?.length) {
      lines.push("", "## refs changed by the worker", "", "~~~text",
        obj.commits.refsChanged.map((item) =>
          item.ref + " " + (item.before || "(absent)") + " -> " + (item.after || "(deleted)"),
        ).join("\n"), "~~~");
    }
    const commitsHeading = obj.repositoryConcurrency
      ? "## commits attributed to the worker (other delegations were active in this repository; attribution may overlap)"
      : "## commits made by the worker";
    lines.push("", commitsHeading, "", "~~~text", obj.commits.log || "(none)", "~~~");
    lines.push("", "## commit diff stat", "", "~~~text", obj.commits.diffStat || "(empty)", "~~~");
  }
  if (obj.repositoryConcurrency) {
    lines.push(
      "",
      "## attribution note",
      "",
      "other delegations were active in this repository during the run; commits and ref changes may overlap those workers",
    );
  }
  if (obj.outputTail) lines.push("", "## output tail", "", "~~~text", obj.outputTail, "~~~");
  if (obj.stderrTail) lines.push("", "## stderr tail", "", "~~~text", obj.stderrTail, "~~~");
  if (obj.error) lines.push("", "## error", "", obj.error);
  return lines.join("\n");
}

function jsonRpcResult(id, result) { return { jsonrpc: "2.0", id, result }; }
function jsonRpcError(id, code, message) { return { jsonrpc: "2.0", id, error: { code, message } }; }

// In-flight cancellable tool requests, keyed by the original JSON-RPC id type,
// so notifications/cancelled can interrupt workers, lock waits, and snapshots.
const activeRequests = new Map();

function trackActiveRequest(id, cancel) {
  let resolveDone;
  const entry = { cancel, done: new Promise((resolve) => { resolveDone = resolve; }) };
  activeRequests.set(id, entry);
  return () => {
    if (activeRequests.get(id) === entry) activeRequests.delete(id);
    resolveDone();
  };
}

async function terminateActiveRequests(reason = "shutdown") {
  const entries = [...activeRequests.values()];
  const waits = [];
  for (const { cancel } of entries) {
    const controller = cancel.controller;
    cancel.cancel();
    if (controller) waits.push(controller.terminate(reason));
  }
  await Promise.allSettled(waits);
  // Let each request unwind its lock/snapshot finally blocks before the server
  // exits, avoiding an unnecessary stale cross-process lock after clean shutdown.
  await Promise.allSettled(entries.map((entry) => entry.done));
}

function installShutdownHandlers(stdin) {
  let shuttingDown = false;
  const shutdown = (exitCode) => {
    if (shuttingDown) return;
    shuttingDown = true;
    void terminateActiveRequests().finally(() => process.exit(exitCode));
  };
  process.once("SIGTERM", () => shutdown(0));
  process.once("SIGINT", () => shutdown(130));
  stdin.once("end", () => shutdown(0));
  stdin.once("close", () => shutdown(0));
  // Last-chance best effort. On POSIX, controller.terminate signals the
  // detached process group synchronously before its first await.
  process.once("exit", () => {
    for (const { cancel } of activeRequests.values()) cancel.cancel();
  });
}

async function handleMessage(message) {
  if (!message || typeof message !== "object" || message.jsonrpc !== "2.0") {
    return jsonRpcError(null, -32600, "Invalid JSON-RPC request");
  }
  if (message.method === "notifications/cancelled") {
    const requestId = message.params?.requestId ?? message.params?.id;
    const entry = activeRequests.get(requestId);
    if (entry && entry.cancel) {
      entry.cancel.cancel();
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
          const cancel = createCancellation();
          const finishRequest = trackActiveRequest(message.id, cancel);
          try {
            const entries = await listBackends(cancel);
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
          } finally {
            finishRequest();
          }
        }
        if (params.name === "workspace_status") {
          const cancel = createCancellation();
          const finishRequest = trackActiveRequest(message.id, cancel);
          let workspacePath = "";
          let worktreeRoot = "";
          let gitCommonDir = "";
          try {
            workspacePath = await validateWorkspace(args.workspacePath);
            if (cancel.cancelled) return cancelledWorkspaceStatus(message.id, { workspacePath });
            try {
              await requireGitRepo(workspacePath, { cancel });
              if (cancel.cancelled) return cancelledWorkspaceStatus(message.id, { workspacePath });
              worktreeRoot = await gitWorktreeRoot(workspacePath, { cancel });
              gitCommonDir = await gitCommonDirectory(workspacePath, { cancel });
            } catch (error) {
              if (error instanceof OperationCancelledError) {
                return cancelledWorkspaceStatus(message.id, { workspacePath, worktreeRoot });
              }
              throw error;
            }
            if (cancel.cancelled) return cancelledWorkspaceStatus(message.id, { workspacePath, worktreeRoot });
            const lockKey = repositoryLockKey(gitCommonDir);
            const existingQuarantine = await readWorkspaceQuarantine(lockKey);
            if (quarantinedWorkspaces.has(lockKey) || existingQuarantine) {
              return quarantinedWorkspaceStatus(
                message.id, { workspacePath, worktreeRoot }, existingQuarantine,
              );
            }
            let observedQuarantine = null;
            return await withWorkspaceLock(lockKey, worktreeRoot, async () => {
              const sharedQuarantine = await readWorkspaceQuarantine(lockKey);
              if (quarantinedWorkspaces.has(lockKey) || sharedQuarantine) {
                return quarantinedWorkspaceStatus(
                  message.id, { workspacePath, worktreeRoot }, sharedQuarantine,
                );
              }
              try {
                const git = await gitSnapshot(worktreeRoot, { cancel });
                if (cancel.cancelled) {
                  return cancelledWorkspaceStatus(message.id, { workspacePath, worktreeRoot });
                }
                return jsonRpcResult(message.id, {
                  content: [{ type: "text", text: textResult("Workspace Status", { workspacePath, worktreeRoot, git }) }],
                  structuredContent: { ok: true, workspacePath, worktreeRoot, git },
                });
              } catch (error) {
                if (error instanceof OperationCancelledError) {
                  return cancelledWorkspaceStatus(message.id, { workspacePath, worktreeRoot });
                }
                throw error;
              }
            }, {
              cancel,
              onCancelled: () => cancelledWorkspaceStatus(message.id, { workspacePath, worktreeRoot }),
              operatorCleared: () => quarantineFileAbsent(lockKey),
              isUnavailable: async () => {
                observedQuarantine = await readWorkspaceQuarantine(lockKey);
                return quarantinedWorkspaces.has(lockKey) || Boolean(observedQuarantine);
              },
              onUnavailable: () => quarantinedWorkspaceStatus(
                message.id, { workspacePath, worktreeRoot }, observedQuarantine,
              ),
            });
          } finally {
            finishRequest();
          }
        }
        if (params.name === "delegate_task") {
          const cancel = createCancellation();
          const finishRequest = trackActiveRequest(message.id, cancel);
          try {
            const out = await delegateTask(args, cancel);
            return jsonRpcResult(message.id, {
              content: [{ type: "text", text: textResult("Delegated Task Result", out) }],
              structuredContent: out,
              isError: !out.ok,
            });
          } finally {
            finishRequest();
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
  installShutdownHandlers(process.stdin);
}
