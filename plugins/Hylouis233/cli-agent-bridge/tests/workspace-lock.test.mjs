import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { access, chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  acquireGitWorkspaceLock,
  localHostIdentity,
  tryAcquireGitWorkspaceLock,
  workspaceLockRef,
  WorkspaceLockCancelledError,
  WorkspaceLockDeadlineError,
} from "../workspace-lock.mjs";

const execFileAsync = promisify(execFile);

async function git(cwd, args, input = undefined) {
  const result = await execFileAsync("git", args, {
    cwd,
    input,
    encoding: "utf8",
  });
  return result.stdout.trim();
}

async function makeRepo(context) {
  const root = await mkdtemp(path.join(os.tmpdir(), "cli-agent-lock-test-"));
  const repo = path.join(root, "repo");
  await mkdir(repo);
  await git(repo, ["init", "-b", "main"]);
  context.after(() => rm(root, { recursive: true, force: true }));
  return repo;
}

async function installOwner(repo, ref, owner) {
  const oid = execFileSync("git", ["hash-object", "-w", "--stdin"], {
    cwd: repo,
    input: JSON.stringify(owner) + "\n",
    encoding: "utf8",
  }).trim();
  await git(repo, ["update-ref", ref, oid]);
  return oid;
}

test("a stale same-host lock is replaced only when its owner is confirmed dead", async (context) => {
  const repo = await makeRepo(context);
  const key = "git-worktree:" + repo;
  const ref = workspaceLockRef(key);
  const now = Date.now();
  const oldOid = await installOwner(repo, ref, {
    version: 1,
    token: "dead-owner",
    hostIdentity: localHostIdentity(),
    ownerPid: 12345,
    workerState: "idle",
    workerPid: null,
    acquiredAt: now - 60_000,
    heartbeatAt: now - 60_000,
  });

  const result = await tryAcquireGitWorkspaceLock({
    cwd: repo,
    key,
    now,
    staleMs: 1_000,
    heartbeatMs: 60_000,
    processProbe: () => "dead",
  });
  assert.equal(result.acquired, true);
  const newOid = await git(repo, ["rev-parse", ref]);
  assert.notEqual(newOid, oldOid, "stale-owner takeover must CAS the ref to a new owner blob");
  await result.lease.release();
  await assert.rejects(execFileAsync("git", ["rev-parse", "--verify", ref], { cwd: repo }), /Command failed/u);
});

test("a stale lock with a live owner is never stolen", async (context) => {
  const repo = await makeRepo(context);
  const key = "git-worktree:" + repo;
  const ref = workspaceLockRef(key);
  const now = Date.now();
  const oldOid = await installOwner(repo, ref, {
    version: 1,
    token: "live-owner",
    hostIdentity: localHostIdentity(),
    ownerPid: 23456,
    workerState: "idle",
    workerPid: null,
    acquiredAt: now - 60_000,
    heartbeatAt: now - 60_000,
  });

  const result = await tryAcquireGitWorkspaceLock({
    cwd: repo,
    key,
    now,
    staleMs: 1_000,
    processProbe: () => "alive",
  });
  assert.deepEqual(result, { acquired: false, reason: "held" });
  assert.equal(await git(repo, ["rev-parse", ref]), oldOid);
});

test("a stale owner PID reused by another process does not pin an idle lease", async (context) => {
  const repo = await makeRepo(context);
  const key = "git-worktree:" + repo;
  const ref = workspaceLockRef(key);
  const now = Date.now();
  await installOwner(repo, ref, {
    version: 1,
    token: "reused-owner-pid",
    hostIdentity: localHostIdentity(),
    ownerPid: 12345,
    ownerIdentity: "original-start",
    workerState: "idle",
    workerPid: null,
    acquiredAt: now - 60_000,
    heartbeatAt: now - 60_000,
  });
  const result = await tryAcquireGitWorkspaceLock({
    cwd: repo,
    key,
    now,
    staleMs: 1_000,
    heartbeatMs: 60_000,
    processProbe: () => "alive",
    processIdentityProbe: () => "reused-start",
  });
  assert.equal(result.acquired, true,
    "a live but differently-started PID is not the original stale owner");
  await result.lease.release();
});

test("uncertain worker liveness fails closed during stale-owner recovery", async (context) => {
  const repo = await makeRepo(context);
  const key = "git-worktree:" + repo;
  const ref = workspaceLockRef(key);
  const now = Date.now();
  const oldOid = await installOwner(repo, ref, {
    version: 1,
    token: "uncertain-worker",
    hostIdentity: localHostIdentity(),
    ownerPid: 34567,
    workerState: "starting",
    workerPid: null,
    acquiredAt: now - 60_000,
    heartbeatAt: now - 60_000,
  });

  const result = await tryAcquireGitWorkspaceLock({
    cwd: repo,
    key,
    now,
    staleMs: 1_000,
    processProbe: () => "dead",
  });
  assert.deepEqual(result, { acquired: false, reason: "held" });
  assert.equal(await git(repo, ["rev-parse", ref]), oldOid);
});

test("a stale running lock fails closed even when its original process group is gone", async (context) => {
  const repo = await makeRepo(context);
  const key = "git-worktree:" + repo;
  const ref = workspaceLockRef(key);
  const now = Date.now();
  const oldOid = await installOwner(repo, ref, {
    version: 1,
    token: "escaped-descendant-uncertain",
    hostIdentity: localHostIdentity(),
    ownerPid: 45678,
    workerState: "running",
    workerPid: 56789,
    acquiredAt: now - 60_000,
    heartbeatAt: now - 60_000,
  });

  const result = await tryAcquireGitWorkspaceLock({
    cwd: repo,
    key,
    now,
    staleMs: 1_000,
    processProbe: () => "dead",
    processGroupProbe: async () => "dead",
  });
  assert.deepEqual(result, { acquired: false, reason: "held" });
  assert.equal(await git(repo, ["rev-parse", ref]), oldOid);
});

test("an update-ref infrastructure failure is not misclassified as contention", async (context) => {
  const repo = await makeRepo(context);
  const key = "git-worktree:" + repo;
  const ref = workspaceLockRef(key);
  const gitDirectory = path.resolve(repo, await git(repo, ["rev-parse", "--git-dir"]));
  const refPath = path.join(gitDirectory, ...ref.split("/"));
  await mkdir(path.dirname(refPath), { recursive: true });
  const blocker = refPath + ".lock";
  await writeFile(blocker, "intentional test lock\n");
  context.after(() => rm(blocker, { force: true }));

  await assert.rejects(
    tryAcquireGitWorkspaceLock({ cwd: repo, key }),
    /cannot update workspace lock ref/iu,
  );
});

test("a failed release can be recovered by the next local holder in every completed state", async (context) => {
  for (const state of ["idle", "starting", "running"]) {
    const repo = await makeRepo(context);
    const key = "git-worktree:" + repo;
    const first = await tryAcquireGitWorkspaceLock({ cwd: repo, key, heartbeatMs: 60_000 });
    assert.equal(first.acquired, true);
    if (state !== "idle") await first.lease.markWorkerStarting();
    if (state === "running") await first.lease.markWorkerRunning(process.pid);
    const gitDirectory = path.resolve(repo, await git(repo, ["rev-parse", "--git-dir"]));
    const refPath = path.join(gitDirectory, ...first.lease.ref.split("/"));
    await mkdir(path.dirname(refPath), { recursive: true });
    const blocker = refPath + ".lock";
    await writeFile(blocker, "intentional release failure\n");
    await assert.rejects(first.lease.release(), /cannot delete workspace lock ref/iu);
    first.lease.allowLocalRecovery();
    await rm(blocker, { force: true });

    const second = await tryAcquireGitWorkspaceLock({ cwd: repo, key, heartbeatMs: 60_000 });
    assert.equal(second.acquired, true, "the next local holder should replace the " + state + " ref");
    await second.lease.release();
  }
});

test("a failed release in one linked worktree is recoverable from another", async (context) => {
  const repo = await makeRepo(context);
  await git(repo, ["config", "user.email", "fixture@example.com"]);
  await git(repo, ["config", "user.name", "Fixture"]);
  await git(repo, ["commit", "--allow-empty", "-m", "baseline"]);
  const linked = path.join(path.dirname(repo), "linked");
  await git(repo, ["worktree", "add", "-b", "linked", linked]);
  const key = "git-common-dir:shared-fixture";
  const first = await tryAcquireGitWorkspaceLock({ cwd: repo, key, heartbeatMs: 60_000 });
  assert.equal(first.acquired, true);
  const commonDirectory = path.resolve(repo, await git(repo, ["rev-parse", "--git-common-dir"]));
  const refPath = path.join(commonDirectory, ...first.lease.ref.split("/"));
  await mkdir(path.dirname(refPath), { recursive: true });
  const blocker = refPath + ".lock";
  await writeFile(blocker, "intentional linked-worktree release failure\n");
  await assert.rejects(first.lease.release(), /cannot delete workspace lock ref/iu);
  first.lease.allowLocalRecovery();
  await rm(blocker, { force: true });

  const second = await tryAcquireGitWorkspaceLock({ cwd: linked, key, heartbeatMs: 60_000 });
  assert.equal(second.acquired, true,
    "the repository-scoped abandoned OID is visible from every linked worktree");
  await second.lease.release();
});

test("post-CAS cancellation remains recoverable when its compensating delete fails", async (context) => {
  const repo = await makeRepo(context);
  const key = "git-worktree:" + repo;
  const ref = workspaceLockRef(key);
  const gitDirectory = path.resolve(repo, await git(repo, ["rev-parse", "--git-dir"]));
  const refPath = path.join(gitDirectory, ...ref.split("/"));
  await mkdir(path.dirname(refPath), { recursive: true });
  const blocker = refPath + ".lock";
  let cancellationChecks = 0;
  const cancel = {
    get cancelled() {
      cancellationChecks += 1;
      if (cancellationChecks === 7) writeFileSync(blocker, "intentional compensating-delete failure\n");
      return cancellationChecks >= 7;
    },
  };

  await assert.rejects(
    tryAcquireGitWorkspaceLock({ cwd: repo, key, cancel, heartbeatMs: 60_000 }),
    /cancelled/iu,
  );
  assert.equal(cancellationChecks, 7, "cancellation must be observed only after the CAS commits");
  await rm(blocker, { force: true });
  const recovered = await tryAcquireGitWorkspaceLock({ cwd: repo, key, heartbeatMs: 60_000 });
  assert.equal(recovered.acquired, true);
  await recovered.lease.release();
});

test("long lock waits unsubscribe cancellation listeners after every retry", async (context) => {
  const repo = await makeRepo(context);
  const key = "git-worktree:" + repo;
  const holder = await tryAcquireGitWorkspaceLock({
    cwd: repo,
    key,
    ownerPid: 111_111,
    heartbeatMs: 60_000,
  });
  assert.equal(holder.acquired, true);
  const listeners = new Set();
  let resolveCancelled;
  let maximumListeners = 0;
  const cancel = {
    cancelled: false,
    promise: new Promise((resolve) => { resolveCancelled = resolve; }),
    subscribe(listener) {
      listeners.add(listener);
      maximumListeners = Math.max(maximumListeners, listeners.size);
      return () => { listeners.delete(listener); };
    },
    cancel() {
      this.cancelled = true;
      resolveCancelled();
      for (const listener of [...listeners]) listener();
    },
  };

  const waiting = acquireGitWorkspaceLock({
    cwd: repo,
    key,
    ownerPid: 222_222,
    cancel,
    pollMs: 5,
  });
  await new Promise((resolve) => setTimeout(resolve, 300));
  cancel.cancel();
  await assert.rejects(waiting, /cancelled/iu);
  assert.equal(listeners.size, 0);
  assert.ok(maximumListeners <= 1, "listeners accumulated across retries: " + String(maximumListeners));
  await holder.lease.release();
});

test("worker state updates honour the delegation cancellation and deadline", async (context) => {
  const repo = await makeRepo(context);
  const key = "git-worktree:" + repo;
  const acquire = () => tryAcquireGitWorkspaceLock({
    cwd: repo, key, processProbe: () => "alive", heartbeatMs: 60_000,
  });

  // One interruption ends a lease's update lifecycle, so each case uses its own.
  const cancelledLease = await acquire();
  assert.equal(cancelledLease.acquired, true);
  const cancelled = { cancelled: true, promise: Promise.resolve(), subscribe: () => () => {} };
  await assert.rejects(cancelledLease.lease.markWorkerStarting({ cancel: cancelled }), WorkspaceLockCancelledError);
  await cancelledLease.lease.release();
  await assert.rejects(execFileAsync("git", ["rev-parse", "--verify", workspaceLockRef(key)], { cwd: repo }), /Command failed/u);

  const expiredLease = await acquire();
  assert.equal(expiredLease.acquired, true);
  const expired = { cancelled: false, promise: new Promise(() => {}), subscribe: () => () => {} };
  await assert.rejects(
    expiredLease.lease.markWorkerStarting({ cancel: expired, deadline: Date.now() - 1 }),
    WorkspaceLockDeadlineError,
  );
  await expiredLease.lease.release();
  await assert.rejects(execFileAsync("git", ["rev-parse", "--verify", workspaceLockRef(key)], { cwd: repo }), /Command failed/u);
});

test("initial acquisition CAS obeys cancellation while a Git hook blocks", {
  // This fixture depends on Linux's executable-hook and process interruption
  // semantics. macOS Git installations may disable or sandbox this hook path.
  skip: process.platform !== "linux",
}, async (context) => {
  const repo = await makeRepo(context);
  const gitDirectory = path.resolve(repo, await git(repo, ["rev-parse", "--git-dir"]));
  const hook = path.join(gitDirectory, "hooks", "reference-transaction");
  const ready = path.join(path.dirname(repo), "hook-ready");
  const release = path.join(path.dirname(repo), "hook-release");
  await writeFile(hook, [
    "#!/usr/bin/env node",
    "const { existsSync, writeFileSync } = require('node:fs');",
    `writeFileSync(${JSON.stringify(ready)}, 'ready\\n');`,
    `while (!existsSync(${JSON.stringify(release)})) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);`,
    "",
  ].join("\n"));
  await chmod(hook, 0o755);
  context.after(() => writeFile(release, "release\n").catch(() => {}));

  const listeners = new Set();
  let resolveCancelled;
  const cancel = {
    cancelled: false,
    promise: new Promise((resolve) => { resolveCancelled = resolve; }),
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    cancel() {
      this.cancelled = true;
      resolveCancelled();
      for (const listener of [...listeners]) listener();
    },
  };
  const acquisition = tryAcquireGitWorkspaceLock({
    cwd: repo, key: "git-worktree:" + repo, cancel, heartbeatMs: 60_000,
  });
  const readyDeadline = Date.now() + 3_000;
  while (true) {
    try { await access(ready); break; }
    catch {
      if (Date.now() >= readyDeadline) throw new Error("reference-transaction hook did not start");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  const cancelledAt = Date.now();
  cancel.cancel();
  await assert.rejects(acquisition, WorkspaceLockCancelledError);
  assert.ok(Date.now() - cancelledAt < 1_500,
    "cancellation must interrupt the update-ref CAS instead of waiting for the hook timeout");
  await writeFile(release, "release\n");
});

test("quarantined leases are reclaimable after the operator clears the marker", async (context) => {
  const repo = await makeRepo(context);
  const key = "git-worktree:" + repo;
  const ref = workspaceLockRef(key);
  const now = Date.now();
  await installOwner(repo, ref, {
    version: 1,
    token: "quarantined-owner",
    hostIdentity: localHostIdentity(),
    ownerPid: process.pid,
    workerState: "quarantined",
    quarantineMarkerPersisted: true,
    workerPid: 4242,
    acquiredAt: now,
    heartbeatAt: now,
  });

  const stillHeld = await tryAcquireGitWorkspaceLock({
    cwd: repo, key, now, staleMs: 60_000, processProbe: () => "alive",
    operatorCleared: () => false,
  });
  assert.deepEqual(stillHeld, { acquired: false, reason: "held" });

  const reclaimed = await tryAcquireGitWorkspaceLock({
    cwd: repo, key, now, staleMs: 60_000, processProbe: () => "alive",
    operatorCleared: () => true,
  });
  assert.equal(reclaimed.acquired, true, "a removed quarantine marker authorizes takeover");
  await reclaimed.lease.release();
});

test("a quarantined lease without proof of a durable marker fails closed", async (context) => {
  const repo = await makeRepo(context);
  const key = "git-worktree:" + repo;
  const now = Date.now();
  await installOwner(repo, workspaceLockRef(key), {
    version: 1,
    token: "marker-never-persisted",
    hostIdentity: localHostIdentity(),
    ownerPid: 12345,
    workerState: "quarantined",
    workerPid: 5353,
    acquiredAt: now - 120_000,
    heartbeatAt: now - 120_000,
  });
  const result = await tryAcquireGitWorkspaceLock({
    cwd: repo, key, now, staleMs: 30_000, processProbe: () => "dead",
    operatorCleared: () => true,
  });
  assert.deepEqual(result, { acquired: false, reason: "held" },
    "an absent marker is not operator clearance unless persistence was recorded");
});

test("a different OS user cannot clear another user's quarantined lease", async (context) => {
  const repo = await makeRepo(context);
  const key = "git-worktree:" + repo;
  const now = Date.now();
  await installOwner(repo, workspaceLockRef(key), {
    version: 1,
    token: "other-user-quarantine",
    hostIdentity: localHostIdentity() + ":other-user",
    ownerPid: 12345,
    ownerIdentity: "other-user-process",
    workerState: "quarantined",
    quarantineMarkerPersisted: true,
    workerPid: 5353,
    acquiredAt: now - 120_000,
    heartbeatAt: now - 120_000,
  });
  const result = await tryAcquireGitWorkspaceLock({
    cwd: repo, key, now, staleMs: 30_000, processProbe: () => "dead",
    operatorCleared: () => true,
  });
  assert.deepEqual(result, { acquired: false, reason: "held" });
});

test("a quarantined lease left by a crashed owner is reclaimable after the stale window", async (context) => {
  const repo = await makeRepo(context);
  const key = "git-worktree:" + repo;
  const now = Date.now();
  await installOwner(repo, workspaceLockRef(key), {
    version: 1,
    token: "crashed-quarantine",
    hostIdentity: localHostIdentity(),
    ownerPid: 12345,
    workerState: "quarantined",
    quarantineMarkerPersisted: true,
    workerPid: 5353,
    acquiredAt: now - 120_000,
    heartbeatAt: now - 120_000,
  });
  const result = await tryAcquireGitWorkspaceLock({
    cwd: repo, key, now, staleMs: 30_000, processProbe: () => "dead",
    operatorCleared: () => false,
  });
  assert.equal(result.acquired, true, "crash fallback: stale heartbeat plus dead owner");
  await result.lease.release();
});
