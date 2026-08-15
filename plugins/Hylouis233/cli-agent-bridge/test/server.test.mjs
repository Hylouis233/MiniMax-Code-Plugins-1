// Self-contained tests for the cli-agent-bridge stdio MCP server.
// Run with: node --test test/server.test.mjs
// No network access is required: the delegation test uses a fake slow backend.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const server = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "server.mjs");

function startServer(extraEnv = {}) {
  const child = spawn(process.execPath, [server], {
    env: { ...process.env, ...extraEnv },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buf = "";
  const pending = new Map();
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    }
  });
  const rpc = (id, method, params) => new Promise((resolve) => {
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  const notify = (method, params) => {
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  };
  const stop = () => child.kill();
  return { child, rpc, notify, stop };
}

function makeRepo() {
  const dir = mkdtempSync(path.join(tmpdir(), "bridge-test-"));
  execSync("git init -q", { cwd: dir });
  execSync("git config user.name test", { cwd: dir });
  execSync("git config user.email test@example.com", { cwd: dir });
  writeFileSync(path.join(dir, "hello.txt"), "hello");
  execSync("git add hello.txt && git commit -q -m init", { cwd: dir });
  return dir;
}

test("initialize negotiates only the supported protocol version", async () => {
  const s = startServer();
  const init = await s.rpc(1, "initialize", { protocolVersion: "2024-11-05" });
  assert.equal(init.result.protocolVersion, "2025-06-18");
  assert.equal(init.result.serverInfo.name, "cli-agent-bridge");
  s.stop();
});

test("tools/list exposes the three bridge tools", async () => {
  const s = startServer();
  await s.rpc(1, "initialize", {});
  const list = await s.rpc(2, "tools/list");
  const names = list.result.tools.map((t) => t.name).sort();
  assert.deepEqual(names, ["delegate_task", "list_backends", "workspace_status"]);
  const delegate = list.result.tools.find((t) => t.name === "delegate_task");
  assert.equal(delegate.annotations.destructiveHint, true);
  s.stop();
});

test("workspace_status reports changed files including untracked ones", async () => {
  const s = startServer();
  await s.rpc(1, "initialize", {});
  const repo = makeRepo();
  writeFileSync(path.join(repo, "new-file.txt"), "new");
  const res = await s.rpc(2, "tools/call", { name: "workspace_status", arguments: { workspacePath: repo } });
  assert.equal(res.result.structuredContent.ok, true);
  assert.ok(res.result.structuredContent.git.changedFiles.includes("new-file.txt"));
  s.stop();
});

test("delegate_task refuses a dirty tree without allowDirty and sets isError", async () => {
  const s = startServer();
  await s.rpc(1, "initialize", {});
  const repo = makeRepo();
  writeFileSync(path.join(repo, "dirty.txt"), "dirty");
  const res = await s.rpc(2, "tools/call", { name: "delegate_task", arguments: { backend: "claude", task: "x", workspacePath: repo } });
  assert.equal(res.result.structuredContent.ok, false);
  assert.equal(res.result.isError, true);
  assert.match(res.result.structuredContent.error, /dirty/);
  s.stop();
});

test("delegate_task rejects unknown backends", async () => {
  const s = startServer();
  await s.rpc(1, "initialize", {});
  const repo = makeRepo();
  const res = await s.rpc(2, "tools/call", { name: "delegate_task", arguments: { backend: "nope", task: "x", workspacePath: repo } });
  assert.match(res.error.message, /unknown backend/);
  s.stop();
});

test("notifications/cancelled terminates an in-flight worker", async () => {
  const slowCfg = path.join(tmpdir(), "bridge-slow-backends.json");
  writeFileSync(slowCfg, JSON.stringify({
    backends: {
      slow: { command: "node", buildArgs: ["-e", "setTimeout(()=>{},120000)", "<task>"], experimental: true },
    },
  }));
  const s = startServer({ CLI_AGENT_BRIDGE_BACKENDS: slowCfg });
  await s.rpc(1, "initialize", {});
  const repo = makeRepo();
  const start = Date.now();
  const promise = s.rpc(7, "tools/call", { name: "delegate_task", arguments: { backend: "slow", task: "do nothing", workspacePath: repo } });
  setTimeout(() => s.notify("notifications/cancelled", { requestId: 7 }), 500);
  const res = await promise;
  const elapsed = Date.now() - start;
  assert.equal(res.result.structuredContent.cancelled, true);
  assert.equal(res.result.isError, true);
  assert.ok(elapsed < 10_000, "cancellation must settle well before the 120s backend timeout");
  s.stop();
});

test("delegate_task returns before and after snapshots and committed deltas", async () => {
  const fakeCfg = path.join(tmpdir(), "bridge-fake-backends.json");
  writeFileSync(fakeCfg, JSON.stringify({
    backends: {
      fake: { command: "node", buildArgs: ["-e", "require('node:fs').appendFileSync('marker.txt','ok')", "<task>"], experimental: true },
    },
  }));
  const s = startServer({ CLI_AGENT_BRIDGE_BACKENDS: fakeCfg });
  await s.rpc(1, "initialize", {});
  const repo = makeRepo();
  const res = await s.rpc(2, "tools/call", { name: "delegate_task", arguments: { backend: "fake", task: "make a marker", workspacePath: repo } });
  const out = res.result.structuredContent;
  assert.equal(out.ok, true);
  assert.equal(out.exitCode, 0);
  assert.ok(out.gitBefore && out.git, "before and after snapshots must both be present");
  assert.ok(out.git.changedFiles.includes("marker.txt"));
  s.stop();
});

test("locks are keyed by the worktree root, so subdir paths serialize with the root", async () => {
  // Each run appends "start", waits, appends "end" to an absolute-path log.
  // If the root path and a subdirectory path shared no lock, the log would
  // read start,start,end,end instead of strictly alternating.
  const repo = makeRepo();
  const sub = path.join(repo, "nested", "deep");
  mkdirSync(sub, { recursive: true });
  const logFile = path.join(repo, "order.log").replace(/\\/g, "/");
  const script = `const fs=require('node:fs');` +
    `fs.appendFileSync(${JSON.stringify(logFile)},'start\\n');` +
    `setTimeout(()=>{fs.appendFileSync(${JSON.stringify(logFile)},'end\\n')},700);`;
  const cfg = path.join(tmpdir(), "bridge-order-backends.json");
  writeFileSync(cfg, JSON.stringify({
    backends: { orderer: { command: "node", buildArgs: ["-e", script, "<task>"], experimental: true } },
  }));
  const s = startServer({ CLI_AGENT_BRIDGE_BACKENDS: cfg });
  await s.rpc(1, "initialize", {});
  const first = s.rpc(2, "tools/call", { name: "delegate_task", arguments: { backend: "orderer", task: "x", workspacePath: repo, timeoutMs: 60_000 } });
  // The queued follow-up must accept the tree the first run left dirty
  // (order.log is untracked); allowDirty=false would refuse it.
  const second = s.rpc(3, "tools/call", { name: "delegate_task", arguments: { backend: "orderer", task: "x", workspacePath: sub, allowDirty: true, timeoutMs: 60_000 } });
  const [r1, r2] = await Promise.all([first, second]);
  assert.equal(r1.result.structuredContent.ok, true, JSON.stringify(r1.result?.structuredContent?.error ?? r1.error));
  assert.equal(r2.result.structuredContent.ok, true, JSON.stringify(r2.result?.structuredContent?.error ?? r2.error));
  const log = readFileSync(path.join(repo, "order.log"), "utf8").trim().split(/\r?\n/);
  assert.deepEqual(log, ["start", "end", "start", "end"], "root and subdir delegations must serialize: " + log.join(","));
  s.stop();
});

test("a delegation cancelled while queued for the lock never starts its worker", async () => {
  const cfg = path.join(tmpdir(), "bridge-queue-cancel.json");
  writeFileSync(cfg, JSON.stringify({
    backends: { slow: { command: "node", buildArgs: ["-e", "setTimeout(()=>{},4000)", "<task>"], experimental: true } },
  }));
  const s = startServer({ CLI_AGENT_BRIDGE_BACKENDS: cfg });
  await s.rpc(1, "initialize", {});
  const repo = makeRepo();
  const first = s.rpc(10, "tools/call", { name: "delegate_task", arguments: { backend: "slow", task: "hold the lock", workspacePath: repo, timeoutMs: 60_000 } });
  // Let the first request actually acquire the lock and start its worker
  // before sending the second, so the second is deterministically queued.
  await new Promise((r) => setTimeout(r, 600));
  const second = s.rpc(11, "tools/call", { name: "delegate_task", arguments: { backend: "slow", task: "queued", workspacePath: repo, timeoutMs: 60_000 } });
  await new Promise((r) => setTimeout(r, 600)); // second request is now queued behind the lock
  s.notify("notifications/cancelled", { requestId: 11 });
  const [r1, r2] = await Promise.all([first, second]);
  assert.equal(r1.result.structuredContent.ok, true);
  assert.equal(r2.result.structuredContent.cancelled, true);
  assert.match(r2.result.structuredContent.error, /waiting for the workspace lock/);
  assert.equal(r2.result.structuredContent.exitCode, null, "the cancelled worker must never have started");
  assert.equal(readFileSync(path.join(repo, "hello.txt"), "utf8"), "hello", "workspace untouched");
  s.stop();
});

test("repositories with an unborn HEAD (no commits yet) are supported", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "bridge-unborn-"));
  execSync("git init -q", { cwd: dir });
  execSync("git config user.name test && git config user.email test@example.com", { cwd: dir });
  const cfg = path.join(tmpdir(), "bridge-unborn-backends.json");
  writeFileSync(cfg, JSON.stringify({
    backends: { fake: { command: "node", buildArgs: ["-e", "require('node:fs').writeFileSync('first.txt','ok')", "<task>"], experimental: true } },
  }));
  const s = startServer({ CLI_AGENT_BRIDGE_BACKENDS: cfg });
  await s.rpc(1, "initialize", {});
  const status = await s.rpc(2, "tools/call", { name: "workspace_status", arguments: { workspacePath: dir } });
  assert.equal(status.result.structuredContent.ok, true, JSON.stringify(status.error ?? ""));
  const res = await s.rpc(3, "tools/call", { name: "delegate_task", arguments: { backend: "fake", task: "first file", workspacePath: dir, timeoutMs: 30_000 } });
  const out = res.result.structuredContent;
  assert.equal(out.ok, true, JSON.stringify(out.error));
  assert.equal(out.gitBefore.head, "");
  assert.ok(out.git.changedFiles.includes("first.txt"));
  s.stop();
});

test("codex templates delimit the prompt from CLI options with --", async () => {
  const backends = JSON.parse(readFileSync(path.join(path.dirname(server), "backends.json"), "utf8")).backends;
  assert.deepEqual(backends.codex.buildArgs, ["exec", "--", "<task>"]);
  assert.deepEqual(backends.codex.resumeArgs, ["exec", "resume", "<session>", "--", "<task>"]);
});

