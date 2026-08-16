import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, chmod, copyFile, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { workspaceLockRef } from "../workspace-lock.mjs";

const execFileAsync = promisify(execFile);
const testsRoot = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(testsRoot, "..");
const serverPath = path.join(pluginRoot, "server.mjs");
const fakeBackendPath = path.join(testsRoot, "fake-backend.mjs");
const requestKey = (id) => typeof id + ":" + String(id);

function currentUserLockRoot() {
  const user = os.userInfo();
  const identity = Number.isInteger(user.uid) && user.uid >= 0
    ? process.platform + ":uid:" + String(user.uid)
    : process.platform + ":" + user.username + ":" + user.homedir;
  const scope = createHash("sha256").update(identity).digest("hex").slice(0, 20);
  return path.join(os.tmpdir(), "minimax-cli-agent-bridge-locks-" + scope);
}

function workspaceStatePaths(canonicalRoot) {
  const normalized = path.normalize(canonicalRoot);
  const key = "git-worktree:" + (process.platform === "win32" ? normalized.toLowerCase() : normalized);
  const digest = createHash("sha256").update(key).digest("hex");
  const root = currentUserLockRoot();
  return {
    root,
    quarantinePath: path.join(root, digest + ".quarantine"),
  };
}

class McpClient {
  constructor(configPath, extraEnv = {}) {
    this.child = execServer(configPath, extraEnv);
    this.pending = new Map();
    this.stderr = "";
    this.nextId = 1;
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk) => { this.stderr += chunk; });
    const lines = createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    lines.on("line", (line) => {
      const message = JSON.parse(line);
      const entry = this.pending.get(requestKey(message.id));
      if (!entry) return;
      clearTimeout(entry.timer);
      this.pending.delete(requestKey(message.id));
      entry.resolve(message);
    });
    this.child.on("exit", (code) => {
      for (const entry of this.pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(new Error("server exited with code " + String(code) + ": " + this.stderr));
      }
      this.pending.clear();
    });
  }

  async initialize() {
    const response = await this.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "cli-agent-bridge-test", version: "1.0.0" },
    });
    assert.equal(response.result.protocolVersion, "2025-06-18");
    this.notify("notifications/initialized", {});
  }

  request(method, params, id = this.nextId++) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestKey(id));
        reject(new Error("timed out waiting for request " + String(id) + ": " + this.stderr));
      }, 25_000);
      this.pending.set(requestKey(id), { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  notify(method, params) {
    this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  async close() {
    if (this.child.exitCode !== null) return;
    this.child.kill();
    await new Promise((resolve) => this.child.once("exit", resolve));
  }

  async disconnectInput() {
    if (this.child.exitCode !== null) return;
    const exited = new Promise((resolve) => this.child.once("exit", resolve));
    this.child.stdin.end();
    await Promise.race([
      exited,
      new Promise((_, reject) => setTimeout(() => reject(new Error("server did not exit after stdin closed")), 15_000)),
    ]);
  }
}

function execServer(configPath, extraEnv = {}) {
  return spawn(process.execPath, [serverPath], {
    env: { ...process.env, ...extraEnv, CLI_AGENT_BRIDGE_BACKENDS: configPath },
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

async function makeHarness(context, { unborn = false } = {}) {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "cli-agent-bridge-test-"));
  const workspace = path.join(tempRoot, "workspace");
  await mkdir(workspace);
  await execFileAsync("git", ["init", "-b", "main"], { cwd: workspace });
  await execFileAsync("git", ["config", "user.name", "Bridge Test"], { cwd: workspace });
  await execFileAsync("git", ["config", "user.email", "bridge-test@example.invalid"], { cwd: workspace });
  if (!unborn) {
    await writeFile(path.join(workspace, "baseline.txt"), "baseline\n");
    await execFileAsync("git", ["add", "baseline.txt"], { cwd: workspace });
    await execFileAsync("git", ["commit", "-m", "baseline"], { cwd: workspace });
  }
  const configPath = path.join(tempRoot, "backends.json");
  await writeFile(configPath, JSON.stringify({
    backends: {
      fake: {
        label: "Fake backend",
        command: process.execPath,
        buildArgs: [fakeBackendPath, "<task>"],
        resumeArgs: null,
        experimental: false,
      },
    },
  }));
  const client = new McpClient(configPath);
  await client.initialize();
  context.after(async () => {
    await client.close();
    await rm(tempRoot, { recursive: true, force: true });
  });
  return { tempRoot, workspace, configPath, client };
}

function taskArguments(workspacePath, spec, extra = {}) {
  return {
    name: "delegate_task",
    arguments: {
      backend: "fake",
      task: JSON.stringify(spec),
      workspacePath,
      ...extra,
    },
  };
}

async function events(file) {
  try {
    return (await readFile(file, "utf8")).trim().split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

async function waitFor(predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!await predicate()) {
    if (Date.now() >= deadline) throw new Error("condition was not met before timeout");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test("Codex templates delimit option-looking task text", async () => {
  const backends = JSON.parse(await readFile(path.join(pluginRoot, "backends.json"), "utf8")).backends;
  assert.deepEqual(backends.codex.buildArgs, ["exec", "--", "<task>"]);
  assert.deepEqual(backends.codex.resumeArgs, ["exec", "resume", "<session>", "--", "<task>"]);
  const source = await readFile(serverPath, "utf8");
  assert.match(source, /buildArgs: \["exec", "--", "<task>"\]/u);
  assert.match(source, /resumeArgs: \["exec", "resume", "<session>", "--", "<task>"\]/u);
});

test("canonical Git worktree locking serializes root and symlink paths", async (context) => {
  const { tempRoot, workspace, client } = await makeHarness(context);
  const alias = path.join(tempRoot, "workspace-alias");
  await symlink(workspace, alias, process.platform === "win32" ? "junction" : "dir");
  const eventFile = path.join(tempRoot, "events.jsonl");

  const first = client.request("tools/call", taskArguments(workspace, {
    name: "first", eventFile, delayMs: 500, writeFile: "first.txt",
  }));
  await waitFor(async () => (await events(eventFile)).some((item) => item.name === "first" && item.event === "start"));
  const second = client.request("tools/call", taskArguments(alias, {
    name: "second", eventFile, delayMs: 10, writeFile: "second.txt",
  }, { allowDirty: true }));

  const [firstResponse, secondResponse] = await Promise.all([first, second]);
  assert.equal(firstResponse.result.structuredContent.ok, true);
  assert.equal(secondResponse.result.structuredContent.ok, true);
  assert.deepEqual((await events(eventFile)).map((item) => item.event + ":" + item.name), [
    "start:first", "end:first", "start:second", "end:second",
  ]);
  assert.equal(firstResponse.result.structuredContent.worktreeRoot, secondResponse.result.structuredContent.worktreeRoot);
});

test("canonical worktree locking serializes independent server processes", async (context) => {
  const { tempRoot, workspace, configPath, client } = await makeHarness(context);
  const secondClient = new McpClient(configPath);
  try {
    await secondClient.initialize();
    const eventFile = path.join(tempRoot, "cross-process-events.jsonl");
    const first = client.request("tools/call", taskArguments(workspace, {
      name: "first-server", eventFile, delayMs: 800, writeFile: "first-server.txt",
    }));
    await waitFor(async () => (await events(eventFile)).some(
      (item) => item.name === "first-server" && item.event === "start",
    ));
    const second = secondClient.request("tools/call", taskArguments(workspace, {
      name: "second-server", eventFile, delayMs: 10, writeFile: "second-server.txt",
    }, { allowDirty: true }));

    const [firstResponse, secondResponse] = await Promise.all([first, second]);
    assert.equal(firstResponse.result.structuredContent.ok, true);
    assert.equal(secondResponse.result.structuredContent.ok, true);
    assert.deepEqual((await events(eventFile)).map((item) => item.event + ":" + item.name), [
      "start:first-server", "end:first-server", "start:second-server", "end:second-server",
    ]);
  } finally {
    await secondClient.close();
  }
});

test("a cross-process lock waiter can be cancelled without starting its backend", async (context) => {
  const { tempRoot, workspace, configPath, client } = await makeHarness(context);
  const secondClient = new McpClient(configPath);
  try {
    await secondClient.initialize();
    const eventFile = path.join(tempRoot, "cross-process-cancel-events.jsonl");
    const holder = client.request("tools/call", taskArguments(workspace, {
      name: "cancel-holder", eventFile, delayMs: 3_000,
    }), 121);
    await waitFor(async () => (await events(eventFile)).some(
      (item) => item.name === "cancel-holder" && item.event === "start",
    ));
    const waiter = secondClient.request("tools/call", taskArguments(workspace, {
      name: "cancelled-waiter", eventFile,
    }), 122);
    await new Promise((resolve) => setTimeout(resolve, 150));
    const cancelledAt = Date.now();
    secondClient.notify("notifications/cancelled", { requestId: 122 });

    const waiterResponse = await waiter;
    assert.ok(Date.now() - cancelledAt < 1_500, "cross-process lock cancellation must settle promptly");
    assert.equal(waiterResponse.result.structuredContent.cancelled, true);
    assert.equal((await events(eventFile)).some((item) => item.name === "cancelled-waiter"), false);
    assert.equal((await holder).result.structuredContent.ok, true);
  } finally {
    await secondClient.close();
  }
});

test("a cross-process lock waiter obeys the delegation deadline", async (context) => {
  const { tempRoot, workspace, configPath, client } = await makeHarness(context);
  const secondClient = new McpClient(configPath);
  try {
    await secondClient.initialize();
    const eventFile = path.join(tempRoot, "cross-process-deadline-events.jsonl");
    const holder = client.request("tools/call", taskArguments(workspace, {
      name: "deadline-holder", eventFile, delayMs: 7_000,
    }), 131);
    await waitFor(async () => (await events(eventFile)).some(
      (item) => item.name === "deadline-holder" && item.event === "start",
    ));
    const startedAt = Date.now();
    const waiter = secondClient.request("tools/call", taskArguments(workspace, {
      name: "deadline-waiter", eventFile,
    }, { timeoutMs: 5_000 }), 132);

    const waiterResponse = await waiter;
    const elapsed = Date.now() - startedAt;
    assert.ok(elapsed >= 4_500 && elapsed < 6_500, "lock wait should consume the overall deadline: " + String(elapsed));
    assert.equal(waiterResponse.result.structuredContent.timedOut, true);
    assert.match(waiterResponse.result.structuredContent.error, /waiting for the workspace lock/iu);
    assert.equal((await events(eventFile)).some((item) => item.name === "deadline-waiter"), false);
    assert.equal((await holder).result.structuredContent.ok, true);
  } finally {
    await secondClient.close();
  }
});

test("losing a Git-ref lease never strands the local FIFO gate", async (context) => {
  const { tempRoot, workspace, client } = await makeHarness(context);
  const canonicalRoot = await realpath(workspace);
  const normalized = path.normalize(canonicalRoot);
  const key = "git-worktree:" + (process.platform === "win32" ? normalized.toLowerCase() : normalized);
  const ref = workspaceLockRef(key);
  const eventFile = path.join(tempRoot, "lost-lock-events.jsonl");
  const first = client.request("tools/call", taskArguments(workspace, {
    name: "loses-lock", eventFile, delayMs: 12_000,
  }), 141);
  await waitFor(async () => (await events(eventFile)).some(
    (item) => item.name === "loses-lock" && item.event === "start",
  ));
  await waitFor(async () => {
    try {
      const { stdout: oid } = await execFileAsync("git", ["rev-parse", "--verify", ref], { cwd: workspace });
      const { stdout: blob } = await execFileAsync("git", ["cat-file", "blob", oid.trim()], { cwd: workspace });
      return JSON.parse(blob).workerState === "running";
    } catch {
      return false;
    }
  });

  const replacementPath = path.join(tempRoot, "replacement-owner.json");
  await writeFile(replacementPath, JSON.stringify({ version: 1, hostIdentity: "foreign:test" }));
  const { stdout: replacementOidText } = await execFileAsync("git", ["hash-object", "-w", replacementPath], { cwd: workspace });
  const replacementOid = replacementOidText.trim();
  const replacedAt = Date.now();
  await execFileAsync("git", ["update-ref", ref, replacementOid], { cwd: workspace });
  context.after(async () => {
    try { await execFileAsync("git", ["update-ref", "-d", ref, replacementOid], { cwd: workspace }); } catch { /* already gone */ }
  });

  const firstResponse = await first;
  assert.ok(Date.now() - replacedAt < 9_000, "heartbeat loss must terminate the active worker promptly");
  assert.match(firstResponse.error?.message ?? "", /workspace lock ownership changed/iu);
  assert.equal((await events(eventFile)).some(
    (item) => item.name === "loses-lock" && item.event === "end",
  ), false, "the original 12-second worker should be terminated before normal completion");
  await execFileAsync("git", ["update-ref", "-d", ref, replacementOid], { cwd: workspace });

  const followUp = await client.request("tools/call", taskArguments(workspace, {
    name: "after-lost-lock", eventFile, delayMs: 10,
  }), 142);
  assert.equal(followUp.result.structuredContent.ok, true, JSON.stringify(followUp));
  assert.ok((await events(eventFile)).some((item) => item.name === "after-lost-lock" && item.event === "end"));
});

test("unconfirmed termination after lease loss quarantines delegation and status", {
  skip: process.platform !== "win32",
}, async (context) => {
  const { tempRoot, workspace, configPath } = await makeHarness(context);
  const shimDirectory = path.join(tempRoot, "failing-taskkill");
  await mkdir(shimDirectory);
  const windowsRoot = process.env.SystemRoot ?? "C:\\Windows";
  const realTaskkill = path.join(windowsRoot, "System32", "taskkill.exe");
  await copyFile(path.join(windowsRoot, "System32", "cmd.exe"), path.join(shimDirectory, "taskkill.exe"));
  const client = new McpClient(configPath, {
    NODE_ENV: "test",
    CLI_AGENT_BRIDGE_TEST_KILL_GRACE_MS: "100",
    PATH: shimDirectory + path.delimiter + process.env.PATH,
  });
  const eventFile = path.join(tempRoot, "quarantine-events.jsonl");
  let workerPid = null;
  let replacementOid = null;
  let ref = null;
  let quarantinePath = null;
  try {
    await client.initialize();
    const canonicalRoot = await realpath(workspace);
    ({ quarantinePath } = workspaceStatePaths(canonicalRoot));
    context.after(() => rm(quarantinePath, { force: true }));
    const normalized = path.normalize(canonicalRoot);
    const key = "git-worktree:" + normalized.toLowerCase();
    ref = workspaceLockRef(key);
    const delegated = client.request("tools/call", taskArguments(workspace, {
      name: "unconfirmed-tree", eventFile, delayMs: 60_000,
    }), 151);
    await waitFor(async () => {
      const started = (await events(eventFile)).find(
        (item) => item.name === "unconfirmed-tree" && item.event === "start",
      );
      workerPid = started?.pid ?? null;
      return Number.isInteger(workerPid);
    });
    await waitFor(async () => {
      try {
        const { stdout: oid } = await execFileAsync("git", ["rev-parse", "--verify", ref], { cwd: workspace });
        const { stdout: blob } = await execFileAsync("git", ["cat-file", "blob", oid.trim()], { cwd: workspace });
        return JSON.parse(blob).workerState === "running";
      } catch {
        return false;
      }
    });
    const replacementPath = path.join(tempRoot, "quarantine-replacement-owner.json");
    await writeFile(replacementPath, JSON.stringify({ version: 1, hostIdentity: "foreign:quarantine" }));
    const replacement = await execFileAsync("git", ["hash-object", "-w", replacementPath], { cwd: workspace });
    replacementOid = replacement.stdout.trim();
    const queuedStatus = client.request("tools/call", {
      name: "workspace_status",
      arguments: { workspacePath: workspace },
    }, 153);
    await execFileAsync("git", ["update-ref", ref, replacementOid], { cwd: workspace });

    const failed = await delegated;
    assert.match(failed.error?.message ?? "", /workspace lock ownership changed/iu);
    const status = await queuedStatus;
    assert.equal(status.result.structuredContent.git, null);
    assert.match(status.result.structuredContent.error, /could not be confirmed terminated/iu);
    const followUp = await client.request("tools/call", taskArguments(workspace, {
      name: "must-not-start-after-quarantine", eventFile,
    }), 152);
    assert.equal(followUp.result.structuredContent.treeTerminated, false);
    assert.match(followUp.result.structuredContent.error, /quarantined/iu);
    assert.equal((await events(eventFile)).some(
      (item) => item.name === "must-not-start-after-quarantine",
    ), false);

    await execFileAsync(realTaskkill, ["/PID", String(workerPid), "/T", "/F"]);
    workerPid = null;
    await rm(quarantinePath, { force: true });
    await execFileAsync("git", ["update-ref", "-d", ref, replacementOid], { cwd: workspace });
    replacementOid = null;
    const recovered = await client.request("tools/call", taskArguments(workspace, {
      name: "after-manual-quarantine-recovery", eventFile, delayMs: 10,
    }), 154);
    assert.equal(recovered.result.structuredContent.ok, true, JSON.stringify(recovered));
  } finally {
    if (ref && replacementOid) {
      try { await execFileAsync("git", ["update-ref", "-d", ref, replacementOid], { cwd: workspace }); } catch { /* already gone */ }
    }
    if (Number.isInteger(workerPid)) {
      try { await execFileAsync(realTaskkill, ["/PID", String(workerPid), "/T", "/F"]); } catch { /* already gone */ }
    }
    await client.close();
  }
});

test("a quarantine marker blocks delegations in every server process", async (context) => {
  const { workspace, configPath } = await makeHarness(context);
  const secondClient = new McpClient(configPath);
  try {
    await secondClient.initialize();
    const { root, quarantinePath } = workspaceStatePaths(await realpath(workspace));
    await mkdir(root, { recursive: true });
    context.after(() => rm(quarantinePath, { force: true }));
    await writeFile(quarantinePath, JSON.stringify({ terminationError: "fixture" }));
    const response = await secondClient.request("tools/call", taskArguments(workspace, {
      name: "must-not-run", writeFile: "quarantine-bypass.txt",
    }), 131);
    assert.equal(response.result.structuredContent.ok, false);
    assert.equal(response.result.structuredContent.quarantinePath, quarantinePath);
    assert.match(response.result.structuredContent.error, /quarantined/iu);
    await assert.rejects(access(path.join(workspace, "quarantine-bypass.txt")), /ENOENT/u);
  } finally {
    await secondClient.close();
  }
});

test("a request cancelled while queued never starts its backend", async (context) => {
  const { tempRoot, workspace, client } = await makeHarness(context);
  const eventFile = path.join(tempRoot, "events.jsonl");
  const first = client.request("tools/call", taskArguments(workspace, {
    name: "holder", eventFile, delayMs: 3_000,
  }), 101);
  await waitFor(async () => (await events(eventFile)).some((item) => item.name === "holder" && item.event === "start"));
  const queued = client.request("tools/call", taskArguments(path.join(workspace, "."), {
    name: "cancelled", eventFile, writeFile: "must-not-exist.txt",
  }), 102);
  await new Promise((resolve) => setTimeout(resolve, 100));
  const cancelledAt = Date.now();
  client.notify("notifications/cancelled", { requestId: 102, reason: "test cancellation" });

  const queuedResponse = await queued;
  assert.ok(Date.now() - cancelledAt < 1_500, "queued cancellation should bypass the held workspace lock");
  const third = client.request("tools/call", taskArguments(workspace, {
    name: "third", eventFile, delayMs: 10,
  }), 103);
  const [firstResponse, thirdResponse] = await Promise.all([first, third]);
  assert.equal(firstResponse.result.structuredContent.ok, true);
  assert.equal(thirdResponse.result.structuredContent.ok, true);
  assert.equal(queuedResponse.result.isError, true);
  assert.equal(queuedResponse.result.structuredContent.cancelled, true);
  assert.equal((await events(eventFile)).some((item) => item.name === "cancelled"), false);
  assert.deepEqual((await events(eventFile)).map((item) => item.event + ":" + item.name), [
    "start:holder", "end:holder", "start:third", "end:third",
  ]);
  await assert.rejects(access(path.join(workspace, "must-not-exist.txt")), /ENOENT/u);
});

test("cancellation interrupts initial Git repository discovery", {
  skip: process.platform === "win32",
}, async (context) => {
  const { tempRoot, workspace, configPath } = await makeHarness(context);
  const eventFile = path.join(tempRoot, "git-discovery-events.jsonl");
  const wrapper = path.join(tempRoot, "git");
  await writeFile(wrapper, [
    "#!/usr/bin/env node",
    "const { appendFileSync } = require('node:fs');",
    "appendFileSync(" + JSON.stringify(eventFile) + ", JSON.stringify({event:'git-start'}) + '\\n');",
    "setTimeout(() => {}, 60000);",
  ].join("\n"));
  await chmod(wrapper, 0o755);
  const delayedClient = new McpClient(configPath, {
    PATH: tempRoot + path.delimiter + process.env.PATH,
  });
  try {
    await delayedClient.initialize();
    const pending = delayedClient.request("tools/call", taskArguments(workspace, {
      name: "must-not-start", writeFile: "discovery-cancelled.txt",
    }), 111);
    await waitFor(async () => (await events(eventFile)).some((item) => item.event === "git-start"));
    const cancelledAt = Date.now();
    delayedClient.notify("notifications/cancelled", { requestId: 111 });
    const response = await pending;
    assert.ok(Date.now() - cancelledAt < 1_500, "Git discovery cancellation should settle promptly");
    assert.equal(response.result.structuredContent.cancelled, true);
    await assert.rejects(access(path.join(workspace, "discovery-cancelled.txt")), /ENOENT/u);
  } finally {
    await delayedClient.close();
  }
});

test("cancellation terminates descendants before returning", async (context) => {
  const { tempRoot, workspace, client } = await makeHarness(context);
  const eventFile = path.join(tempRoot, "events.jsonl");
  const delegated = client.request("tools/call", taskArguments(workspace, {
    name: "tree",
    eventFile,
    spawnDescendant: true,
    descendantDelayMs: 1_200,
    descendantWriteFile: "descendant-survived.txt",
  }), 201);
  await waitFor(async () => (await events(eventFile)).some((item) => item.event === "descendant-start"));
  client.notify("notifications/cancelled", { requestId: 201, reason: "test process-tree cancellation" });

  const response = await delegated;
  assert.ok(response.result, JSON.stringify(response));
  assert.equal(response.result.isError, true);
  assert.equal(response.result.structuredContent.cancelled, true);
  assert.equal(response.result.structuredContent.treeTerminated, true);
  const followUp = await client.request("tools/call", taskArguments(workspace, {
    name: "after-cancel", writeFile: "follow-up.txt", contents: "safe\n",
  }));
  assert.equal(followUp.result.structuredContent.ok, true);
  await new Promise((resolve) => setTimeout(resolve, 1_400));
  await assert.rejects(access(path.join(workspace, "descendant-survived.txt")), /ENOENT/u);
});

test("cancellation terminates a descendant that creates a new POSIX session", {
  skip: process.platform === "win32",
}, async (context) => {
  const { tempRoot, workspace, client } = await makeHarness(context);
  const eventFile = path.join(tempRoot, "detached-descendant-events.jsonl");
  const delegated = client.request("tools/call", taskArguments(workspace, {
    name: "detached-tree",
    eventFile,
    spawnDescendant: true,
    detachedDescendant: true,
    descendantDelayMs: 1_200,
    descendantWriteFile: "detached-descendant-survived.txt",
  }), 211);
  await waitFor(async () => (await events(eventFile)).some((item) => item.event === "descendant-start"));
  // Give the 25 ms ancestry monitor time to record the detached child before cancellation.
  await new Promise((resolve) => setTimeout(resolve, 100));
  client.notify("notifications/cancelled", { requestId: 211 });

  const response = await delegated;
  assert.equal(response.result.structuredContent.cancelled, true);
  assert.equal(response.result.structuredContent.treeTerminated, true);
  await new Promise((resolve) => setTimeout(resolve, 1_400));
  await assert.rejects(access(path.join(workspace, "detached-descendant-survived.txt")), /ENOENT/u);
});

test("timeout terminates descendants before releasing the request", async (context) => {
  const { tempRoot, workspace, client } = await makeHarness(context);
  const eventFile = path.join(tempRoot, "events.jsonl");
  const startedAt = Date.now();
  const response = await client.request("tools/call", taskArguments(workspace, {
    name: "timeout-tree",
    eventFile,
    spawnDescendant: true,
    descendantDelayMs: 8_000,
    descendantWriteFile: "timeout-descendant-survived.txt",
  }, { timeoutMs: 5_000 }), 202);

  assert.ok(response.result, JSON.stringify(response));
  assert.equal(response.result.isError, true);
  assert.equal(response.result.structuredContent.timedOut, true);
  assert.equal(response.result.structuredContent.treeTerminated, true);
  const remaining = Math.max(0, 8_500 - (Date.now() - startedAt));
  await new Promise((resolve) => setTimeout(resolve, remaining));
  await assert.rejects(access(path.join(workspace, "timeout-descendant-survived.txt")), /ENOENT/u);
});

test("workspace status and delegation support an unborn HEAD", async (context) => {
  const { workspace, client } = await makeHarness(context, { unborn: true });
  const status = await client.request("tools/call", {
    name: "workspace_status",
    arguments: { workspacePath: workspace },
  });
  assert.equal(status.result.structuredContent.ok, true);
  assert.equal(status.result.structuredContent.git.head, "");

  const delegated = await client.request("tools/call", taskArguments(workspace, {
    name: "unborn", writeFile: "created.txt", contents: "created\n",
  }));
  assert.equal(delegated.result.structuredContent.ok, true);
  assert.equal(delegated.result.structuredContent.gitBefore.head, "");
  assert.deepEqual(delegated.result.structuredContent.git.changedFiles, ["created.txt"]);
});

test("commits on a new branch are reported when the worker returns to the original HEAD", async (context) => {
  const { workspace, client } = await makeHarness(context);
  const response = await client.request("tools/call", taskArguments(workspace, {
    name: "branch-round-trip",
    branchRoundTrip: true,
    branchName: "worker-created-branch",
    writeFile: "branch-only.txt",
    commitMessage: "commit outside final HEAD",
  }));
  const out = response.result.structuredContent;
  assert.equal(out.ok, true, JSON.stringify(out.error));
  assert.equal(out.gitBefore.head, out.git.head, "worker must return to the original HEAD");
  assert.deepEqual(out.git.changedFiles, []);
  assert.ok(out.commits, "ref changes must produce a commits block even when HEAD is unchanged");
  assert.ok(out.commits.refsChanged.some((item) =>
    item.ref === "refs/heads/worker-created-branch" && !item.before && item.after,
  ), JSON.stringify(out.commits.refsChanged));
  assert.match(out.commits.log, /commit outside final HEAD/u);
});

test("changedFiles preserves unusual names and scans from the worktree root", async (context) => {
  const { workspace, client } = await makeHarness(context);
  const nested = path.join(workspace, "nested", "deep");
  await mkdir(nested, { recursive: true });
  await execFileAsync("git", ["config", "core.quotePath", "true"], { cwd: workspace });
  const leading = path.join(nested, " leading.txt");
  await writeFile(leading, "before\n");
  await execFileAsync("git", ["add", "nested/deep/ leading.txt"], { cwd: workspace });
  await execFileAsync("git", ["commit", "-m", "add unusual path"], { cwd: workspace });
  await writeFile(leading, "after\n");
  await writeFile(path.join(nested, "café-staged.txt"), "staged\n");
  await execFileAsync("git", ["add", "nested/deep/café-staged.txt"], { cwd: workspace });
  await writeFile(path.join(nested, "café-untracked.txt"), "untracked\n");
  await writeFile(path.join(workspace, "root-new.txt"), "root\n");

  const status = await client.request("tools/call", {
    name: "workspace_status",
    arguments: { workspacePath: nested },
  });
  const names = status.result.structuredContent.git.changedFiles;
  assert.ok(names.includes("nested/deep/ leading.txt"), JSON.stringify(names));
  assert.ok(names.includes("nested/deep/café-staged.txt"), JSON.stringify(names));
  assert.ok(names.includes("nested/deep/café-untracked.txt"), JSON.stringify(names));
  assert.ok(names.includes("root-new.txt"), JSON.stringify(names));
  assert.equal(status.result.structuredContent.worktreeRoot, await realpath(workspace));
});

test("truncated backend capture is disclosed instead of presented as complete", async (context) => {
  const { workspace, client } = await makeHarness(context);
  const response = await client.request("tools/call", taskArguments(workspace, {
    name: "large-output", stdoutChars: 5_100_000,
  }));
  const out = response.result.structuredContent;
  assert.equal(out.ok, true);
  assert.equal(out.outputTruncated, true);
  assert.ok(out.outputTail.length <= 60_000);
});

test("numeric and string JSON-RPC request IDs remain distinct", async (context) => {
  const { tempRoot, workspace, client } = await makeHarness(context);
  const secondWorkspace = path.join(tempRoot, "workspace-two");
  await mkdir(secondWorkspace);
  await execFileAsync("git", ["init", "-b", "main"], { cwd: secondWorkspace });
  await execFileAsync("git", ["config", "user.name", "Bridge Test"], { cwd: secondWorkspace });
  await execFileAsync("git", ["config", "user.email", "bridge-test@example.invalid"], { cwd: secondWorkspace });
  await writeFile(path.join(secondWorkspace, "baseline.txt"), "baseline\n");
  await execFileAsync("git", ["add", "baseline.txt"], { cwd: secondWorkspace });
  await execFileAsync("git", ["commit", "-m", "baseline"], { cwd: secondWorkspace });
  const eventFile = path.join(tempRoot, "typed-id-events.jsonl");

  const numeric = client.request("tools/call", taskArguments(workspace, {
    name: "numeric", eventFile, delayMs: 2_500, writeFile: "numeric.txt",
  }), 301);
  const string = client.request("tools/call", taskArguments(secondWorkspace, {
    name: "string", eventFile, delayMs: 300, writeFile: "string.txt",
  }), "301");
  await waitFor(async () => {
    const seen = await events(eventFile);
    return seen.some((item) => item.name === "numeric" && item.event === "start") &&
      seen.some((item) => item.name === "string" && item.event === "start");
  });
  client.notify("notifications/cancelled", { requestId: 301 });

  const [numericResponse, stringResponse] = await Promise.all([numeric, string]);
  assert.equal(numericResponse.result.structuredContent.cancelled, true);
  assert.equal(stringResponse.result.structuredContent.ok, true);
  await assert.rejects(access(path.join(workspace, "numeric.txt")), /ENOENT/u);
  await access(path.join(secondWorkspace, "string.txt"));
});

test("workspace_status waits for an active delegation on the same worktree", async (context) => {
  const { tempRoot, workspace, client } = await makeHarness(context);
  const nested = path.join(workspace, "nested");
  await mkdir(nested);
  const eventFile = path.join(tempRoot, "status-lock-events.jsonl");
  const delegated = client.request("tools/call", taskArguments(workspace, {
    name: "holder", eventFile, delayMs: 1_200, writeFile: "finished.txt",
  }));
  await waitFor(async () => (await events(eventFile)).some((item) => item.event === "start"));
  const status = client.request("tools/call", {
    name: "workspace_status",
    arguments: { workspacePath: nested },
  });
  const early = await Promise.race([
    status.then(() => "completed"),
    new Promise((resolve) => setTimeout(() => resolve("pending"), 250)),
  ]);
  assert.equal(early, "pending", "status snapshot must wait for the delegation lock");
  const [delegatedResponse, statusResponse] = await Promise.all([delegated, status]);
  assert.equal(delegatedResponse.result.structuredContent.ok, true);
  assert.ok(statusResponse.result.structuredContent.git.changedFiles.includes("finished.txt"));
});

test("workspace_status can be cancelled while queued for the workspace lock", async (context) => {
  const { tempRoot, workspace, client } = await makeHarness(context);
  const eventFile = path.join(tempRoot, "status-cancel-events.jsonl");
  const delegated = client.request("tools/call", taskArguments(workspace, {
    name: "holder", eventFile, delayMs: 2_000,
  }), 501);
  await waitFor(async () => (await events(eventFile)).some((item) => item.event === "start"));
  const status = client.request("tools/call", {
    name: "workspace_status",
    arguments: { workspacePath: workspace },
  }, 502);
  await new Promise((resolve) => setTimeout(resolve, 100));
  const cancelledAt = Date.now();
  client.notify("notifications/cancelled", { requestId: 502 });

  const statusResponse = await status;
  assert.ok(Date.now() - cancelledAt < 1_500, "queued status cancellation should settle promptly");
  assert.equal(statusResponse.result.isError, true);
  assert.equal(statusResponse.result.structuredContent.cancelled, true);
  assert.equal(statusResponse.result.structuredContent.git, null);
  assert.equal((await delegated).result.structuredContent.ok, true);
});

test("closing MCP stdin terminates active worker descendants", async (context) => {
  const { tempRoot, workspace, client } = await makeHarness(context);
  const eventFile = path.join(tempRoot, "shutdown-events.jsonl");
  const pending = client.request("tools/call", taskArguments(workspace, {
    name: "shutdown-tree",
    eventFile,
    spawnDescendant: true,
    descendantDelayMs: 1_500,
    descendantWriteFile: "shutdown-descendant-survived.txt",
  }), 401).catch(() => null);
  await waitFor(async () => (await events(eventFile)).some((item) => item.event === "descendant-start"));
  await client.disconnectInput();
  await pending;
  await new Promise((resolve) => setTimeout(resolve, 1_700));
  await assert.rejects(access(path.join(workspace, "shutdown-descendant-survived.txt")), /ENOENT/u);
});

test("checking out a pre-existing divergent branch is not reported as worker commits", async (context) => {
  const { workspace, client } = await makeHarness(context);
  // Create a divergent branch whose commits predate the delegation.
  await execFileAsync("git", ["checkout", "-b", "divergent"], { cwd: workspace });
  await writeFile(path.join(workspace, "divergent.txt"), "pre-existing history\n");
  await execFileAsync("git", ["add", "divergent.txt"], { cwd: workspace });
  await execFileAsync("git", ["commit", "-m", "pre-existing divergent commit"], { cwd: workspace });
  await execFileAsync("git", ["checkout", "main"], { cwd: workspace });

  const response = await client.request("tools/call", taskArguments(workspace, {
    name: "checkout-only", checkoutExisting: true, branchName: "divergent",
  }));
  const out = response.result.structuredContent;
  assert.equal(out.ok, true, JSON.stringify(out.error));
  assert.notEqual(out.gitBefore.head, out.git.head, "worker must have moved HEAD");
  assert.ok(out.commits, "a HEAD movement must still produce a commits block");
  assert.match(out.commits.log, /branch checkout or reset/u);
  assert.doesNotMatch(out.commits.log, /pre-existing divergent commit/u,
    "history that predates the delegation must not be attributed to the worker");
});

test("a worker ref pointing at a non-commit object is reported without failing the delegation", async (context) => {
  const { workspace, client } = await makeHarness(context);
  const response = await client.request("tools/call", taskArguments(workspace, {
    name: "blob-tag", blobTag: true, refName: "refs/tags/blobtag",
  }));
  assert.equal(response.result.error, undefined, "the delegation must not surface a JSON-RPC error");
  const out = response.result.structuredContent;
  assert.equal(out.ok, true, JSON.stringify(out.error));
  assert.ok(out.commits.refsChanged.some((item) => item.ref === "refs/tags/blobtag" && item.after),
    JSON.stringify(out.commits.refsChanged));
  assert.match(out.commits.log, /non-commit object/u);
});

test("parallel worktree delegations disclose repository concurrency", async (context) => {
  const harness = await makeHarness(context);
  const { tempRoot, workspace, configPath } = harness;
  // A second independent worktree of the same repository: per-worktree locks
  // are distinct while repository refs are shared.
  const secondWorktree = path.join(tempRoot, "second-worktree");
  await execFileAsync("git", ["worktree", "add", secondWorktree], { cwd: workspace });

  const eventFile = path.join(tempRoot, "parallel-events.log");
  const slowSpec = { name: "slow", delayMs: 3_000, eventFile };
  const fastClient = new McpClient(configPath);
  await fastClient.initialize();
  context.after(async () => { await fastClient.close(); });

  const slowPromise = harness.client.request("tools/call", taskArguments(workspace, slowSpec));
  await waitFor(async () => (await events(eventFile)).some((item) => item.event === "start"));
  const overlapping = await fastClient.request("tools/call", taskArguments(secondWorktree, {
    name: "fast-in-worktree", delayMs: 0,
  }));
  const overlappingOut = overlapping.result.structuredContent;
  assert.equal(overlappingOut.ok, true, JSON.stringify(overlappingOut.error));
  assert.equal(overlappingOut.repositoryConcurrency, true,
    "an overlapping delegation in a linked worktree must disclose concurrency");
  const slowOut = (await slowPromise).result.structuredContent;
  assert.equal(slowOut.ok, true, JSON.stringify(slowOut.error));
  assert.equal(slowOut.repositoryConcurrency, true,
    "the slow delegation observed the overlapping worker in its after snapshot");
});

test("PowerShell shim runner fails closed for a missing backend", {
  skip: process.platform !== "win32",
}, async () => {
  const runner = path.join(pluginRoot, "ps1-runner.ps1");
  let failure = null;
  try {
    await execFileAsync("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", runner,
      "cli-agent-bridge-command-that-does-not-exist", "--version",
    ]);
  } catch (error) {
    failure = error;
  }
  assert.ok(failure, "missing backend must return a non-zero exit code");
  assert.notEqual(failure.code, 0);
});
