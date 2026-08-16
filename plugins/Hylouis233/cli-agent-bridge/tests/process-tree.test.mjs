import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  isProcessTreeAlive,
  linuxProcessGroupHasLiveMembers,
  waitForProcessTreeExit,
} from "../process-tree.mjs";

async function writeProcStat(root, pid, { state, group, command = "worker" }) {
  const directory = path.join(root, String(pid));
  await mkdir(directory);
  await writeFile(path.join(directory, "stat"), `${pid} (${command}) ${state} 1 ${group} ${group} 0 0 0 0\n`);
}

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
