#!/usr/bin/env node

import { appendFileSync, writeFileSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ownPath = fileURLToPath(import.meta.url);
const spec = JSON.parse(process.argv[2] ?? "{}");

function event(name) {
  if (!spec.eventFile) return;
  appendFileSync(spec.eventFile, JSON.stringify({ event: name, name: spec.name ?? "", pid: process.pid }) + "\n");
}

async function delay(milliseconds) {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

if (spec.branchRoundTrip) {
  event("start");
  const original = execFileSync("git", ["branch", "--show-current"], { encoding: "utf8" }).trim();
  execFileSync("git", ["checkout", "-b", spec.branchName ?? "worker-branch"]);
  writeFileSync(path.resolve(process.cwd(), spec.writeFile ?? "branch-work.txt"), spec.contents ?? "branch commit\n");
  execFileSync("git", ["add", spec.writeFile ?? "branch-work.txt"]);
  execFileSync("git", ["commit", "-m", spec.commitMessage ?? "worker branch commit"]);
  execFileSync("git", ["checkout", original]);
  event("end");
} else if (spec.checkoutExisting) {
  // Merely check out a pre-existing divergent branch; no commits are created.
  event("start");
  execFileSync("git", ["checkout", spec.branchName]);
  event("end");
} else if (spec.blobTag) {
  // Create a legal ref that points at a blob, not a commit.
  event("start");
  const oid = execFileSync(
    "git",
    ["hash-object", "-w", "--stdin"],
    { input: "blob payload\n", encoding: "utf8" },
  ).trim();
  execFileSync("git", ["update-ref", spec.refName ?? "refs/tags/blobtag", oid]);
  event("end");
} else if (spec.mode === "descendant") {
  event("descendant-start");
  await delay(spec.delayMs ?? 1_000);
  if (spec.writeFile) writeFileSync(path.resolve(process.cwd(), spec.writeFile), spec.contents ?? "descendant survived\n");
  event("descendant-end");
} else if (spec.spawnDescendant) {
  event("parent-start");
  const descendant = spawn(process.execPath, [ownPath, JSON.stringify({
    mode: "descendant",
    name: spec.name,
    eventFile: spec.eventFile,
    delayMs: spec.descendantDelayMs,
    writeFile: spec.descendantWriteFile,
    contents: spec.contents,
  })], {
    cwd: process.cwd(),
    detached: spec.detachedDescendant === true,
    windowsHide: true,
    stdio: spec.detachedDescendant === true ? "ignore" : "inherit",
  });
  if (spec.detachedDescendant === true) descendant.unref();
  await delay(spec.parentDelayMs ?? 120_000);
} else if (spec.stdoutChars) {
  process.stdout.write("x".repeat(spec.stdoutChars));
} else {
  event("start");
  await delay(spec.delayMs ?? 0);
  if (spec.writeFile) writeFileSync(path.resolve(process.cwd(), spec.writeFile), spec.contents ?? spec.name ?? "done");
  event("end");
}
