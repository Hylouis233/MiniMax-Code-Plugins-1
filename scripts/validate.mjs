import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateHostedPluginDirectory, validatePluginDirectory } from './lib/validation.mjs';

const rootOption = process.argv.indexOf('--root');
const root = rootOption === -1
  ? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  : path.resolve(process.argv[rootOption + 1] ?? '');
const failures = [];
let hostedPluginCount = 0;

for (const child of await readDirectory(path.join(root, 'examples'))) {
  if (!child.isDirectory()) continue;
  await check(`example ${child.name}`, () => validatePluginDirectory(path.join(root, 'examples', child.name)));
}

for (const owner of await readDirectory(path.join(root, 'plugins'))) {
  if (!owner.isDirectory()) continue;
  for (const plugin of await readDirectory(path.join(root, 'plugins', owner.name))) {
    if (!plugin.isDirectory()) continue;
    await check(`plugin ${owner.name}/${plugin.name}`, () => validateHostedPluginDirectory(
      path.join(root, 'plugins', owner.name, plugin.name),
      { owner: owner.name, pluginName: plugin.name },
    ));
    hostedPluginCount += 1;
  }
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`FAIL ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`Validated ${hostedPluginCount} hosted Plugin${hostedPluginCount === 1 ? '' : 's'} and all examples.`);
}

async function check(label, task) {
  try {
    await task();
    console.log(`OK   ${label}`);
  } catch (error) {
    failures.push(error.message);
  }
}

async function readDirectory(directory) {
  try {
    return await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}
