#!/usr/bin/env node
// cli-agent-bridge: a dependency-free stdio MCP server that lets MiniMax Code
// delegate coding tasks to locally installed coding CLIs (Claude Code, Codex,
// Kimi Code, ZCode, DSH). The server makes no network calls of its own; each
// backend CLI runs headless with the local user authentication.
//
// License: MIT. See NOTICE for upstream credits.

import { spawn } from "node:child_process";
import { readFile, stat, realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

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
    // "--" delimits the prompt from CLI options so a task like "--help" cannot
    // be interpreted as a codex flag.
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
      "Run a coding task with a locally installed coding CLI (backend: claude, codex, kimi, zcode, or dsh) inside the given workspace, headless. Returns the CLI exit code, readable output tail, stderr tail, and the git snapshot (staged, unstaged, untracked, and committed deltas) produced by the run. Refuses to run when the working tree is dirty unless allowDirty=true. Delegations to the same workspace are serialized.",
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
          description: "Execution timeout in milliseconds. Defaults to 1200000 (20 minutes). After the timeout the worker receives SIGTERM, then a forceful kill after a 10 second grace period.",
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

// Kill the worker's whole process tree, not just the top-level child. On
// Windows, child.kill() ends only the .cmd/.ps1 shim while the real CLI keeps
// running, so taskkill /T /F is required; on POSIX the worker is spawned
// detached in its own process group and the group is signaled here.
function treeKill(child, signal) {
  if (!child) return;
  if (!child.pid) {
    try { child.kill(signal); } catch { /* already gone */ }
    return;
  }
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    } else {
      process.kill(-child.pid, signal); // negative pid = the whole group
    }
  } catch {
    try { child.kill(signal); } catch { /* already gone */ }
  }
}

async function runCommand(command, args, options = {}) {
  const spawnOnce = (argv, shellArgs) => new Promise((resolve) => {
    const child = shellArgs
      ? spawn(shellArgs[0], shellArgs.slice(1), {
          cwd: options.cwd,
          env: process.env,
          windowsHide: true,
          detached: process.platform !== "win32", // own process group for treeKill
          stdio: ["ignore", "pipe", "pipe"],
        })
      : spawn(command, argv, {
          cwd: options.cwd,
          env: process.env,
          windowsHide: true,
          detached: process.platform !== "win32", // own process group for treeKill
          stdio: ["ignore", "pipe", "pipe"],
        });
    if (typeof options.onChild === "function") options.onChild(child);
    const stdoutBuf = capture();
    const stderrBuf = capture();
    let settled = false;
    let spawnError = null;
    let timedOut = false;
    let killed = false;
    const timeoutMs = options.timeoutMs ?? 30_000;
    const settle = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(forceTimer);
      resolve({
        stdout: stdoutBuf.text(),
        stderr: stderrBuf.text(),
        exitCode: null,
        timedOut,
        killed,
        errorMessage: "",
        spawnError,
      });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      treeKill(child, "SIGTERM");
    }, timeoutMs);
    // If the child ignores SIGTERM or a descendant holds the pipes, close never
    // fires; force-settle after the grace period so the MCP call cannot hang.
    const forceTimer = setTimeout(() => {
      if (settled) return;
      killed = true;
      treeKill(child, "SIGKILL");
      settle();
    }, timeoutMs + KILL_GRACE_MS);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdoutBuf.push(chunk); });
    child.stderr.on("data", (chunk) => { stderrBuf.push(chunk); });

    child.on("error", (error) => {
      spawnError = error;
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(forceTimer);
      resolve({
        stdout: stdoutBuf.text(),
        stderr: stderrBuf.text(),
        exitCode: null,
        timedOut,
        killed,
        errorMessage: error.message,
        spawnError,
      });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(forceTimer);
      resolve({
        stdout: stdoutBuf.text(),
        stderr: stderrBuf.text(),
        exitCode: code,
        timedOut,
        killed,
        errorMessage: "",
        spawnError,
      });
    });
  });

  const direct = await spawnOnce(args, null);
  if (process.platform !== "win32" || !direct.spawnError) return direct;

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

function snapshotFailure(label, result) {
  if (result.timedOut) return label + " timed out";
  if (result.exitCode !== 0) return label + " failed with exit code " + String(result.exitCode);
  return "";
}

async function gitSnapshot(workspacePath) {
  const jobs = [
    ["git status --short", "status", ["status", "--short"]],
    ["git diff --stat", "diffStat", ["diff", "--stat"]],
    ["git diff --name-only", "diffNames", ["diff", "--name-only"]],
    ["git diff --cached --stat", "cachedDiffStat", ["diff", "--cached", "--stat"]],
    ["git diff --cached --name-only", "cachedDiffNames", ["diff", "--cached", "--name-only"]],
    ["git ls-files --others --exclude-standard", "untracked", ["ls-files", "--others", "--exclude-standard"]],
    ["git rev-parse HEAD", "head", ["rev-parse", "HEAD"]],
  ];
  const results = await Promise.all(jobs.map((j) => runCommand("git", j[2], { cwd: workspacePath, timeoutMs: GIT_TIMEOUT_MS })));
  const failures = [];
  const out = {};
  results.forEach((result, i) => {
    // An unborn HEAD (fresh `git init`, no commits yet) is a valid repository
    // state, not an unreliable snapshot; record it as an empty head.
    if (jobs[i][1] === "head") return;
    const failure = snapshotFailure(jobs[i][0], result);
    if (failure) { failures.push(failure); return; }
    out[jobs[i][1]] = result.stdout;
  });
  const headResult = results[jobs.findIndex((j) => j[1] === "head")];
  out.head = headResult && headResult.exitCode === 0 ? String(headResult.stdout).trim() : "";
  if (failures.length > 0) {
    // Fail closed: an unreliable snapshot must never authorize a delegation.
    throw new Error("git snapshot unreliable: " + failures.join("; "));
  }
  const seen = new Set();
  const changedFiles = [
    ...String(out.diffNames ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean),
    ...String(out.cachedDiffNames ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean),
    ...String(out.untracked ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean),
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
  const range = beforeHead ? beforeHead + ".." + afterHead : null;
  const [log, stat] = await Promise.all([
    range
      ? runCommand("git", ["log", "--oneline", range], { cwd: workspacePath, timeoutMs: GIT_TIMEOUT_MS })
      : runCommand("git", ["log", "--oneline", "--max-count=50"], { cwd: workspacePath, timeoutMs: GIT_TIMEOUT_MS }),
    range
      ? runCommand("git", ["diff", "--stat", range], { cwd: workspacePath, timeoutMs: GIT_TIMEOUT_MS })
      : runCommand("git", ["show", "--stat", "--oneline", afterHead], { cwd: workspacePath, timeoutMs: GIT_TIMEOUT_MS }),
  ]);
  return {
    range: range ?? "(repository had no commits before the worker ran)",
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

// Lock key = canonical real path of the git worktree root. The same checkout
// reached through a subdirectory, different casing, or a symlink must share
// one mutex, otherwise two write workers could run on it concurrently.
async function worktreeKey(workspacePath) {
  const topLevel = await runCommand("git", ["rev-parse", "--show-toplevel"], {
    cwd: workspacePath, timeoutMs: 15_000,
  });
  const root = topLevel.exitCode === 0 && topLevel.stdout.trim()
    ? topLevel.stdout.trim().replace(/[\\/]+$/, "")
    : workspacePath;
  try {
    return await realpath(root);
  } catch {
    return path.resolve(root);
  }
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

  const lockKey = "wt:" + (await worktreeKey(workspacePath));
  return await withWorkspaceLock(lockKey, async () => {
    // A cancellation that arrived while this request was queued behind the
    // lock must not start the worker at all; re-check before spawning.
    if (cancel && cancel.cancelled) {
      return {
        ok: false,
        error: "delegation cancelled by client while waiting for the workspace lock; the worker never started",
        backend, workspacePath, exitCode: null, timedOut: false, killed: false, cancelled: true,
        outputTail: "", stderrTail: "",
        gitBefore: null, git: null, commits: null,
        experimental: Boolean(spec.experimental),
      };
    }
    const allowDirty = rawArgs.allowDirty === true;
    const before = await gitSnapshot(workspacePath);
    if (!allowDirty && before.statusShort) {
      return {
        ok: false,
        error: "working tree is dirty; review current changes first or set allowDirty=true deliberately",
        backend, workspacePath, exitCode: null, timedOut: false, killed: false, cancelled: false,
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
        backend, workspacePath, exitCode: null, timedOut: false, killed: false, cancelled: false,
        outputTail: "", stderrTail: "",
        gitBefore: before, git: before, commits: null,
        experimental: Boolean(spec.experimental),
      };
    }

    const timeoutMs = Number.isInteger(rawArgs.timeoutMs)
      ? Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, rawArgs.timeoutMs))
      : DEFAULT_TIMEOUT_MS;
    const args = substituteArgs(template, rawArgs.task.trim(), rawArgs.resumeSessionId ?? "");

    const result = await runCommand(spec.command, args, {
      cwd: workspacePath,
      timeoutMs,
      onChild: (child) => { if (cancel) cancel.child = child; },
    });
    const after = await gitSnapshot(workspacePath);
    const commits = await committedDelta(workspacePath, before.head, after.head);
    let error = "";
    if (cancel && cancel.cancelled) {
      error = "delegation cancelled by client";
    } else if (result.timedOut) {
      error = "backend \"" + backend + "\" timed out after " + timeoutMs + " ms" + (result.killed ? " and was force-killed" : "");
    } else if (result.exitCode !== 0) {
      error = "backend \"" + backend + "\" exited with code " + String(result.exitCode);
    }

    return {
      ok: !error,
      error,
      backend,
      workspacePath,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      killed: result.killed,
      cancelled: Boolean(cancel && cancel.cancelled),
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
    lines.push("", "## " + label + " HEAD", "", "~~~text", git.head || "(unknown)", "~~~");
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
    const entry = activeRequests.get(String(requestId));
    if (entry && entry.cancel) {
      entry.cancel.cancelled = true;
      if (entry.cancel.child) {
        treeKill(entry.cancel.child, "SIGTERM");
        setTimeout(() => treeKill(entry.cancel.child, "SIGKILL"), KILL_GRACE_MS).unref?.();
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
          const git = await gitSnapshot(workspacePath);
          return jsonRpcResult(message.id, {
            content: [{ type: "text", text: textResult("Workspace Status", { workspacePath, git }) }],
            structuredContent: { ok: true, workspacePath, git },
          });
        }
        if (params.name === "delegate_task") {
          const cancel = { child: null, cancelled: false };
          activeRequests.set(String(message.id), { cancel });
          try {
            const out = await delegateTask(args, cancel);
            return jsonRpcResult(message.id, {
              content: [{ type: "text", text: textResult("Delegated Task Result", out) }],
              structuredContent: out,
              isError: !out.ok,
            });
          } finally {
            activeRequests.delete(String(message.id));
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

