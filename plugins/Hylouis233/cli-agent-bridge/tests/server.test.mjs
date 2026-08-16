import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, chmod, copyFile, mkdir, mkdtemp, readFile, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
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

async function canonicalGitCommonDirectory(workspace) {
  const { stdout } = await execFileAsync("git", ["rev-parse", "--git-common-dir"], { cwd: workspace });
  return await realpath(path.resolve(workspace, stdout.replace(/\r?\n$/u, "")));
}

async function coordinationLockStore(workspace) {
  return path.join(await canonicalGitCommonDirectory(workspace), "cli-agent-bridge-lock-store.git");
}

function repositoryStatePaths(canonicalGitCommonDir) {
  const normalized = path.normalize(canonicalGitCommonDir);
  const key = "git-common-dir:" + normalized;
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

test("dirty checks include untracked files even when Git config hides them", async (context) => {
  const { workspace, client } = await makeHarness(context);
  await execFileAsync("git", ["config", "status.showUntrackedFiles", "no"], { cwd: workspace });
  await writeFile(path.join(workspace, "hidden-untracked.txt"), "pre-existing\n");
  const response = await client.request("tools/call", taskArguments(workspace, {
    name: "must-not-start", writeFile: "worker-output.txt",
  }));
  const out = response.result.structuredContent;
  assert.equal(out.ok, false);
  assert.match(out.error, /working tree is dirty/iu);
  assert.ok(out.gitBefore.changedFiles.includes("hidden-untracked.txt"));
  await assert.rejects(access(path.join(workspace, "worker-output.txt")), /ENOENT/u);
});

test("porcelain status preserves the unstaged first-column space", async (context) => {
  const { workspace, client } = await makeHarness(context);
  await writeFile(path.join(workspace, "baseline.txt"), "unstaged change\n");
  const response = await client.request("tools/call", {
    name: "workspace_status", arguments: { workspacePath: workspace },
  });
  assert.match(response.result.structuredContent.git.statusShort, /^ M baseline\.txt$/u);
});

test("dirty checks override submodule ignore configuration", async (context) => {
  const { tempRoot, workspace, client } = await makeHarness(context);
  const source = path.join(tempRoot, "submodule-source");
  await mkdir(source);
  await execFileAsync("git", ["init", "-b", "main"], { cwd: source });
  await execFileAsync("git", ["config", "user.name", "Bridge Test"], { cwd: source });
  await execFileAsync("git", ["config", "user.email", "bridge-test@example.invalid"], { cwd: source });
  await writeFile(path.join(source, "tracked.txt"), "baseline\n");
  await execFileAsync("git", ["add", "tracked.txt"], { cwd: source });
  await execFileAsync("git", ["commit", "-m", "submodule baseline"], { cwd: source });
  await execFileAsync("git", ["-c", "protocol.file.allow=always", "submodule", "add", source, "nested-submodule"], {
    cwd: workspace,
  });
  await execFileAsync("git", ["commit", "-am", "add submodule"], { cwd: workspace });
  await execFileAsync("git", ["config", "submodule.nested-submodule.ignore", "all"], { cwd: workspace });
  await writeFile(path.join(workspace, "nested-submodule", "tracked.txt"), "pre-existing edit\n");

  const response = await client.request("tools/call", taskArguments(workspace, {
    name: "must-not-start", writeFile: "submodule-bypass.txt",
  }));
  const out = response.result.structuredContent;
  assert.equal(out.ok, false);
  assert.match(out.error, /working tree is dirty/iu);
  assert.match(out.gitBefore.statusShort, /nested-submodule/u);
  assert.ok(out.gitBefore.changedFiles.includes("nested-submodule"));
  await assert.rejects(access(path.join(workspace, "submodule-bypass.txt")), /ENOENT/u);
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

test("a retargeted workspace symlink cannot redirect a queued worker", async (context) => {
  if (process.platform === "win32") return; // creating/retargeting symlinks is privilege-dependent
  const { tempRoot, workspace, client } = await makeHarness(context);
  const other = path.join(tempRoot, "other-workspace");
  await mkdir(other);
  await execFileAsync("git", ["init", "-b", "main"], { cwd: other });
  await execFileAsync("git", ["config", "user.name", "Bridge Test"], { cwd: other });
  await execFileAsync("git", ["config", "user.email", "bridge-test@example.invalid"], { cwd: other });
  await writeFile(path.join(other, "baseline.txt"), "other baseline\n");
  await execFileAsync("git", ["add", "baseline.txt"], { cwd: other });
  await execFileAsync("git", ["commit", "-m", "other baseline"], { cwd: other });
  const alias = path.join(tempRoot, "retargetable-workspace");
  await symlink(workspace, alias, "dir");
  const eventFile = path.join(tempRoot, "retarget-events.jsonl");
  const holder = client.request("tools/call", taskArguments(workspace, {
    name: "holder", eventFile, delayMs: 900, writeFile: "holder.txt",
  }));
  await waitFor(async () => (await events(eventFile)).some((item) => item.name === "holder" && item.event === "start"));
  const queued = client.request("tools/call", taskArguments(alias, {
    name: "queued", eventFile, writeFile: "queued.txt",
  }, { allowDirty: true }));
  await new Promise((resolve) => setTimeout(resolve, 200));
  await unlink(alias);
  await symlink(other, alias, "dir");

  assert.equal((await holder).result.structuredContent.ok, true);
  assert.equal((await queued).result.structuredContent.ok, true);
  await access(path.join(workspace, "queued.txt"));
  await assert.rejects(access(path.join(other, "queued.txt")), /ENOENT/u);
});

test("relative backend commands resolve from their configuration directory", async (context) => {
  if (process.platform === "win32") return; // executable symlink setup is POSIX-specific
  const { tempRoot, workspace } = await makeHarness(context);
  const configDirectory = path.join(tempRoot, "relative-config");
  await mkdir(configDirectory);
  const nodeAlias = path.join(configDirectory, "node-wrapper");
  await symlink(process.execPath, nodeAlias, "file");
  const configPath = path.join(configDirectory, "backends.json");
  await writeFile(configPath, JSON.stringify({ backends: { relative: {
    label: "Relative fixture", command: "./node-wrapper",
    buildArgs: [fakeBackendPath, "<task>"], resumeArgs: null, experimental: false,
  } } }));
  const relativeClient = new McpClient(configPath);
  context.after(() => relativeClient.close());
  await relativeClient.initialize();
  const listed = await relativeClient.request("tools/call", { name: "list_backends", arguments: {} });
  assert.equal(listed.result.structuredContent.backends[0].available, true);
  const delegated = await relativeClient.request("tools/call", {
    name: "delegate_task",
    arguments: {
      backend: "relative", task: JSON.stringify({ name: "relative", writeFile: "relative.txt" }),
      workspacePath: workspace,
    },
  });
  assert.equal(delegated.result.structuredContent.ok, true, delegated.result.structuredContent.error);
  await access(path.join(workspace, "relative.txt"));
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
  const canonicalRoot = await canonicalGitCommonDirectory(workspace);
  const normalized = path.normalize(canonicalRoot);
  const key = "git-common-dir:" + normalized;
  const ref = workspaceLockRef(key);
  const lockStore = await coordinationLockStore(workspace);
  const eventFile = path.join(tempRoot, "lost-lock-events.jsonl");
  const first = client.request("tools/call", taskArguments(workspace, {
    name: "loses-lock", eventFile, delayMs: 12_000,
  }), 141);
  await waitFor(async () => (await events(eventFile)).some(
    (item) => item.name === "loses-lock" && item.event === "start",
  ));
  await waitFor(async () => {
    try {
      const { stdout: oid } = await execFileAsync("git", ["rev-parse", "--verify", ref], { cwd: lockStore });
      const { stdout: blob } = await execFileAsync("git", ["cat-file", "blob", oid.trim()], { cwd: lockStore });
      return JSON.parse(blob).workerState === "running";
    } catch {
      return false;
    }
  });

  const replacementPath = path.join(tempRoot, "replacement-owner.json");
  await writeFile(replacementPath, JSON.stringify({ version: 1, hostIdentity: "foreign:test" }));
  const { stdout: replacementOidText } = await execFileAsync("git", ["hash-object", "-w", replacementPath], { cwd: lockStore });
  const replacementOid = replacementOidText.trim();
  const replacedAt = Date.now();
  await execFileAsync("git", ["update-ref", ref, replacementOid], { cwd: lockStore });
  context.after(async () => {
    try { await execFileAsync("git", ["update-ref", "-d", ref, replacementOid], { cwd: lockStore }); } catch { /* already gone */ }
  });

  const firstResponse = await first;
  assert.ok(Date.now() - replacedAt < 9_000, "heartbeat loss must terminate the active worker promptly");
  assert.match(firstResponse.error?.message ?? "", /workspace lock ownership changed/iu);
  assert.equal((await events(eventFile)).some(
    (item) => item.name === "loses-lock" && item.event === "end",
  ), false, "the original 12-second worker should be terminated before normal completion");
  await execFileAsync("git", ["update-ref", "-d", ref, replacementOid], { cwd: lockStore });

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
  let lockStore = null;
  let quarantinePath = null;
  try {
    await client.initialize();
    const canonicalRoot = await canonicalGitCommonDirectory(workspace);
    ({ quarantinePath } = repositoryStatePaths(canonicalRoot));
    context.after(() => rm(quarantinePath, { force: true }));
    const normalized = path.normalize(canonicalRoot);
    const key = "git-common-dir:" + normalized;
    ref = workspaceLockRef(key);
    lockStore = await coordinationLockStore(workspace);
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
        const { stdout: oid } = await execFileAsync("git", ["rev-parse", "--verify", ref], { cwd: lockStore });
        const { stdout: blob } = await execFileAsync("git", ["cat-file", "blob", oid.trim()], { cwd: lockStore });
        return JSON.parse(blob).workerState === "running";
      } catch {
        return false;
      }
    });
    const replacementPath = path.join(tempRoot, "quarantine-replacement-owner.json");
    await writeFile(replacementPath, JSON.stringify({ version: 1, hostIdentity: "foreign:quarantine" }));
    const replacement = await execFileAsync("git", ["hash-object", "-w", replacementPath], { cwd: lockStore });
    replacementOid = replacement.stdout.trim();
    const queuedStatus = client.request("tools/call", {
      name: "workspace_status",
      arguments: { workspacePath: workspace },
    }, 153);
    await execFileAsync("git", ["update-ref", ref, replacementOid], { cwd: lockStore });

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
    await execFileAsync("git", ["update-ref", "-d", ref, replacementOid], { cwd: lockStore });
    replacementOid = null;
    const recovered = await client.request("tools/call", taskArguments(workspace, {
      name: "after-manual-quarantine-recovery", eventFile, delayMs: 10,
    }), 154);
    assert.equal(recovered.result.structuredContent.ok, true, JSON.stringify(recovered));
  } finally {
    if (ref && replacementOid && lockStore) {
      try { await execFileAsync("git", ["update-ref", "-d", ref, replacementOid], { cwd: lockStore }); } catch { /* already gone */ }
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
    const { root, quarantinePath } = repositoryStatePaths(
      await canonicalGitCommonDirectory(workspace),
    );
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

test("cancellation interrupts workspace filesystem canonicalization", async (context) => {
  const { workspace, configPath } = await makeHarness(context);
  const delayedClient = new McpClient(configPath, {
    NODE_ENV: "test",
    CLI_AGENT_BRIDGE_TEST_WORKSPACE_VALIDATION_DELAY_MS: "10000",
  });
  context.after(() => delayedClient.close());
  await delayedClient.initialize();
  const request = delayedClient.request("tools/call", taskArguments(workspace, {
    name: "must-not-start", writeFile: "canonicalization-bypass.txt",
  }), 611);
  await new Promise((resolve) => setTimeout(resolve, 100));
  const cancelledAt = Date.now();
  delayedClient.notify("notifications/cancelled", { requestId: 611 });
  const response = await request;
  assert.ok(Date.now() - cancelledAt < 1_500,
    "filesystem validation must not pin the request after cancellation");
  assert.equal(response.result.structuredContent.cancelled, true);
  await assert.rejects(access(path.join(workspace, "canonicalization-bypass.txt")), /ENOENT/u);
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

test("a detached child remains contained when its parent exits before ancestry polling", {
  skip: process.platform !== "linux",
}, async (context) => {
  const { tempRoot, workspace, client } = await makeHarness(context);
  const eventFile = path.join(tempRoot, "fast-parent-events.jsonl");
  const response = await client.request("tools/call", taskArguments(workspace, {
    name: "fast-parent",
    eventFile,
    spawnDescendant: true,
    detachedDescendant: true,
    parentDelayMs: 0,
    descendantDelayMs: 1_200,
    descendantWriteFile: "fast-parent-descendant-survived.txt",
  }));
  const out = response.result.structuredContent;
  assert.equal(out.treeTerminated, true, JSON.stringify(out));
  assert.equal(out.orphanedProcesses, true,
    "the close path discovers the reparented child through its inherited run marker");
  await new Promise((resolve) => setTimeout(resolve, 1_400));
  await assert.rejects(access(path.join(workspace, "fast-parent-descendant-survived.txt")), /ENOENT/u);
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

test("changedFiles losslessly represents non-UTF-8 Git path bytes", {
  // Linux filesystems expose arbitrary byte names. macOS normalizes/rejects
  // invalid UTF-8 (EILSEQ), and Windows filenames use Unicode APIs.
  skip: process.platform !== "linux",
}, async (context) => {
  const { workspace, client } = await makeHarness(context);
  const rawName = Buffer.from([0x62, 0x61, 0x64, 0x2d, 0x80, 0x2e, 0x74, 0x78, 0x74]);
  const rawPath = Buffer.concat([Buffer.from(workspace), Buffer.from(path.sep), rawName]);
  await writeFile(rawPath, "invalid UTF-8 filename\n");
  const status = await client.request("tools/call", {
    name: "workspace_status", arguments: { workspacePath: workspace },
  });
  assert.ok(status.result.structuredContent.git.changedFiles.includes(
    "\0git-path-bytes:" + rawName.toString("hex"),
  ), JSON.stringify(status.result.structuredContent.git.changedFiles));
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

test("a ref moved from a blob to a new commit uses a commit-safe diff base", async (context) => {
  const { tempRoot, workspace, client } = await makeHarness(context);
  const refName = "refs/tags/blob-to-commit";
  const oldBlobPath = path.join(tempRoot, "old-blob.txt");
  await writeFile(oldBlobPath, "old blob\n");
  const { stdout: blobOid } = await execFileAsync(
    "git", ["hash-object", "-w", oldBlobPath], { cwd: workspace },
  );
  await execFileAsync("git", ["update-ref", refName, blobOid.trim()], { cwd: workspace });
  const response = await client.request("tools/call", taskArguments(workspace, {
    name: "blob-to-commit", moveBlobRefToCommit: true, refName,
    writeFile: "ref-commit.txt", commitMessage: "commit behind moved ref",
  }));
  assert.equal(response.result.error, undefined, "post-run attribution must not become a JSON-RPC error");
  const out = response.result.structuredContent;
  assert.equal(out.ok, true, JSON.stringify(out.error));
  assert.match(out.commits.log, /commit behind moved ref/u);
  assert.match(out.commits.diffStat, /ref-commit\.txt/u);
  assert.doesNotMatch(out.commits.diffStat, new RegExp(blobOid.trim(), "u"));
});

test("a force-moved ref diffs from an ancestral pre-run baseline", async (context) => {
  const { workspace, client } = await makeHarness(context);
  await execFileAsync("git", ["branch", "force-target"], { cwd: workspace });
  await execFileAsync("git", ["checkout", "-b", "source-lineage"], { cwd: workspace });
  await writeFile(path.join(workspace, "source-only.txt"), "pre-existing source history\n");
  await execFileAsync("git", ["add", "source-only.txt"], { cwd: workspace });
  await execFileAsync("git", ["commit", "-m", "pre-existing source commit"], { cwd: workspace });
  await execFileAsync("git", ["checkout", "main"], { cwd: workspace });

  const response = await client.request("tools/call", taskArguments(workspace, {
    name: "force-ref", forceRefFromExisting: true, fromBranch: "source-lineage",
    refName: "refs/heads/force-target", writeFile: "forced-worker.txt",
    commitMessage: "worker commit after force move",
  }));
  const out = response.result.structuredContent;
  assert.equal(out.ok, true, JSON.stringify(out.error));
  assert.equal(out.commits.newCommitCount, 1, out.commits.log);
  assert.match(out.commits.log, /worker commit after force move/u);
  assert.doesNotMatch(out.commits.log, /pre-existing source commit/u);
  assert.match(out.commits.diffStat, /forced-worker\.txt/u);
  assert.doesNotMatch(out.commits.diffStat, /source-only\.txt/u,
    "the old non-ancestral ref tip must not be used as the diff base");
});

test("linked worktrees sharing Git refs serialize across server processes", async (context) => {
  const { tempRoot, workspace, configPath, client } = await makeHarness(context);
  const linkedWorkspace = path.join(tempRoot, "linked-worktree");
  await execFileAsync("git", ["worktree", "add", "-b", "comparison-worktree", linkedWorkspace], {
    cwd: workspace,
  });
  assert.equal(
    await canonicalGitCommonDirectory(workspace),
    await canonicalGitCommonDirectory(linkedWorkspace),
  );
  const secondClient = new McpClient(configPath);
  try {
    await secondClient.initialize();
    const eventFile = path.join(tempRoot, "linked-worktree-events.jsonl");
    const first = client.request("tools/call", taskArguments(workspace, {
      name: "main-worktree", eventFile, delayMs: 800, writeFile: "main-only.txt",
    }));
    await waitFor(async () => (await events(eventFile)).some(
      (item) => item.name === "main-worktree" && item.event === "start",
    ));
    const second = secondClient.request("tools/call", taskArguments(linkedWorkspace, {
      name: "linked-worktree", eventFile, delayMs: 10, writeFile: "linked-only.txt",
    }));

    const responses = await Promise.all([first, second]);
    assert.ok(responses.every((response) => response.result.structuredContent.ok));
    assert.deepEqual((await events(eventFile)).map((item) => item.event + ":" + item.name), [
      "start:main-worktree", "end:main-worktree",
      "start:linked-worktree", "end:linked-worktree",
    ]);
  } finally {
    await secondClient.close();
  }
});


test("a commit on the checked-out branch is reported exactly once", async (context) => {
  const { workspace, client } = await makeHarness(context);
  const response = await client.request("tools/call", taskArguments(workspace, {
    name: "current-commit", commitCurrent: true,
    writeFile: "current.txt", commitMessage: "single worker commit",
  }));
  const out = response.result.structuredContent;
  assert.equal(out.ok, true, JSON.stringify(out.error));
  assert.ok(out.commits, "HEAD and its branch both moved; a commits block must exist");
  assert.equal(out.commits.newCommitCount, 1,
    "HEAD and refs/heads/main move across the same pair; count must not double");
  assert.equal(out.commits.log.split("single worker commit").length - 1, 1,
    out.commits.log);
  assert.match(out.commits.log, /HEAD, refs\/heads\/main/u,
    "the deduplicated target carries both labels");
});

test("one commit reached through a branch and tag is counted and logged once", async (context) => {
  const { workspace, client } = await makeHarness(context);
  const response = await client.request("tools/call", taskArguments(workspace, {
    name: "current-commit-with-tag", commitCurrent: true,
    writeFile: "tagged-current.txt", commitMessage: "single tagged worker commit",
    refName: "refs/tags/worker-tag",
  }));
  const out = response.result.structuredContent;
  assert.equal(out.ok, true, JSON.stringify(out.error));
  assert.equal(out.commits.newCommitCount, 1);
  assert.equal(out.commits.log.split("single tagged worker commit").length - 1, 1,
    out.commits.log);
  assert.match(out.commits.log, /HEAD, refs\/heads\/main, refs\/tags\/worker-tag/u,
    "the unique commit retains every contributing ref label");
  assert.match(out.commits.diffStat, /HEAD, refs\/heads\/main, refs\/tags\/worker-tag/u,
    "the identical commit range is emitted once with every contributing ref label");
});

test("a new branch forked from a divergent branch diffs only its own commits", async (context) => {
  const { workspace, client } = await makeHarness(context);
  await execFileAsync("git", ["checkout", "-b", "divergent"], { cwd: workspace });
  await writeFile(path.join(workspace, "divergent.txt"), "pre-existing divergent file\n");
  await execFileAsync("git", ["add", "divergent.txt"], { cwd: workspace });
  await execFileAsync("git", ["commit", "-m", "divergent baseline commit"], { cwd: workspace });
  await execFileAsync("git", ["checkout", "main"], { cwd: workspace });

  const response = await client.request("tools/call", taskArguments(workspace, {
    name: "fork-worker", newBranchFromExisting: true,
    fromBranch: "divergent", branchName: "forked-work",
    writeFile: "fork.txt", commitMessage: "forked worker commit",
  }));
  const out = response.result.structuredContent;
  assert.equal(out.ok, true, JSON.stringify(out.error));
  assert.match(out.commits.log, /forked worker commit/u);
  assert.doesNotMatch(out.commits.log, /divergent baseline commit/u);
  assert.doesNotMatch(out.commits.diffStat, /divergent\.txt/u,
    "the diff base is the fork point, not the original HEAD");
  assert.match(out.commits.diffStat, /fork\.txt/u);
});

test("new-branch attribution considers baselines beyond the first 256 tips", {
  skip: process.platform === "win32",
}, async (context) => {
  const { workspace, client } = await makeHarness(context);
  const { stdout: mainTree } = await execFileAsync("git", ["rev-parse", "HEAD^{tree}"], { cwd: workspace });
  for (let index = 0; index < 256; index += 1) {
    const { stdout: oid } = await execFileAsync(
      "git",
      ["commit-tree", mainTree.trim(), "-p", "HEAD", "-m", "filler " + String(index)],
      { cwd: workspace },
    );
    await execFileAsync(
      "git", ["update-ref", `refs/heads/a-filler-${String(index).padStart(3, "0")}`, oid.trim()],
      { cwd: workspace },
    );
  }
  await execFileAsync("git", ["checkout", "-b", "zzz-source"], { cwd: workspace });
  await writeFile(path.join(workspace, "late-source.txt"), "pre-existing late baseline\n");
  await execFileAsync("git", ["add", "late-source.txt"], { cwd: workspace });
  await execFileAsync("git", ["commit", "-m", "late source baseline"], { cwd: workspace });
  await execFileAsync("git", ["checkout", "main"], { cwd: workspace });

  const response = await client.request("tools/call", taskArguments(workspace, {
    name: "late-baseline-worker", newBranchFromExisting: true,
    fromBranch: "zzz-source", branchName: "late-baseline-work",
    writeFile: "late-worker.txt", commitMessage: "late baseline worker commit",
  }, { timeoutMs: 120_000 }));
  const out = response.result.structuredContent;
  assert.equal(out.ok, true, JSON.stringify(out.error));
  assert.match(out.commits.log, /late baseline worker commit/u);
  assert.doesNotMatch(out.commits.diffStat, /late-source\.txt/u,
    "the source tip after 256 other baselines remains the selected diff base");
  assert.match(out.commits.diffStat, /late-worker\.txt/u);
});

test("fetched remote history is excluded from worker-created commits", async (context) => {
  const { workspace, client } = await makeHarness(context);
  const response = await client.request("tools/call", taskArguments(workspace, {
    name: "fetch-then-work", fetchAndCommit: true,
    branchName: "fetched-work", writeFile: "worker-after-fetch.txt",
    commitMessage: "worker commit after fetch",
  }));
  const out = response.result.structuredContent;
  assert.equal(out.ok, true, JSON.stringify(out.error));
  assert.equal(out.commits.newCommitCount, 1, out.commits.log);
  assert.match(out.commits.log, /worker commit after fetch/u);
  assert.doesNotMatch(out.commits.log, /fetched upstream commit/u);
  assert.match(out.commits.log, /refs\/remotes\/origin\/main moved to externally sourced history/u);
  assert.doesNotMatch(out.commits.diffStat, /upstream\.txt/u,
    "external fetched content is part of the attribution baseline");
  assert.match(out.commits.diffStat, /worker-after-fetch\.txt/u);
});

test("a fetched tag tip is an external baseline for later worker commits", async (context) => {
  const { workspace, client } = await makeHarness(context);
  const response = await client.request("tools/call", taskArguments(workspace, {
    name: "fetch-tag-then-work", fetchAndCommit: true, fetchTagOnly: true,
    branchName: "fetched-tag-work", writeFile: "worker-after-tag.txt",
    commitMessage: "worker commit after fetched tag",
  }));
  const out = response.result.structuredContent;
  assert.equal(out.ok, true, JSON.stringify(out.error));
  assert.equal(out.commits.newCommitCount, 1, out.commits.log);
  assert.match(out.commits.log, /worker commit after fetched tag/u);
  assert.doesNotMatch(out.commits.log, /fetched upstream commit/u);
  assert.match(out.commits.log, /refs\/tags\/fetched-tag moved to externally sourced history/u);
  assert.doesNotMatch(out.commits.diffStat, /upstream\.txt/u);
  assert.match(out.commits.diffStat, /worker-after-tag\.txt/u);
});

test("prefetch refs are external baselines for later worker commits", async (context) => {
  const { workspace, client } = await makeHarness(context);
  const response = await client.request("tools/call", taskArguments(workspace, {
    name: "prefetch-then-work", fetchAndCommit: true, fetchPrefetch: true,
    branchName: "prefetched-work", writeFile: "worker-after-prefetch.txt",
    commitMessage: "worker commit after prefetch",
  }));
  const out = response.result.structuredContent;
  assert.equal(out.ok, true, JSON.stringify(out.error));
  assert.equal(out.commits.newCommitCount, 1, out.commits.log);
  assert.match(out.commits.log, /worker commit after prefetch/u);
  assert.doesNotMatch(out.commits.log, /fetched upstream commit/u);
  assert.match(out.commits.log, /refs\/prefetch\/remotes\/origin\/main moved to externally sourced history/u);
  assert.doesNotMatch(out.commits.diffStat, /upstream\.txt/u);
  assert.match(out.commits.diffStat, /worker-after-prefetch\.txt/u);
});

test("workspace lock metadata is absent from mirrored repository refs", async (context) => {
  const { tempRoot, workspace, client } = await makeHarness(context);
  const mirror = path.join(tempRoot, "mirror.git");
  await execFileAsync("git", ["init", "--bare", mirror], { cwd: tempRoot });
  const response = await client.request("tools/call", taskArguments(workspace, {
    name: "mirror", mirrorPush: true, remotePath: mirror,
  }));
  assert.equal(response.result.structuredContent.ok, true, response.result.structuredContent.error);
  const { stdout: mirroredRefs } = await execFileAsync(
    "git", ["for-each-ref", "--format=%(refname)"], { cwd: mirror },
  );
  assert.match(mirroredRefs, /refs\/heads\/main/u);
  assert.doesNotMatch(mirroredRefs, /cli-agent-bridge|workspace-locks/iu,
    "coordination metadata must live outside the repository ref namespace");
  const { stdout: localInternalRefs } = await execFileAsync(
    "git", ["for-each-ref", "--format=%(refname)", "refs/cli-agent-bridge"], { cwd: workspace },
  );
  assert.equal(localInternalRefs, "");
});

test("list_backends can be cancelled while a version probe hangs", async (context) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "cli-agent-bridge-test-"));
  context.after(async () => { await rm(tempRoot, { recursive: true, force: true }); });
  const hangScript = path.join(tempRoot, "hang-version.mjs");
  await writeFile(hangScript, "setTimeout(() => {}, 60_000);\n");
  const configPath = path.join(tempRoot, "backends.json");
  await writeFile(configPath, JSON.stringify({
    backends: {
      hang: {
        label: "Hanging backend",
        command: process.execPath,
        buildArgs: [hangScript, "<task>"],
        resumeArgs: null,
        experimental: false,
      },
    },
  }));
  const client = new McpClient(configPath);
  await client.initialize();
  context.after(async () => { await client.close(); });
  const started = Date.now();
  const responsePromise = client.request("tools/call", { name: "list_backends", arguments: {} }, 4242);
  await new Promise((resolve) => setTimeout(resolve, 200));
  client.notify("notifications/cancelled", { requestId: 4242 });
  const response = await responsePromise;
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 12_000, "cancellation must terminate the probe well before the 15s timeout");
  assert.ok(Array.isArray(response.result.structuredContent.backends));
});

test("backend spawn failures report the launch error", {
  skip: process.platform === "win32",
}, async (context) => {
  const { workspace, configPath, client } = await makeHarness(context);
  await writeFile(configPath, JSON.stringify({
    backends: {
      missing: {
        label: "Missing backend",
        command: "cli-agent-bridge-command-that-does-not-exist",
        buildArgs: ["<task>"],
        resumeArgs: null,
        experimental: false,
      },
    },
  }));
  const response = await client.request("tools/call", {
    name: "delegate_task",
    arguments: { backend: "missing", task: "run", workspacePath: workspace },
  });
  const out = response.result.structuredContent;
  assert.equal(out.ok, false);
  assert.match(out.error, /failed to start.*ENOENT/iu);
  assert.doesNotMatch(out.error, /exited with code null/iu);
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

test("PowerShell shim runner preserves native backend exit codes", {
  skip: process.platform !== "win32",
}, async () => {
  const runner = path.join(pluginRoot, "ps1-runner.ps1");
  let failure = null;
  try {
    await execFileAsync("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", runner,
      "cmd.exe", "/d", "/c", "exit", "37",
    ]);
  } catch (error) {
    failure = error;
  }
  assert.ok(failure);
  assert.equal(failure.code, 37);
});

test("a worktree root ending in whitespace is canonicalized without trimming it", async (context) => {
  if (process.platform === "win32") return; // NTFS forbids trailing spaces in names
  const { tempRoot, client } = await makeHarness(context);
  const spaced = path.join(tempRoot, "workspace ");
  await mkdir(spaced);
  await execFileAsync("git", ["init", "-b", "main"], { cwd: spaced });
  await execFileAsync("git", ["config", "user.name", "Bridge Test"], { cwd: spaced });
  await execFileAsync("git", ["config", "user.email", "bridge-test@example.invalid"], { cwd: spaced });
  await writeFile(path.join(spaced, "baseline.txt"), "baseline\n");
  await execFileAsync("git", ["add", "baseline.txt"], { cwd: spaced });
  await execFileAsync("git", ["commit", "-m", "baseline"], { cwd: spaced });
  const response = await client.request("tools/call", {
    name: "workspace_status",
    arguments: { workspacePath: spaced },
  });
  const out = response.result.structuredContent;
  assert.equal(out.ok, true, JSON.stringify(out.error ?? out));
  assert.ok(out.worktreeRoot.endsWith(" "),
    "the trailing space is part of the canonical root: " + JSON.stringify(out.worktreeRoot));
});

test("a separate Git common directory ending in whitespace is preserved", async (context) => {
  if (process.platform === "win32") return; // NTFS forbids trailing spaces in names
  const { tempRoot, client } = await makeHarness(context);
  const commonDirectory = path.join(tempRoot, "separate-git ");
  const worktree = path.join(tempRoot, "separate-worktree");
  await execFileAsync("git", [
    "init", "-b", "main", "--separate-git-dir", commonDirectory, worktree,
  ], { cwd: tempRoot });
  await execFileAsync("git", ["config", "user.name", "Bridge Test"], { cwd: worktree });
  await execFileAsync("git", ["config", "user.email", "bridge-test@example.invalid"], { cwd: worktree });
  await writeFile(path.join(worktree, "baseline.txt"), "baseline\n");
  await execFileAsync("git", ["add", "baseline.txt"], { cwd: worktree });
  await execFileAsync("git", ["commit", "-m", "baseline"], { cwd: worktree });
  const response = await client.request("tools/call", {
    name: "workspace_status",
    arguments: { workspacePath: worktree },
  });
  const out = response.result.structuredContent;
  assert.equal(out.ok, true, JSON.stringify(out.error ?? out));
  assert.equal(await canonicalGitCommonDirectory(worktree), await realpath(commonDirectory));
});
