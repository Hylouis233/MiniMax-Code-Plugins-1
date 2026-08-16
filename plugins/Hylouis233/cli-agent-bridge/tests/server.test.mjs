import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const testsRoot = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(testsRoot, "..");
const serverPath = path.join(pluginRoot, "server.mjs");
const fakeBackendPath = path.join(testsRoot, "fake-backend.mjs");

class McpClient {
  constructor(configPath) {
    this.child = execServer(configPath);
    this.pending = new Map();
    this.stderr = "";
    this.nextId = 1;
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk) => { this.stderr += chunk; });
    const lines = createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    lines.on("line", (line) => {
      const message = JSON.parse(line);
      const entry = this.pending.get(String(message.id));
      if (!entry) return;
      clearTimeout(entry.timer);
      this.pending.delete(String(message.id));
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
        this.pending.delete(String(id));
        reject(new Error("timed out waiting for request " + String(id) + ": " + this.stderr));
      }, 25_000);
      this.pending.set(String(id), { resolve, reject, timer });
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
}

function execServer(configPath) {
  return spawn(process.execPath, [serverPath], {
    env: { ...process.env, CLI_AGENT_BRIDGE_BACKENDS: configPath },
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
  return { tempRoot, workspace, client };
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

test("a request cancelled while queued never starts its backend", async (context) => {
  const { tempRoot, workspace, client } = await makeHarness(context);
  const eventFile = path.join(tempRoot, "events.jsonl");
  const first = client.request("tools/call", taskArguments(workspace, {
    name: "holder", eventFile, delayMs: 600,
  }), 101);
  await waitFor(async () => (await events(eventFile)).some((item) => item.name === "holder" && item.event === "start"));
  const queued = client.request("tools/call", taskArguments(path.join(workspace, "."), {
    name: "cancelled", eventFile, writeFile: "must-not-exist.txt",
  }), 102);
  await new Promise((resolve) => setTimeout(resolve, 100));
  client.notify("notifications/cancelled", { requestId: 102, reason: "test cancellation" });

  const [firstResponse, queuedResponse] = await Promise.all([first, queued]);
  assert.equal(firstResponse.result.structuredContent.ok, true);
  assert.equal(queuedResponse.result.isError, true);
  assert.equal(queuedResponse.result.structuredContent.cancelled, true);
  assert.equal((await events(eventFile)).some((item) => item.name === "cancelled"), false);
  await assert.rejects(access(path.join(workspace, "must-not-exist.txt")), /ENOENT/u);
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
