import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import path from "node:path";

let executablePromise = null;
const pathCommandPromises = new Map();

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
    const resolution = resolvePathCommandUncached(command);
    pathCommandPromises.set(command, resolution);
    // Share an in-flight lookup and retain positive results, but do not make a
    // missing/not-yet-installed CLI permanent for the lifetime of the server.
    // The identity guard prevents an older completion from deleting a newer
    // retry that has already occupied the same cache slot.
    void resolution.then((resolved) => {
      if (resolved === null && pathCommandPromises.get(command) === resolution) {
        pathCommandPromises.delete(command);
      }
    }, () => {
      if (pathCommandPromises.get(command) === resolution) pathCommandPromises.delete(command);
    });
  }
  return pathCommandPromises.get(command);
}

export function trustedGitExecutable() {
  executablePromise ??= resolveGitExecutable();
  return executablePromise;
}

export async function safeGitInvocation(args, baseEnvironment = process.env) {
  const safeArgs = [
    // Git documents /dev/null as the way to disable hooks. Unlike a shared
    // empty directory, this sink cannot be pre-created or populated by another
    // local user before a coordination update-ref operation.
    "-c", "core.hooksPath=/dev/null",
    "-c", "core.fsmonitor=false",
    "-c", "gc.autoDetach=false",
    "-c", "maintenance.auto=false",
    ...args,
  ];
  if (args[0] === "diff") safeArgs.splice(9, 0, "--no-ext-diff", "--no-textconv");
  // Repository-routing variables must never leak from the process that
  // launched the bridge. Clear every case variant of GIT_* (Windows
  // environment names are case-insensitive), then restore only the settings
  // required by these local, non-interactive bridge operations.
  const env = Object.fromEntries(
    Object.entries(baseEnvironment).filter(([name]) => !/^GIT_/iu.test(name)),
  );
  Object.assign(env, {
    GIT_OPTIONAL_LOCKS: "0",
    GIT_PAGER: "",
    PAGER: "",
  });
  return { command: await trustedGitExecutable(), args: safeArgs, env };
}
