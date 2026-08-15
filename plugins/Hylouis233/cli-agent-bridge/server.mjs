#!/usr/bin/env node
// cli-agent-bridge: a dependency-free stdio MCP server that lets MiniMax Code
// delegate coding tasks to locally installed coding CLIs (Claude Code, Codex,
// Kimi Code, ZCode, DSH). The server makes no network calls of its own; each
// backend CLI runs headless with the local user authentication.
//
// License: MIT. See NOTICE for upstream credits.

import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const SERVER_NAME = "cli-agent-bridge";
const SERVER_VERSION = "0.1.0";
const PROTOCOL_VERSION = "2025-06-18";
const DEFAULT_TIMEOUT_MS = 1_200_000;
const MIN_TIMEOUT_MS = 5_000;
const MAX_TIMEOUT_MS = 3_600_000;
const VERSION_CHECK_TIMEOUT_MS = 15_000;
const MAX_CAPTURE_CHARS = 5_000_000;
const RAW_TAIL_CHARS = 60_000;

// Built-in defaults. The sibling backends.json (or the CLI_AGENT_BRIDGE_BACKENDS
// environment variable) overrides these; a missing or invalid file falls back
// to this table.
const FALLBACK_BACKENDS = {
  claude: {
    label: "Claude Code",
    command: "claude",
    buildArgs: ["-p", "<task>", "--output-format", "text"],
    resumeArgs: ["-p", "<task>", "--output-format", "text", "--resume", "<session>"],
    experimental: false,
  },
  codex: {
    label: "OpenAI Codex CLI",
    command: "codex",
    buildArgs: ["exec", "<task>"],
    resumeArgs: ["exec", "resume", "<session>", "<task>"],
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
  },
  dsh: {
    label: "DeepSeek Harness (dsh)",
    command: "dsh",
    buildArgs: ["run", "<task>"],
    resumeArgs: null,
    experimental: true,
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
      "Run a coding task with a locally installed coding CLI (backend: claude, codex, kimi, zcode, or dsh) inside the given workspace, headless. Returns the CLI exit code, readable output tail, stderr tail, and the git diff stat and changed files produced by the run. Refuses to run when the working tree is dirty unless allowDirty=true.",
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
          description: "Execution timeout in milliseconds. Defaults to 1200000 (20 minutes).",
        },
      },
      required: ["backend", "task", "workspacePath"],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
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

async function runCommand(command, args, options = {}) {
  return await new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: process.env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    const timeoutMs = options.timeoutMs ?? 30_000;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout = capAppend(stdout, chunk); });
    child.stderr.on("data", (chunk) => { stderr = capAppend(stderr, chunk); });

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: null, timedOut, errorMessage: error.message });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code, timedOut, errorMessage: "" });
    });
  });
}

function capAppend(current, chunk) {
  const combined = current + chunk;
  return combined.length > MAX_CAPTURE_CHARS ? combined.slice(-MAX_CAPTURE_CHARS) : combined;
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

async function gitSnapshot(workspacePath) {
  const [status, diffStat, diffNames] = await Promise.all([
    runCommand("git", ["status", "--short"], { cwd: workspacePath, timeoutMs: 30_000 }),
    runCommand("git", ["diff", "--stat"], { cwd: workspacePath, timeoutMs: 30_000 }),
    runCommand("git", ["diff", "--name-only"], { cwd: workspacePath, timeoutMs: 30_000 }),
  ]);
  return {
    statusShort: status.stdout.trim(),
    diffStat: diffStat.stdout.trim(),
    changedFiles: diffNames.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean),
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
    });
  }
  return entries;
}

async function delegateTask(rawArgs) {
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

  const allowDirty = rawArgs.allowDirty === true;
  const before = await gitSnapshot(workspacePath);
  if (!allowDirty && before.statusShort) {
    return {
      ok: false,
      error: "working tree is dirty; review current changes first or set allowDirty=true deliberately",
      backend, workspacePath, exitCode: null, timedOut: false, outputTail: "", stderrTail: "",
      git: before, experimental: Boolean(spec.experimental),
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
      backend, workspacePath, exitCode: null, timedOut: false, outputTail: "", stderrTail: "",
      git: before, experimental: Boolean(spec.experimental),
    };
  }

  const timeoutMs = Number.isInteger(rawArgs.timeoutMs)
    ? Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, rawArgs.timeoutMs))
    : DEFAULT_TIMEOUT_MS;
  const args = substituteArgs(template, rawArgs.task.trim(), rawArgs.resumeSessionId ?? "");

  const result = await runCommand(spec.command, args, { cwd: workspacePath, timeoutMs });
  const after = await gitSnapshot(workspacePath);
  let error = "";
  if (result.timedOut) error = "backend \"" + backend + "\" timed out after " + timeoutMs + " ms";
  else if (result.exitCode !== 0) error = "backend \"" + backend + "\" exited with code " + String(result.exitCode);

  return {
    ok: !error,
    error,
    backend,
    workspacePath,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    outputTail: tail(result.stdout, RAW_TAIL_CHARS),
    stderrTail: tail(result.stderr, RAW_TAIL_CHARS),
    git: after,
    experimental: Boolean(spec.experimental),
  };
}

function textResult(header, obj) {
  const lines = ["# " + header, ""];
  for (const [key, value] of Object.entries(obj)) {
    if (key === "outputTail" || key === "stderrTail" || key === "git") continue;
    lines.push("- " + key + ": " + String(value ?? ""));
  }
  if (obj.git) {
    lines.push("", "## git status --short", "", "~~~text", obj.git.statusShort || "(clean)", "~~~");
    lines.push("", "## git diff --stat", "", "~~~text", obj.git.diffStat || "(empty)", "~~~");
    lines.push("", "## changed files", "", "~~~text", (obj.git.changedFiles ?? []).join("\n") || "(none)", "~~~");
  }
  if (obj.outputTail) lines.push("", "## output tail", "", "~~~text", obj.outputTail, "~~~");
  if (obj.stderrTail) lines.push("", "## stderr tail", "", "~~~text", obj.stderrTail, "~~~");
  if (obj.error) lines.push("", "## error", "", obj.error);
  return lines.join("\n");
}

function jsonRpcResult(id, result) { return { jsonrpc: "2.0", id, result }; }
function jsonRpcError(id, code, message) { return { jsonrpc: "2.0", id, error: { code, message } }; }

async function handleMessage(message) {
  if (!message || typeof message !== "object" || message.jsonrpc !== "2.0") {
    return jsonRpcError(null, -32600, "Invalid JSON-RPC request");
  }
  if (message.id === undefined) return null; // notification

  try {
    switch (message.method) {
      case "initialize":
        return jsonRpcResult(message.id, {
          protocolVersion: message.params?.protocolVersion ?? PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: SERVER_NAME, title: "CLI Agent Bridge", version: SERVER_VERSION },
          instructions:
            "Delegate coding tasks to locally installed coding CLIs. Prefer workspace_status first, then delegate_task, then review the returned git diff. Never put credentials in task text.",
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
          const out = await delegateTask(args);
          return jsonRpcResult(message.id, {
            content: [{ type: "text", text: textResult("Delegated Task Result", out) }],
            structuredContent: out,
          });
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

