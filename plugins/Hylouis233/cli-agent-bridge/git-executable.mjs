import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, realpath, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

let executablePromise = null;
let hooksRootPromise = null;
const pathCommandPromises = new Map();

function userScope() {
  let identity;
  try {
    const user = os.userInfo();
    identity = Number.isInteger(user.uid) && user.uid >= 0
      ? process.platform + ":uid:" + String(user.uid)
      : process.platform + ":" + user.username + ":" + user.homedir;
  } catch {
    identity = process.platform + ":" + (process.env.USERNAME ?? process.env.USER ?? os.homedir());
  }
  return createHash("sha256").update(identity).digest("hex").slice(0, 20);
}

const DISABLED_HOOKS_ROOT = path.join(
  os.tmpdir(), "minimax-cli-agent-bridge-git-" + userScope(), "disabled-hooks",
);

async function resolveGitExecutable() {
  const names = process.platform === "win32" ? ["git.exe", "git.com"] : ["git"];
  for (const rawDirectory of (process.env.PATH ?? "").split(path.delimiter)) {
    const directory = rawDirectory.replace(/^"|"$/gu, "");
    // Never let a relative PATH component reinterpret an untrusted workspace
    // as an executable search root after a Git command changes cwd.
    if (!directory || !path.isAbsolute(directory)) continue;
    for (const name of names) {
      const candidate = path.join(directory, name);
      try {
        await access(candidate, process.platform === "win32" ? constants.F_OK : constants.X_OK);
        if (!(await stat(candidate)).isFile()) continue;
        return await realpath(candidate);
      } catch { /* try the next trusted PATH entry */ }
    }
  }
  throw new Error("cannot locate git in an absolute PATH directory");
}

async function resolvePathCommandUncached(command) {
  if (path.isAbsolute(command)) {
    try {
      await access(command, process.platform === "win32" ? constants.F_OK : constants.X_OK);
      return (await stat(command)).isFile() ? await realpath(command) : null;
    } catch { return null; }
  }
  if (/[\\/]/u.test(command)) return null;
  const extensions = process.platform === "win32"
    ? (path.extname(command)
        ? [""]
        : [...(process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean), ".ps1"])
    : [""];
  for (const rawDirectory of (process.env.PATH ?? "").split(path.delimiter)) {
    const directory = rawDirectory.replace(/^"|"$/gu, "");
    if (!directory || !path.isAbsolute(directory)) continue;
    for (const extension of extensions) {
      const candidate = path.join(directory, command + extension);
      try {
        await access(candidate, process.platform === "win32" ? constants.F_OK : constants.X_OK);
        if ((await stat(candidate)).isFile()) return await realpath(candidate);
      } catch { /* continue searching */ }
    }
  }
  return null;
}

export function resolvePathCommand(command) {
  if (typeof command !== "string" || !command) return Promise.resolve(null);
  if (!pathCommandPromises.has(command)) {
    pathCommandPromises.set(command, resolvePathCommandUncached(command));
  }
  return pathCommandPromises.get(command);
}

export function trustedGitExecutable() {
  executablePromise ??= resolveGitExecutable();
  return executablePromise;
}

async function disabledHooksRoot() {
  hooksRootPromise ??= mkdir(DISABLED_HOOKS_ROOT, { recursive: true, mode: 0o700 })
    .then(() => DISABLED_HOOKS_ROOT)
    .catch((error) => {
      hooksRootPromise = null;
      throw error;
    });
  return await hooksRootPromise;
}

export async function safeGitInvocation(args) {
  const safeArgs = [
    "-c", "core.hooksPath=" + await disabledHooksRoot(),
    "-c", "core.fsmonitor=false",
    "-c", "gc.autoDetach=false",
    "-c", "maintenance.auto=false",
    ...args,
  ];
  if (args[0] === "diff") safeArgs.splice(9, 0, "--no-ext-diff", "--no-textconv");
  const env = {
    ...process.env,
    GIT_OPTIONAL_LOCKS: "0",
    GIT_PAGER: "",
    PAGER: "",
  };
  for (const name of [
    "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_CONFIG_COUNT", "GIT_DIR", "GIT_DIFF_OPTS",
    "GIT_EXTERNAL_DIFF", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_WORK_TREE",
  ]) delete env[name];
  for (const name of Object.keys(env)) {
    if (/^GIT_CONFIG_(?:KEY|VALUE)_\d+$/u.test(name)) delete env[name];
  }
  return { command: await trustedGitExecutable(), args: safeArgs, env };
}
