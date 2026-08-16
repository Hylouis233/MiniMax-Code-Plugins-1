import { spawn } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";

const UTILITY_CAPTURE_CHARS = 1_000_000;
const MARKER_OBSERVATION_GRACE_MS = 500;

function appendBounded(current, chunk) {
  const combined = current + chunk;
  return combined.length > UTILITY_CAPTURE_CHARS ? combined.slice(-UTILITY_CAPTURE_CHARS) : combined;
}

function runUtility(command, args, timeoutMs = 5_000) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const done = (exitCode, error = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode, stdout, stderr, error });
    };
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
      done(null, new Error(command + " timed out"));
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout = appendBounded(stdout, chunk); });
    child.stderr.on("data", (chunk) => { stderr = appendBounded(stderr, chunk); });
    child.on("error", (error) => done(null, error));
    child.on("close", (code) => done(code));
  });
}

async function windowsProcessStartIdentity(pid, run = runUtility) {
  const script = "$p=Get-CimInstance Win32_Process -Filter 'ProcessId = " + String(pid) +
    "'; if ($null -ne $p) { $p.CreationDate.ToUniversalTime().Ticks.ToString() }";
  const result = await run("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-Command", script,
  ]);
  if (result.exitCode !== 0) {
    throw new Error("cannot inspect Windows process identity: " +
      (result.stderr.trim() || result.error?.message || "unknown error"));
  }
  return result.stdout.trim() || null;
}

export function trackedWindowsProcessTreePids(rootPid, treeState, processes) {
  treeState.knownStarts ??= new Map();
  const byPid = new Map(processes.map((item) => [item.pid, item]));
  const matchesIdentity = (item) => {
    if (!item.startIdentity) {
      throw new Error("cannot verify Windows process creation identity for PID " + String(item.pid));
    }
    const expected = treeState.knownStarts.get(item.pid);
    return !expected || expected === item.startIdentity;
  };
  for (const pid of [...treeState.knownPids]) {
    const item = byPid.get(pid);
    const expected = treeState.knownStarts.get(pid);
    if (item && expected && item.startIdentity && expected !== item.startIdentity) {
      treeState.knownPids.delete(pid);
    }
  }
  const descendants = new Set();
  const parents = new Set();
  const root = byPid.get(rootPid);
  if (root && matchesIdentity(root)) {
    const expectedRoot = treeState.knownStarts.get(rootPid);
    if (expectedRoot || treeState.windowsSnapshotInitialized !== true) {
      descendants.add(rootPid);
      parents.add(rootPid);
      treeState.knownStarts.set(rootPid, root.startIdentity);
    }
  }
  // During the first relevant snapshot the root may have just exited while
  // Win32_Process still records its children with the original parent PID.
  if (treeState.windowsSnapshotInitialized !== true) parents.add(rootPid);
  for (const pid of treeState.knownPids) {
    const item = byPid.get(pid);
    if (pid === rootPid && treeState.windowsSnapshotInitialized === true &&
        !treeState.knownStarts.has(pid)) continue;
    if (!item || !matchesIdentity(item)) continue;
    descendants.add(pid);
    parents.add(pid);
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const item of processes) {
      if (!parents.has(item.parentPid) || descendants.has(item.pid)) continue;
      if (!matchesIdentity(item)) continue;
      descendants.add(item.pid);
      parents.add(item.pid);
      treeState.knownStarts.set(item.pid, item.startIdentity);
      changed = true;
    }
  }
  treeState.windowsSnapshotInitialized = true;
  for (const pid of descendants) treeState.knownPids.add(pid);
  return [...descendants];
}

export async function windowsProcessTreePids(
  rootPid,
  treeState = { knownPids: new Set(), knownStarts: new Map() },
  { runUtility: run = runUtility } = {},
) {
  const seeds = [...new Set([rootPid, ...treeState.knownPids])]
    .filter((pid) => Number.isInteger(pid) && pid > 0)
    .join(",");
  const script = [
    "$ErrorActionPreference='Stop'",
    `$seed=@(${seeds})`,
    "$queue=New-Object 'System.Collections.Generic.Queue[uint32]'",
    "$seed | ForEach-Object { $queue.Enqueue([uint32]$_) }",
    "$expanded=@{}",
    "$itemSeen=@{}",
    "$items=@()",
    "while($queue.Count -gt 0){$parent=$queue.Dequeue();if($expanded.ContainsKey($parent)){continue};$expanded[$parent]=$true;$filter=\"ProcessId = $parent OR ParentProcessId = $parent\";foreach($p in @(Get-CimInstance Win32_Process -Filter $filter)){if(-not $itemSeen.ContainsKey($p.ProcessId)){$itemSeen[$p.ProcessId]=$true;$identity=$(if($null -eq $p.CreationDate){''}else{$p.CreationDate.ToUniversalTime().Ticks.ToString()});$items += [pscustomobject]@{ProcessId=[uint32]$p.ProcessId;ParentProcessId=[uint32]$p.ParentProcessId;CreationTicks=$identity}};if(-not $expanded.ContainsKey($p.ProcessId)){$queue.Enqueue([uint32]$p.ProcessId)}}}",
    "$items | ConvertTo-Json -Compress",
  ].join("; ");
  const result = await run("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-Command", script,
  ]);
  if (result.exitCode !== 0) {
    throw new Error("cannot inspect Windows process tree: " + (result.stderr.trim() || result.error?.message || "unknown error"));
  }
  const raw = result.stdout.trim();
  if (!raw) return [];
  const parsed = JSON.parse(raw);
  const processes = (Array.isArray(parsed) ? parsed : [parsed]).map((item) => ({
    pid: Number(item.ProcessId),
    parentPid: Number(item.ParentProcessId),
    startIdentity: String(item.CreationTicks ?? ""),
  }));
  return trackedWindowsProcessTreePids(rootPid, treeState, processes);
}

export async function initializeProcessTree(child, treeState) {
  if (!Number.isInteger(child.pid)) return;
  if (process.platform === "win32") {
    // taskkill /T starts from the live ChildProcess root. Defer CIM until
    // close/termination so short-lived workers do not launch an expensive WMI
    // query solely to prove that an already-closed root is gone.
    treeState.knownStarts ??= new Map();
    return;
  }
  await refreshProcessTree(child, treeState);
}

function parseLinuxStat(pid, statLine) {
  // comm is parenthesized and may itself contain ')' characters. Fields
  // after the final ')' begin with: state, ppid, pgrp, ...
  const close = statLine.lastIndexOf(")");
  if (close === -1) return null;
  const fields = statLine.slice(close + 1).trim().split(/\s+/u);
  const item = {
    pid,
    state: fields[0],
    parentPid: Number(fields[1]),
    processGroupId: Number(fields[2]),
    startIdentity: fields[19] ?? "", // field 22: start time since boot
  };
  return !item.state || !Number.isInteger(item.pid) ||
    !Number.isInteger(item.parentPid) || !Number.isInteger(item.processGroupId)
    ? null : item;
}

async function readLinuxStat(pid, procRoot, fsOps) {
  try {
    return parseLinuxStat(pid, await fsOps.readFile(`${procRoot}/${pid}/stat`, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
}

async function linuxProcessSnapshot(procRoot = "/proc", fsOps = { readdir, readFile }) {
  let entries;
  try {
    entries = await fsOps.readdir(procRoot, { withFileTypes: true });
  } catch {
    return null;
  }
  const processes = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d+$/u.test(entry.name)) continue;
    try {
      const item = await readLinuxStat(Number(entry.name), procRoot, fsOps);
      if (item === undefined) continue;
      if (item === null) return null;
      processes.push(item);
    } catch (error) {
      return null;
    }
  }
  processes.incomplete = false;
  return processes;
}

// Linux keeps zombie processes in /proc until their parent (sometimes a
// non-reaping container PID 1) collects them. This classifier is deliberately
// tri-state: true means a live member was found, false means every matching
// member is a zombie, and null means the result is uncertain. Callers may only
// use the false result after a group-wide SIGKILL; while a group is still
// running, enumerating /proc races with members that can fork.
export async function linuxProcessGroupHasLiveMembers(
  processGroupId,
  procRoot = "/proc",
  fsOps = { readdir, readFile },
) {
  const processes = await linuxProcessSnapshot(procRoot, fsOps);
  if (processes === null) return null;
  const members = processes.filter((item) => item.processGroupId === processGroupId);
  if (members.length === 0) return null;
  return members.some((item) => isLiveState(item.state));
}

async function linuxMarkedProcessPids(marker, procRoot, fsOps) {
  let entries;
  try {
    entries = await fsOps.readdir(procRoot, { withFileTypes: true });
  } catch {
    return null;
  }
  const expected = "CLI_AGENT_BRIDGE_RUN_ID=" + marker;
  const matches = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d+$/u.test(entry.name)) continue;
    try {
      const environment = await fsOps.readFile(`${procRoot}/${entry.name}/environ`);
      const values = Buffer.isBuffer(environment)
        ? environment.toString("utf8").split("\0")
        : String(environment).split("\0");
      if (values.includes(expected)) matches.push(Number(entry.name));
    } catch (error) {
      // Processes may exit or belong to another user while /proc is scanned.
      // Neither case invalidates positive matches from this bridge's marker.
      if (!["ENOENT", "EACCES", "EPERM"].includes(error.code)) return null;
    }
  }
  return matches;
}

// Follow only PIDs already owned by this worker and the kernel-maintained child
// lists for their tasks. This keeps the short escape-detection interval without
// rescanning every process on the host for the lifetime of a delegation.
async function linuxTrackedProcessSnapshot(rootPid, treeState, procRoot, fsOps) {
  treeState.knownStarts ??= new Map();
  const queue = [...new Set([rootPid, ...treeState.knownPids])];
  const queued = new Set(queue);
  const processes = [];
  for (let index = 0; index < queue.length; index += 1) {
    const pid = queue[index];
    let item;
    try {
      item = await readLinuxStat(pid, procRoot, fsOps);
    } catch {
      return null;
    }
    if (item === undefined) {
      if (pid === rootPid && treeState.runMarker) {
        const markedPids = await linuxMarkedProcessPids(treeState.runMarker, procRoot, fsOps);
        if (markedPids === null) return null;
        for (const markedPid of markedPids) {
          if (queued.has(markedPid)) continue;
          queued.add(markedPid);
          queue.push(markedPid);
        }
      }
      continue;
    }
    if (item === null) return null;
    const expected = treeState.knownStarts.get(pid);
    if (expected && item.startIdentity && expected !== item.startIdentity) continue;
    treeState.knownPids.add(pid);
    if (item.startIdentity) treeState.knownStarts.set(pid, item.startIdentity);
    processes.push(item);

    let taskEntries;
    try {
      taskEntries = await fsOps.readdir(`${procRoot}/${pid}/task`, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") continue;
      return null;
    }
    for (const taskEntry of taskEntries) {
      if (!taskEntry.isDirectory() || !/^\d+$/u.test(taskEntry.name)) continue;
      let children;
      try {
        children = await fsOps.readFile(
          `${procRoot}/${pid}/task/${taskEntry.name}/children`, "utf8",
        );
      } catch (error) {
        if (error.code === "ENOENT") continue;
        return null;
      }
      for (const value of children.trim().split(/\s+/u)) {
        if (!value) continue;
        const childPid = Number(value);
        if (!Number.isInteger(childPid) || childPid <= 0 || queued.has(childPid)) continue;
        queued.add(childPid);
        queue.push(childPid);
      }
    }
  }
  processes.incomplete = false;
  return processes;
}

async function posixProcessSnapshot({
  platform = process.platform,
  procRoot = "/proc",
  fsOps = { readdir, readFile },
} = {}) {
  if (platform === "linux") return await linuxProcessSnapshot(procRoot, fsOps);
  const result = await runUtility("ps", ["-axo", "pid=,ppid=,pgid=,stat=,lstart="]);
  if (result.exitCode !== 0) return null;
  const processes = result.stdout.split(/\r?\n/u)
    .map(parsePosixProcessLine)
    .filter(Boolean);
  processes.incomplete = false;
  return processes;
}

export function parsePosixProcessLine(line) {
  const fields = line.trim().split(/\s+/u);
  if (fields.length < 9) return null;
  const item = {
    pid: Number(fields[0]),
    parentPid: Number(fields[1]),
    processGroupId: Number(fields[2]),
    state: fields[3][0] ?? "",
    // BSD/macOS ps lstart: "Mon Aug 16 12:34:56 2026". Keeping the
    // complete timestamp lets later snapshots reject a reused PID.
    startIdentity: fields.slice(4).join(" "),
  };
  return Number.isInteger(item.pid) && Number.isInteger(item.parentPid) &&
    Number.isInteger(item.processGroupId) && item.state && item.startIdentity
    ? item : null;
}

function isLiveState(state) {
  return state !== "Z" && state !== "X" && state !== "x";
}

export async function refreshProcessTree(child, treeState, options = {}) {
  if (!Number.isInteger(child.pid)) return null;
  const platform = options.platform ?? process.platform;
  if (platform === "win32") {
    await windowsProcessTreePids(child.pid, treeState, options);
    return null;
  }
  const processes = options.posixProcessSnapshot
    ? await options.posixProcessSnapshot(options)
    : platform === "linux"
      ? await linuxTrackedProcessSnapshot(
          child.pid,
          treeState,
          options.procRoot ?? "/proc",
          options.fsOps ?? { readdir, readFile },
        )
      : await posixProcessSnapshot(options);
  if (processes === null) return null;
  treeState.knownStarts ??= new Map();
  const byPid = new Map(processes.map((item) => [item.pid, item]));
  // Remember the leader's own start identity so a later signal or liveness
  // check can detect that the PID exited and was reused by another process.
  const leader = byPid.get(child.pid);
  const expectedLeaderStart = treeState.knownStarts.get(child.pid);
  const leaderIsOriginal = Boolean(leader) &&
    (!expectedLeaderStart || !leader.startIdentity || leader.startIdentity === expectedLeaderStart);
  if (leaderIsOriginal && leader.startIdentity && !expectedLeaderStart) {
    treeState.knownStarts.set(child.pid, leader.startIdentity);
  }
  const matchesKnownIdentity = (item) => {
    const expected = treeState.knownStarts.get(item.pid);
    return !expected || !item.startIdentity || expected === item.startIdentity;
  };
  // A recycled leader PID must not seed ancestry or process-group discovery:
  // doing so would adopt and later signal the replacement process's children.
  const parents = new Set(leaderIsOriginal ? [child.pid] : []);
  for (const pid of treeState.knownPids) {
    const item = byPid.get(pid);
    if (item && matchesKnownIdentity(item)) parents.add(pid);
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const item of processes) {
      if (((leaderIsOriginal && item.processGroupId === child.pid) || parents.has(item.parentPid)) &&
          !parents.has(item.pid)) {
        parents.add(item.pid);
        treeState.knownPids.add(item.pid);
        if (item.startIdentity) treeState.knownStarts.set(item.pid, item.startIdentity);
        changed = true;
      }
    }
  }
  return processes;
}

export async function isProcessTreeAlive(child, treeState, {
  ignoreZombieOnly = false,
  platform = process.platform,
  procRoot = "/proc",
  fsOps = { readdir, readFile },
  probeProcessGroup = (processGroupId) => process.kill(-processGroupId, 0),
} = {}) {
  if (!Number.isInteger(child.pid)) return false;
  if (platform === "win32") {
    await treeState.initialRefresh;
    return (await windowsProcessTreePids(child.pid, treeState)).length > 0;
  }
  let processes = await refreshProcessTree(child, treeState, { platform, procRoot, fsOps });
  const snapshotHasTrackedLive = (snapshot) => {
    const knownStarts = treeState.knownStarts ?? new Map();
    const leaderStart = knownStarts.get(child.pid);
    return snapshot.some((item) => {
      if (!isLiveState(item.state)) return false;
      if (item.processGroupId === child.pid) {
        // A reused PID leading an unrelated group must not count as our tree.
        return !leaderStart || !item.startIdentity || item.startIdentity === leaderStart;
      }
      if (!treeState.knownPids.has(item.pid)) return false;
      const expected = knownStarts.get(item.pid);
      return !expected || !item.startIdentity || expected === item.startIdentity;
    });
  };
  if (processes !== null) {
    if (snapshotHasTrackedLive(processes)) return true;
    // A detached child can inherit the run marker slightly after its very
    // short-lived parent disappears from /proc. Observe for a bounded grace
    // instead of making one empty scan authoritative and releasing the lock.
    if (platform === "linux" && treeState.runMarker &&
        !processes.some((item) => item.pid === child.pid) &&
        treeState.markerObservationComplete !== true) {
      const observationDeadline = Date.now() + MARKER_OBSERVATION_GRACE_MS;
      while (Date.now() < observationDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        processes = await refreshProcessTree(child, treeState, { platform, procRoot, fsOps });
        if (processes === null) break;
        if (snapshotHasTrackedLive(processes)) return true;
      }
      treeState.markerObservationComplete = true;
    }
    if (processes !== null && ignoreZombieOnly && !processes.incomplete) return false;
  }
  try {
    probeProcessGroup(child.pid);
  } catch (error) {
    // Only ESRCH is a reliable negative result. Permission and unexpected
    // probe errors fail safe so callers quarantine rather than reuse a live
    // workspace.
    return error.code !== "ESRCH";
  }
  if (ignoreZombieOnly && platform === "linux") {
    const classification = await linuxProcessGroupHasLiveMembers(child.pid, procRoot, fsOps);
    return classification !== false;
  }
  return true;
}

export async function signalProcessTree(child, signal, treeState, {
  platform = process.platform,
  posixProcessSnapshot: snapshot = posixProcessSnapshot,
  runUtility: run = runUtility,
  killOne = (pid, sig) => process.kill(pid, sig),
  killGroup = (pgid, sig) => process.kill(-pgid, sig),
} = {}) {
  if (!Number.isInteger(child.pid)) return;
  if (platform === "win32") {
    // The ChildProcess handle identifies the current root, so terminate its tree
    // immediately. Retained PIDs are then checked by creation identity.
    if (child.exitCode === null && child.signalCode === null) {
      await run("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"]);
    }
    await treeState.initialRefresh;
    const remaining = await windowsProcessTreePids(child.pid, treeState, { runUtility: run });
    for (const pid of remaining.reverse()) {
      const expected = treeState.knownStarts.get(pid);
      const current = await windowsProcessStartIdentity(pid, run);
      if (!current || !expected || current !== expected) continue;
      await run("taskkill.exe", ["/PID", String(pid), "/T", "/F"]);
    }
    return;
  }
  await refreshProcessTree(child, treeState, { platform, posixProcessSnapshot: snapshot });
  const processes = await snapshot();
  const byPid = processes === null ? new Map() : new Map(processes.map((item) => [item.pid, item]));
  // Signal the process group only while it is still provably ours: the leader
  // must be alive, still lead the group, and match its recorded start identity.
  // Otherwise the PGID may have been recycled onto an unrelated group. When
  // enumeration itself is unavailable (restricted /proc, failing ps) identity
  // cannot be verified either way, so containment wins: signal the group rather
  // than leave a possibly-live worker running through both grace periods.
  const leader = byPid.get(child.pid);
  const leaderStart = treeState.knownStarts?.get(child.pid);
  const groupIsOriginal = Boolean(leader) &&
    leader.processGroupId === child.pid &&
    isLiveState(leader.state) &&
    (!leaderStart || !leader.startIdentity || leader.startIdentity === leaderStart);
  if (groupIsOriginal || processes === null) {
    try {
      killGroup(child.pid, signal);
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  }
  for (const pid of [...treeState.knownPids].reverse()) {
    if (pid === child.pid) continue;
    const item = byPid.get(pid);
    const expected = treeState.knownStarts?.get(pid);
    // A successful snapshot proves an absent PID has exited. Never signal its
    // numeric value after the enumeration, where it could already be reused.
    if (processes !== null && !item) continue;
    if (item && expected && item.startIdentity && expected !== item.startIdentity) continue;
    try { killOne(pid, signal); }
    catch (error) { if (error.code !== "ESRCH") throw error; }
  }
}

export async function waitForProcessTreeExit(child, timeoutMs, treeState, options = {}) {
  const deadline = Date.now() + timeoutMs;
  while (await isProcessTreeAlive(child, treeState, options)) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return true;
}

export async function waitForChildExit(child, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (child.exitCode === null && child.signalCode === null) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return true;
}
