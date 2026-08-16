import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  isProcessTreeAlive,
  linuxProcessGroupHasLiveMembers,
  parsePosixProcessLine,
  refreshProcessTree,
  signalProcessTree,
  waitForProcessTreeExit,
  windowsProcessTreePids,
} from "../process-tree.mjs";

test("BSD ps snapshots retain process start identity for PID-reuse checks", () => {
  assert.deepEqual(
    parsePosixProcessLine(" 432  1  432 S  Sun Aug 16 12:34:56 2026"),
    {
      pid: 432,
      parentPid: 1,
      processGroupId: 432,
      state: "S",
      startIdentity: "Sun Aug 16 12:34:56 2026",
    },
  );
});

async function writeProcStat(root, pid, {
  state, group, parent = 1, startIdentity = pid, command = "worker",
}) {
  const directory = path.join(root, String(pid));
  await mkdir(directory, { recursive: true });
  const fields = [state, String(parent), String(group), String(group)];
  while (fields.length < 20) fields.push("0");
  fields[19] = String(startIdentity);
  await writeFile(path.join(directory, "stat"), `${pid} (${command}) ${fields.join(" ")}\n`);
}

async function writeTaskChildren(root, pid, children) {
  const taskDirectory = path.join(root, String(pid), "task", String(pid));
  await mkdir(taskDirectory, { recursive: true });
  await writeFile(path.join(taskDirectory, "children"), children.join(" ") + "\n");
}

async function writeRunMarker(root, pid, marker) {
  await writeFile(
    path.join(root, String(pid), "environ"),
    `PATH=/fixture\0CLI_AGENT_BRIDGE_RUN_ID=${marker}\0`,
  );
}

test("Linux ancestry refresh follows task children without scanning all of procfs", async (context) => {
  const procRoot = await mkdtemp(path.join(os.tmpdir(), "cli-agent-bridge-proc-"));
  context.after(() => rm(procRoot, { recursive: true, force: true }));
  await writeProcStat(procRoot, 601, { state: "S", group: 601, startIdentity: 10 });
  await writeProcStat(procRoot, 602, {
    state: "S", group: 602, parent: 601, startIdentity: 11,
  });
  await writeTaskChildren(procRoot, 601, [602]);
  await writeTaskChildren(procRoot, 602, []);
  const fsOps = {
    readdir: async (target, options) => {
      assert.notEqual(target, procRoot, "targeted refresh must not enumerate the proc root");
      return await readdir(target, options);
    },
    readFile,
  };
  const treeState = { knownPids: new Set([601]), knownStarts: new Map() };
  const snapshot = await refreshProcessTree({ pid: 601 }, treeState, {
    platform: "linux", procRoot, fsOps,
  });
  assert.deepEqual(new Set(snapshot.map((item) => item.pid)), new Set([601, 602]));
  assert.equal(treeState.knownStarts.get(602), "11");
});

test("Linux refresh recovers a marked detached child after its parent exits", async (context) => {
  const procRoot = await mkdtemp(path.join(os.tmpdir(), "cli-agent-bridge-proc-"));
  context.after(() => rm(procRoot, { recursive: true, force: true }));
  await writeProcStat(procRoot, 702, {
    state: "S", group: 702, parent: 1, startIdentity: 22,
  });
  await writeTaskChildren(procRoot, 702, []);
  await writeRunMarker(procRoot, 702, "fixture-run");
  const treeState = {
    knownPids: new Set([701]),
    knownStarts: new Map(),
    runMarker: "fixture-run",
  };
  const snapshot = await refreshProcessTree({ pid: 701 }, treeState, {
    platform: "linux", procRoot, fsOps: { readdir, readFile },
  });
  assert.deepEqual(snapshot.map((item) => item.pid), [702]);
  assert.ok(treeState.knownPids.has(702),
    "the inherited run marker preserves containment after orphan reparenting");
});

test("Linux liveness observes briefly for a late-visible marked child", async (context) => {
  const procRoot = await mkdtemp(path.join(os.tmpdir(), "cli-agent-bridge-proc-"));
  context.after(() => rm(procRoot, { recursive: true, force: true }));
  await writeProcStat(procRoot, 802, {
    state: "S", group: 802, parent: 1, startIdentity: 33,
  });
  await writeTaskChildren(procRoot, 802, []);
  await writeRunMarker(procRoot, 802, "late-run");
  let markerScans = 0;
  const fsOps = {
    readdir: async (target, options) => {
      if (target === procRoot && ++markerScans < 3) return [];
      return await readdir(target, options);
    },
    readFile,
  };
  const treeState = {
    knownPids: new Set([801]), knownStarts: new Map(), runMarker: "late-run",
  };
  const alive = await isProcessTreeAlive({ pid: 801 }, treeState, {
    platform: "linux", procRoot, fsOps,
    probeProcessGroup: () => { const error = new Error("gone"); error.code = "ESRCH"; throw error; },
  });
  assert.equal(alive, true);
  assert.ok(markerScans >= 3, "the empty first scan must not release containment");
  assert.ok(treeState.knownPids.has(802));
});

test("Linux liveness ignores zombie-only process groups", async (context) => {
  const procRoot = await mkdtemp(path.join(os.tmpdir(), "cli-agent-bridge-proc-"));
  context.after(() => rm(procRoot, { recursive: true, force: true }));
  await writeProcStat(procRoot, 101, { state: "Z", group: 77, command: "leader) name" });
  await writeProcStat(procRoot, 102, { state: "X", group: 77 });
  await writeProcStat(procRoot, 103, { state: "S", group: 88 });

  assert.equal(await linuxProcessGroupHasLiveMembers(77, procRoot), false);
});

test("Linux liveness keeps a process group with any non-zombie member", async (context) => {
  const procRoot = await mkdtemp(path.join(os.tmpdir(), "cli-agent-bridge-proc-"));
  context.after(() => rm(procRoot, { recursive: true, force: true }));
  await writeProcStat(procRoot, 201, { state: "Z", group: 99 });
  await writeProcStat(procRoot, 202, { state: "D", group: 99 });

  assert.equal(await linuxProcessGroupHasLiveMembers(99, procRoot), true);
});

test("Linux liveness is unknown when no proc record matches the process group", async (context) => {
  const procRoot = await mkdtemp(path.join(os.tmpdir(), "cli-agent-bridge-proc-"));
  context.after(() => rm(procRoot, { recursive: true, force: true }));
  await writeProcStat(procRoot, 250, { state: "S", group: 200 });

  assert.equal(await linuxProcessGroupHasLiveMembers(201, procRoot), null);
});

test("Linux liveness is unknown when a proc stat record is ambiguous", async (context) => {
  const procRoot = await mkdtemp(path.join(os.tmpdir(), "cli-agent-bridge-proc-"));
  context.after(() => rm(procRoot, { recursive: true, force: true }));
  const directory = path.join(procRoot, "301");
  await mkdir(directory);
  await writeFile(path.join(directory, "stat"), "not a valid proc stat record\n");

  assert.equal(await linuxProcessGroupHasLiveMembers(101, procRoot), null);
});

test("Linux liveness is unknown when procfs is missing or restricted", async () => {
  const missingRoot = path.join(os.tmpdir(), `missing-proc-${process.pid}-${Date.now()}`);
  assert.equal(await linuxProcessGroupHasLiveMembers(401, missingRoot), null);

  const denied = Object.assign(new Error("access denied"), { code: "EACCES" });
  const fsOps = {
    readdir: async () => [{ name: "402", isDirectory: () => true }],
    readFile: async () => { throw denied; },
  };
  assert.equal(await linuxProcessGroupHasLiveMembers(401, "/fake-proc", fsOps), null);
});

test("zombie-only groups count as exited only for the final post-SIGKILL wait", async (context) => {
  const procRoot = await mkdtemp(path.join(os.tmpdir(), "cli-agent-bridge-proc-"));
  context.after(() => rm(procRoot, { recursive: true, force: true }));
  await writeProcStat(procRoot, 501, { state: "Z", group: 501 });
  const child = { pid: 501 };
  const treeState = { knownPids: new Set([501]) };
  const probeProcessGroup = () => {};
  const common = { platform: "linux", procRoot, probeProcessGroup };

  assert.equal(await isProcessTreeAlive(child, treeState, common), true);
  assert.equal(await isProcessTreeAlive(child, treeState, { ...common, ignoreZombieOnly: true }), false);
  assert.equal(await waitForProcessTreeExit(child, 0, treeState, common), false);
  assert.equal(await waitForProcessTreeExit(child, 0, treeState, { ...common, ignoreZombieOnly: true }), true);
});

function snapshotOf(processes) {
  const list = processes.map((item) => ({ startIdentity: "", ...item }));
  list.incomplete = false;
  return async () => list;
}

test("the process group is signaled only while its leader identity is original", async () => {
  const child = { pid: 9001 };
  const treeState = { knownPids: new Set([9001, 9002]), knownStarts: new Map() };
  const original = snapshotOf([
    { pid: 9001, parentPid: 1, processGroupId: 9001, state: "S", startIdentity: "start-a" },
    { pid: 9002, parentPid: 9001, processGroupId: 9001, state: "S", startIdentity: "start-b" },
  ]);
  await refreshProcessTree(child, treeState, { platform: "linux", posixProcessSnapshot: original });

  const groupSignals = [];
  const oneSignals = [];
  await signalProcessTree(child, "SIGTERM", treeState, {
    platform: "linux",
    posixProcessSnapshot: original,
    killGroup: (pgid) => { groupSignals.push(pgid); },
    killOne: (pid) => { oneSignals.push(pid); },
  });
  assert.deepEqual(groupSignals, [9001], "the original group is signaled");
  assert.ok(oneSignals.includes(9002), "tracked descendants are signaled individually");

  // The leader exits; during the kill grace its PID is reused by an unrelated
  // process that leads a new group. The saved PGID must never be signaled.
  const reused = snapshotOf([
    { pid: 9002, parentPid: 1, processGroupId: 9001, state: "S", startIdentity: "start-b" },
    { pid: 9001, parentPid: 404, processGroupId: 9001, state: "S", startIdentity: "start-reused" },
  ]);
  const groupSignalsAfterReuse = [];
  await signalProcessTree(child, "SIGKILL", treeState, {
    platform: "linux",
    posixProcessSnapshot: reused,
    killGroup: (pgid) => { groupSignalsAfterReuse.push(pgid); },
    killOne: () => {},
  });
  assert.deepEqual(groupSignalsAfterReuse, [], "a reused leader identity stops group signaling");
});

test("windows tree inspection drops known PIDs whose creation identity changed", async () => {
  const treeState = {
    knownPids: new Set([500, 501]),
    knownStarts: new Map([[500, "ticks-1"], [501, "ticks-2"]]),
  };
  const fakeUtility = async (command, args) => {
    assert.match(args.join(" "), /CreationTicks/u, "the CIM projection must request creation times");
    return {
      exitCode: 0,
      stdout: JSON.stringify([
        { ProcessId: 500, ParentProcessId: 1, CreationTicks: "ticks-REUSED" },
        { ProcessId: 501, ParentProcessId: 500, CreationTicks: "ticks-2" },
        { ProcessId: 502, ParentProcessId: 501, CreationTicks: "ticks-3" },
      ]),
      stderr: "",
    };
  };
  const pids = await windowsProcessTreePids(500, treeState, { runUtility: fakeUtility });
  assert.ok(pids.includes(501) && pids.includes(502), "genuine descendants are kept");
  assert.ok(!pids.includes(500), "the reused root PID is dropped from the tree");
  assert.ok(!treeState.knownPids.has(500), "the reused PID leaves the tracked set");
  assert.equal(treeState.knownStarts.get(500), "ticks-1", "the original identity is retained for comparison");
});

test("the group is still signaled when process enumeration is unavailable", async () => {
  const child = { pid: 9200 };
  const treeState = { knownPids: new Set([9200]), knownStarts: new Map() };
  await refreshProcessTree(child, treeState, {
    platform: "linux",
    posixProcessSnapshot: async () => [{ pid: 9200, parentPid: 1, processGroupId: 9200, state: "S", startIdentity: "start-z" }],
  });
  const groupSignals = [];
  await signalProcessTree(child, "SIGTERM", treeState, {
    platform: "linux",
    posixProcessSnapshot: async () => null,
    killGroup: (pgid) => { groupSignals.push(pgid); },
    killOne: () => {},
  });
  assert.deepEqual(groupSignals, [9200],
    "containment wins when identity cannot be verified: the group is signaled");
});
