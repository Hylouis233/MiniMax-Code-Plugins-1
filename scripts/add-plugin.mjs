import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { parseJson, validateMcp, validatePluginManifest, validateSkillText } from './lib/validation.mjs';

const [repositoryUrl, ...options] = process.argv.slice(2);
if (!repositoryUrl) {
  console.error('Usage: npm run add -- https://github.com/<owner>/<repo> [--ref <commit>] [--path <subdirectory>]');
  process.exit(2);
}

const repositoryMatch = repositoryUrl.replace(/\.git$/u, '').match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)$/u);
if (!repositoryMatch) throw new Error('Only canonical public GitHub repository URLs are supported.');
const owner = repositoryMatch[1];
const repository = repositoryMatch[2];
const pluginPath = readOption('--path') ?? '.';
let commit = readOption('--ref');
const headers = { accept: 'application/vnd.github+json', 'user-agent': 'mcode-plugins-registry' };
if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;

if (!commit) {
  const metadata = await githubJson(`/repos/${owner}/${repository}`);
  const branch = await githubJson(`/repos/${owner}/${repository}/branches/${encodeURIComponent(metadata.default_branch)}`);
  commit = branch.commit.sha;
}
if (!/^[0-9a-f]{40}$/u.test(commit)) throw new Error('--ref must resolve to a full lowercase commit SHA.');

const prefix = pluginPath === '.' ? '' : `${pluginPath.replace(/\/$/u, '')}/`;
const manifest = validatePluginManifest(await rawJson(`${prefix}plugin.json`));
if (!manifest.license) throw new Error('plugin.json must declare an open-source license before registry submission.');
const skills = [];
const skillsResponse = await github(`/repos/${owner}/${repository}/contents/${prefix}skills?ref=${commit}`);
if (skillsResponse.status !== 404) {
  if (!skillsResponse.ok) throw new Error(`Cannot list Skills: HTTP ${skillsResponse.status}`);
  const children = await skillsResponse.json();
  for (const child of children.filter((item) => item.type === 'dir').sort((a, b) => a.name.localeCompare(b.name))) {
    const skillResponse = await raw(`${prefix}skills/${child.name}/SKILL.md`);
    if (!skillResponse.ok) continue;
    validateSkillText(await skillResponse.text(), child.name, `skills/${child.name}/SKILL.md`);
    skills.push(child.name);
  }
}

let mcpServers = [];
let networkAccess = false;
const mcpResponse = await raw(`${prefix}mcp.json`);
if (mcpResponse.ok) {
  const mcp = parseJson(await mcpResponse.text(), 'mcp.json');
  mcpServers = validateMcp(mcp);
  networkAccess = Object.values(mcp.mcpServers).some((server) => server.type !== 'stdio');
}
else if (mcpResponse.status !== 404) throw new Error(`Cannot read mcp.json: HTTP ${mcpResponse.status}`);
if (skills.length + mcpServers.length === 0) throw new Error('Plugin exposes no MCode-compatible Skill or MCP server.');

const entry = {
  schemaVersion: 1,
  name: manifest.name,
  repository: `https://github.com/${owner}/${repository}`,
  commit,
  path: pluginPath,
  summary: normalizeSummary(manifest.description ?? `${manifest.name} adds reusable capabilities to MiniMax Code.`),
  license: manifest.license,
  maintainers: [owner],
  categories: ['other'],
  capabilities: { skills, mcpServers },
  requirements: { executables: [], accounts: [], platforms: ['macos', 'windows', 'linux'] },
  dataAndNetwork: { networkAccess, destinations: [], dataHandled: [] },
  lifecycle: {
    disableBehavior: 'Review the plugin implementation and describe what remains after disable.',
    uninstallBehavior: 'Review the plugin implementation and describe files or remote data left after uninstall.',
  },
};
const output = path.resolve('registry', `${manifest.name}.json`);
await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(entry, null, 2)}\n`, { flag: 'wx' });
console.log(`Created ${output}`);
console.log('Review categories, requirements, platforms, network destinations, and dataHandled before submitting.');

function readOption(name) {
  const index = options.indexOf(name);
  if (index === -1) return undefined;
  if (!options[index + 1]) throw new Error(`${name} requires a value`);
  return options[index + 1];
}

function normalizeSummary(value) {
  const compact = value.replace(/\s+/gu, ' ').trim();
  return compact.length >= 20 ? compact.slice(0, 280) : `${compact} for MiniMax Code users.`;
}

async function github(apiPath) {
  return fetch(`https://api.github.com${apiPath}`, { headers });
}

async function githubJson(apiPath) {
  const response = await github(apiPath);
  if (!response.ok) throw new Error(`GitHub API ${apiPath}: HTTP ${response.status}`);
  return response.json();
}

function raw(relativePath) {
  return fetch(`https://raw.githubusercontent.com/${owner}/${repository}/${commit}/${relativePath}`);
}

async function rawJson(relativePath) {
  const response = await raw(relativePath);
  if (!response.ok) throw new Error(`Cannot read ${relativePath}: HTTP ${response.status}`);
  return parseJson(await response.text(), relativePath);
}
