import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const contribution = process.argv[2];
if (!contribution) {
  console.error('Usage: npm run create -- <github-owner>/<plugin-name>');
  process.exit(2);
}

const match = contribution.match(/^([A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38})\/([a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)$/u);
if (!match || match[2].length > 64 || match[2].includes('..') || match[2].includes('--')) {
  throw new Error('Plugin path must be <github-owner>/<lowercase-plugin-name>.');
}

const [, owner, pluginName] = match;
const title = pluginName.split(/[.-]/u).map((part) => `${part[0].toUpperCase()}${part.slice(1)}`).join(' ');
const destination = path.resolve('plugins', owner, pluginName);
const skillRoot = path.join(destination, 'skills', pluginName);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

await mkdir(path.dirname(destination), { recursive: true });
try {
  await mkdir(destination);
} catch (error) {
  if (error.code === 'EEXIST') throw new Error(`${path.relative(process.cwd(), destination)} already exists.`);
  throw error;
}
await mkdir(skillRoot, { recursive: true });
await Promise.all([
  write('plugin.json', `${JSON.stringify({
    $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
    name: pluginName,
    version: '0.1.0',
    description: `TODO: Describe what ${title} helps MiniMax Code users accomplish.`,
    author: { name: owner, url: `https://github.com/${owner}` },
    license: 'Apache-2.0',
    keywords: ['minimax-code', 'plugin'],
  }, null, 2)}\n`),
  write('README.md', `# ${title}\n\n> TODO: Explain the user problem this Plugin solves.\n\n## Try it\n\n\`\`\`text\nTODO: Add an example prompt.\n\`\`\`\n\n## Requirements\n\n- None.\n\n## Data and network\n\n- No network access.\n- No credentials required.\n`),
  write('LICENSE', await readFile(path.join(repositoryRoot, 'LICENSE'), 'utf8')),
  write(path.join('skills', pluginName, 'SKILL.md'), `---\nname: ${pluginName}\ndescription: TODO Describe what this Skill does and when MiniMax Code should use it.\n---\n\n# ${title}\n\nTODO: Add clear, executable instructions for the agent.\n`),
]);

console.log(`Created ${path.relative(process.cwd(), destination)}`);
console.log('Next: replace TODOs, run npm run check, then open a pull request.');

function write(relativePath, contents) {
  return writeFile(path.join(destination, relativePath), contents, { flag: 'wx' });
}
