import { spawn } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";

const UTILITY_CAPTURE_CHARS = 1_000_000;

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

async function windowsProcessTreePids(rootPid, knownPids = new Set()) {
  const script = [
    "$ErrorActionPreference='Stop'",
    "$items=@(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId)",
    "$items | ConvertTo-Json -Compress",
  ].join("; ");
  const result = await runUtility("powershell.exe", [
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
  }));
  const livePids = new Set(processes.map((item) => item.pid));
  const descendants = new Set([...knownPids].filter((pid) => livePids.has(pid)));
  if (livePids.has(rootPid)) descendants.add(rootPid);
  const parents = new Set([rootPid, ...knownPids]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const item of processes) {
      if (parents.has(item.parentPid) && !descendants.has(item.pid)) {
        descendants.add(item.pid);
        parents.add(item.pid);
        changed = true;
      }
    }
  }
  for (const pid of descendants) knownPids.add(pid);
  return [...descendants];
}

async function linuxProcessGroupHasLiveMembers(processGroupId) {
  let entries;
  try {
    entries = await readdir("/proc", { withFileTypes: true });
  } catch {
    return null;
  }
  let incomplete = false;
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d+$/u.test(entry.name)) continue;
    let raw;
    try {
      raw = await readFile("/proc/" + entry.name + "/stat", "utf8");
    } catch (error) {
      if (error.code === "ENOENT") continue; // process exited during the scan
      incomplete = true;
      continue;
    }
    // /proc/PID/stat starts with `pid (comm) state ppid pgrp ...`; comm can
    // contain spaces and parentheses, so split only after its final `)`.
    const close = raw.lastIndexOf(")");
    if (close < 0) { incomplete = true; continue; }
    const fields = raw.slice(close + 1).trim().split(/\s+/u);
    const state = fields[0];
    const pgrp = Number(fields[2]);
    if (pgrp === processGroupId && state !== "Z" && state !== "X" && state !== "x") {
      return true;
    }
  }
  // When procfs is partially hidden, fall back to kill(0) and fail safe.
  return incomplete ? null : false;
}

export async function isProcessTreeAlive(child, treeState) {
  if (!Number.isInteger(child.pid)) return false;
  if (process.platform === "win32") {
    return (await windowsProcessTreePids(child.pid, treeState.knownPids)).length > 0;
  }
  if (process.platform === "linux") {
    const live = await linuxProcessGroupHasLiveMembers(child.pid);
    if (live !== null) return live;
  }
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

export async function signalProcessTree(child, signal, treeState) {
  if (!Number.isInteger(child.pid)) return;
  if (process.platform === "win32") {
    // Windows has no portable SIGTERM equivalent for arbitrary console CLIs;
    // /T /F is required to terminate the complete tree deterministically.
    await runUtility("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"]);
    // If the root exited first, taskkill cannot traverse it. Win32_Process
    // normally retains the old parent PID, while known PIDs survive re-parenting.
    const remaining = await windowsProcessTreePids(child.pid, treeState.knownPids);
    for (const pid of remaining.reverse()) {
      await runUtility("taskkill.exe", ["/PID", String(pid), "/T", "/F"]);
    }
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

export async function waitForProcessTreeExit(child, timeoutMs, treeState) {
  const deadline = Date.now() + timeoutMs;
  while (await isProcessTreeAlive(child, treeState)) {
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
