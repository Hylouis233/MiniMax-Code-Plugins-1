import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { parseJson, validateMcp, validatePluginManifest, validateRegistryEntry, validateSkillText } from './lib/validation.mjs';

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error('Usage: npm run verify -- registry/<plugin-name>.json [...]');
  process.exit(2);
}

for (const file of files) {
  const entry = validateRegistryEntry(parseJson(await readFile(file, 'utf8'), file), file);
  const { owner, repository } = parseGitHub(entry.repository);
  const prefix = entry.path === '.' ? '' : `${entry.path.replace(/\/$/u, '')}/`;
  const rawBase = `https://raw.githubusercontent.com/${owner}/${repository}/${entry.commit}/${prefix}`;
  const manifest = validatePluginManifest(await fetchJson(`${rawBase}plugin.json`), `${entry.name}/plugin.json`);
  if (manifest.name !== entry.name) throw new Error(`${file}: registry name does not match plugin.json`);
  if (manifest.license !== entry.license) throw new Error(`${file}: registry license does not match plugin.json`);

  const discoveredSkills = await listSkillDirectories(owner, repository, entry.commit, prefix);
  if (discoveredSkills.join(',') !== [...entry.capabilities.skills].sort().join(',')) {
    throw new Error(`${file}: declared Skills do not match the pinned source`);
  }
  for (const skill of discoveredSkills) {
    const response = await fetch(`${rawBase}skills/${skill}/SKILL.md`);
    if (!response.ok) throw new Error(`${file}: cannot read Skill ${skill}: HTTP ${response.status}`);
    validateSkillText(await response.text(), skill, `${entry.name}/skills/${skill}/SKILL.md`);
  }

  let mcpServers = [];
  const mcpResponse = await fetch(`${rawBase}mcp.json`);
  if (mcpResponse.ok) mcpServers = validateMcp(parseJson(await mcpResponse.text(), `${entry.name}/mcp.json`), `${entry.name}/mcp.json`);
  else if (mcpResponse.status !== 404) throw new Error(`${file}: cannot read mcp.json: HTTP ${mcpResponse.status}`);
  if (mcpServers.join(',') !== [...entry.capabilities.mcpServers].sort().join(',')) {
    throw new Error(`${file}: declared MCP servers do not match mcp.json`);
  }
  console.log(`Verified ${entry.name} at ${entry.commit}.`);
}

function parseGitHub(url) {
  const match = url.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)$/u);
  if (!match) throw new Error(`Unsupported repository URL: ${url}`);
  return { owner: match[1], repository: match[2] };
}

async function fetchJson(url) {
  const response = await fetch(url, { headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(`Cannot read ${url}: HTTP ${response.status}`);
  return parseJson(await response.text(), url);
}

async function listSkillDirectories(owner, repository, commit, prefix) {
  const token = process.env.GITHUB_TOKEN;
  const headers = { accept: 'application/vnd.github+json', 'user-agent': 'mcode-plugins-registry' };
  if (token) headers.authorization = `Bearer ${token}`;
  const encodedPath = `${prefix}skills`.split('/').filter(Boolean).map(encodeURIComponent).join('/');
  const response = await fetch(`https://api.github.com/repos/${owner}/${repository}/contents/${encodedPath}?ref=${commit}`, { headers });
  if (response.status === 404) return [];
  if (!response.ok) throw new Error(`Cannot list Skills: HTTP ${response.status}`);
  const value = await response.json();
  if (!Array.isArray(value)) throw new Error('Skills path is not a directory');
  const directories = value.filter((item) => item.type === 'dir').map((item) => item.name).sort();
  const discovered = [];
  for (const directory of directories) {
    const skillUrl = `https://raw.githubusercontent.com/${owner}/${repository}/${commit}/${prefix}skills/${directory}/SKILL.md`;
    const skillResponse = await fetch(skillUrl);
    if (skillResponse.ok) discovered.push(directory);
    else if (skillResponse.status !== 404) throw new Error(`Cannot inspect Skill ${directory}: HTTP ${skillResponse.status}`);
  }
  return discovered;
}
