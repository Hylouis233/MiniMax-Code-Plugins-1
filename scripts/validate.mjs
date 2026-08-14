import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseJson, validatePluginDirectory, validateRegistryEntry } from './lib/validation.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];
const identities = new Set();

for (const child of await readdir(path.join(root, 'examples'), { withFileTypes: true })) {
  if (!child.isDirectory()) continue;
  await check(`example ${child.name}`, () => validatePluginDirectory(path.join(root, 'examples', child.name)));
}

for (const child of await readdir(path.join(root, 'registry'), { withFileTypes: true })) {
  if (!child.isFile() || !child.name.endsWith('.json')) continue;
  await check(`registry/${child.name}`, async () => {
    const file = path.join(root, 'registry', child.name);
    const entry = validateRegistryEntry(parseJson(await readFile(file, 'utf8'), file), file);
    if (child.name !== `${entry.name}.json`) throw new Error(`${file}: filename must match plugin name`);
    const identity = `${entry.repository}#${entry.path}`.toLowerCase();
    if (identities.has(identity)) throw new Error(`${file}: duplicate repository and path`);
    identities.add(identity);
  });
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`FAIL ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`Validated examples and ${identities.size} registry entr${identities.size === 1 ? 'y' : 'ies'}.`);
}

async function check(label, task) {
  try {
    await task();
    console.log(`OK   ${label}`);
  } catch (error) {
    failures.push(error.message);
  }
}
