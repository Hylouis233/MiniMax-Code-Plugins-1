#!/usr/bin/env node

import { appendFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
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

if (spec.mode === "descendant") {
  event("descendant-start");
  await delay(spec.delayMs ?? 1_000);
  if (spec.writeFile) writeFileSync(path.resolve(process.cwd(), spec.writeFile), spec.contents ?? "descendant survived\n");
  event("descendant-end");
} else if (spec.spawnDescendant) {
  event("parent-start");
  spawn(process.execPath, [ownPath, JSON.stringify({
    mode: "descendant",
    name: spec.name,
    eventFile: spec.eventFile,
    delayMs: spec.descendantDelayMs,
    writeFile: spec.descendantWriteFile,
    contents: spec.contents,
  })], {
    cwd: process.cwd(),
    windowsHide: true,
    stdio: "inherit",
  });
  await new Promise(() => {});
} else {
  event("start");
  await delay(spec.delayMs ?? 0);
  if (spec.writeFile) writeFileSync(path.resolve(process.cwd(), spec.writeFile), spec.contents ?? spec.name ?? "done");
  event("end");
}
