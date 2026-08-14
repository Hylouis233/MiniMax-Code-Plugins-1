import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

export const PLUGIN_SCHEMA = 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json';
export const MCP_SCHEMA = 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json';

const PLUGIN_NAME = /^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u;
const SKILL_NAME = /^(?!.*--)[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const SHA = /^[0-9a-f]{40}$/u;
const GITHUB_REPOSITORY = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const CATEGORIES = new Set([
  'coding',
  'data',
  'design',
  'developer-tools',
  'productivity',
  'research',
  'other',
]);
const PLATFORMS = new Set(['macos', 'windows', 'linux']);
const PLUGIN_FIELDS = new Set([
  '$schema',
  'name',
  'version',
  'description',
  'author',
  'homepage',
  'repository',
  'license',
  'keywords',
  'extensions',
]);

export function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function parseJson(text, label) {
  assert(!text.startsWith('\uFEFF'), `${label}: UTF-8 BOM is not allowed`);
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${label}: invalid JSON: ${error.message}`);
  }
}

export function validatePluginManifest(value, label = 'plugin.json') {
  assert(isRecord(value), `${label}: root must be an object`);
  assert(value.$schema === PLUGIN_SCHEMA, `${label}: unsupported $schema`);
  assert(typeof value.name === 'string' && value.name.length <= 64 && PLUGIN_NAME.test(value.name), `${label}: invalid name`);
  for (const key of Object.keys(value)) {
    assert(PLUGIN_FIELDS.has(key), `${label}: unknown field ${key}`);
  }
  for (const key of ['version', 'description', 'homepage', 'repository', 'license']) {
    assert(value[key] === undefined || typeof value[key] === 'string', `${label}: ${key} must be a string`);
  }
  if (value.author !== undefined) {
    assert(isRecord(value.author), `${label}: author must be an object`);
    for (const key of Object.keys(value.author)) {
      assert(['name', 'email', 'url'].includes(key), `${label}: unknown author field ${key}`);
      assert(typeof value.author[key] === 'string', `${label}: author.${key} must be a string`);
    }
  }
  if (value.keywords !== undefined) {
    assert(Array.isArray(value.keywords) && value.keywords.every((item) => typeof item === 'string'), `${label}: keywords must be strings`);
  }
  assert(value.extensions === undefined || isRecord(value.extensions), `${label}: extensions must be an object`);
  return value;
}

export function validateSkillText(text, expectedName, label = 'SKILL.md') {
  assert(text.startsWith('---\n'), `${label}: YAML frontmatter is required`);
  const end = text.indexOf('\n---\n', 4);
  assert(end > 4, `${label}: YAML frontmatter is not closed`);
  const frontmatter = text.slice(4, end);
  const name = frontmatter.match(/^name:\s*([^\n]+)$/mu)?.[1]?.trim();
  const description = frontmatter.match(/^description:\s*([^\n]+)$/mu)?.[1]?.trim();
  assert(name === expectedName, `${label}: frontmatter name must equal ${expectedName}`);
  assert(SKILL_NAME.test(name) && name.length <= 64, `${label}: invalid Skill name`);
  assert(Boolean(description) && description.length <= 1024, `${label}: description is required and must be at most 1024 characters`);
  assert(text.slice(end + 5).trim().length > 0, `${label}: instructions are required`);
  return { name, description };
}

export function validateMcp(value, label = 'mcp.json') {
  assert(isRecord(value), `${label}: root must be an object`);
  assert(value.$schema === MCP_SCHEMA, `${label}: unsupported $schema`);
  assert(Object.keys(value).every((key) => ['$schema', 'mcpServers'].includes(key)), `${label}: unknown root field`);
  assert(isRecord(value.mcpServers), `${label}: mcpServers must be an object`);
  const entries = Object.entries(value.mcpServers);
  assert(entries.length <= 8, `${label}: MiniMax Code supports at most 8 MCP servers per plugin`);
  for (const [name, server] of entries) {
    assert(PLUGIN_NAME.test(name), `${label}: invalid MCP server name ${name}`);
    assert(isRecord(server), `${label}: MCP server ${name} must be an object`);
    if (server.type === 'stdio') {
      assert(typeof server.command === 'string' && server.command.length > 0 && (isBareCommand(server.command) || isContainedRelativePath(server.command)), `${label}: ${name} needs a bare executable or contained ./ path`);
      assert(server.args === undefined || (Array.isArray(server.args) && server.args.every((item) => typeof item === 'string')), `${label}: ${name}.args must be strings`);
      assert(server.env === undefined || (isRecord(server.env) && Object.entries(server.env).every(([key, item]) => !['PLUGIN_ROOT', 'PLUGIN_DATA'].includes(key) && typeof item === 'string')), `${label}: ${name}.env is invalid`);
      assert(server.cwd === undefined || (typeof server.cwd === 'string' && /^(?:\.\/|\$\{PLUGIN_ROOT\}(?:\/|$)|\$\{PLUGIN_DATA\}(?:\/|$))/u.test(server.cwd)), `${label}: ${name}.cwd is invalid`);
      assert(Object.keys(server).every((key) => ['type', 'command', 'args', 'env', 'cwd'].includes(key)), `${label}: ${name} has unsupported fields`);
    } else if (server.type === 'streamable-http' || server.type === 'sse') {
      assert(typeof server.url === 'string' && isSafeRemoteUrl(server.url), `${label}: ${name}.url must be HTTPS or loopback HTTP without credentials or fragment`);
      assert(server.headers === undefined || (isRecord(server.headers) && Object.values(server.headers).every((item) => typeof item === 'string')), `${label}: ${name}.headers must contain strings`);
      assert(Object.keys(server).every((key) => ['type', 'url', 'headers'].includes(key)), `${label}: ${name} has unsupported fields`);
    } else {
      throw new Error(`${label}: ${name} uses unsupported transport ${String(server.type)}`);
    }
  }
  return entries.map(([name]) => name).sort();
}

function stringArray(value, label, { min = 0, allowed } = {}) {
  assert(Array.isArray(value) && value.length >= min, `${label}: must be an array with at least ${min} item(s)`);
  assert(value.every((item) => typeof item === 'string' && item.length > 0), `${label}: must contain non-empty strings`);
  assert(new Set(value).size === value.length, `${label}: duplicate values are not allowed`);
  if (allowed) assert(value.every((item) => allowed.has(item)), `${label}: contains an unsupported value`);
}

export function validateRegistryEntry(value, label = 'registry entry') {
  assert(isRecord(value), `${label}: root must be an object`);
  const fields = new Set(['schemaVersion', 'name', 'repository', 'commit', 'path', 'summary', 'license', 'maintainers', 'categories', 'capabilities', 'requirements', 'dataAndNetwork', 'lifecycle']);
  assert(Object.keys(value).every((key) => fields.has(key)), `${label}: unknown field`);
  assert(Object.keys(value).length === fields.size, `${label}: required fields are missing`);
  assert(value.schemaVersion === 1, `${label}: schemaVersion must be 1`);
  assert(typeof value.name === 'string' && PLUGIN_NAME.test(value.name) && value.name.length <= 64, `${label}: invalid name`);
  assert(typeof value.repository === 'string' && GITHUB_REPOSITORY.test(value.repository), `${label}: repository must be a canonical public GitHub URL`);
  assert(typeof value.commit === 'string' && SHA.test(value.commit), `${label}: commit must be a full lowercase SHA`);
  assert(typeof value.path === 'string' && (value.path === '.' || /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/-]+$/u.test(value.path)), `${label}: invalid plugin path`);
  assert(typeof value.summary === 'string' && value.summary.length >= 20 && value.summary.length <= 280, `${label}: summary must be 20-280 characters`);
  assert(typeof value.license === 'string' && value.license.length >= 1 && value.license.length <= 100, `${label}: license is required`);
  stringArray(value.maintainers, `${label}.maintainers`, { min: 1 });
  stringArray(value.categories, `${label}.categories`, { min: 1, allowed: CATEGORIES });
  assert(isRecord(value.capabilities), `${label}.capabilities: must be an object`);
  assert(Object.keys(value.capabilities).sort().join(',') === 'mcpServers,skills', `${label}.capabilities: requires only mcpServers and skills`);
  stringArray(value.capabilities.skills, `${label}.capabilities.skills`);
  stringArray(value.capabilities.mcpServers, `${label}.capabilities.mcpServers`);
  assert(value.capabilities.skills.length + value.capabilities.mcpServers.length > 0, `${label}: at least one MCode capability is required`);
  assert(isRecord(value.requirements), `${label}.requirements: must be an object`);
  assert(Object.keys(value.requirements).sort().join(',') === 'accounts,executables,platforms', `${label}.requirements: invalid fields`);
  stringArray(value.requirements.executables, `${label}.requirements.executables`);
  stringArray(value.requirements.accounts, `${label}.requirements.accounts`);
  stringArray(value.requirements.platforms, `${label}.requirements.platforms`, { min: 1, allowed: PLATFORMS });
  assert(isRecord(value.dataAndNetwork), `${label}.dataAndNetwork: must be an object`);
  assert(Object.keys(value.dataAndNetwork).sort().join(',') === 'dataHandled,destinations,networkAccess', `${label}.dataAndNetwork: invalid fields`);
  assert(typeof value.dataAndNetwork.networkAccess === 'boolean', `${label}.dataAndNetwork.networkAccess: must be boolean`);
  stringArray(value.dataAndNetwork.destinations, `${label}.dataAndNetwork.destinations`);
  stringArray(value.dataAndNetwork.dataHandled, `${label}.dataAndNetwork.dataHandled`);
  assert(value.dataAndNetwork.networkAccess || value.dataAndNetwork.destinations.length === 0, `${label}: destinations require networkAccess=true`);
  assert(isRecord(value.lifecycle), `${label}.lifecycle: must be an object`);
  assert(Object.keys(value.lifecycle).sort().join(',') === 'disableBehavior,uninstallBehavior', `${label}.lifecycle: invalid fields`);
  for (const key of ['disableBehavior', 'uninstallBehavior']) {
    assert(typeof value.lifecycle[key] === 'string' && value.lifecycle[key].length >= 20 && value.lifecycle[key].length <= 500, `${label}.lifecycle.${key}: must be 20-500 characters`);
  }
  return value;
}

function isBareCommand(value) {
  return !/[\\/]/u.test(value);
}

function isContainedRelativePath(value) {
  return value.startsWith('./') && !value.split('/').includes('..') && !value.includes('\\');
}

function isSafeRemoteUrl(value) {
  try {
    const url = new URL(value);
    if (url.username || url.password || url.hash) return false;
    if (url.protocol === 'https:') return true;
    if (url.protocol !== 'http:') return false;
    const host = url.hostname.replace(/^\[|\]$/gu, '').toLowerCase();
    return host === 'localhost' || host === '::1' || /^127(?:\.\d{1,3}){3}$/u.test(host);
  } catch {
    return false;
  }
}

export async function validatePluginDirectory(root) {
  const manifestPath = path.join(root, 'plugin.json');
  const manifest = validatePluginManifest(parseJson(await readFile(manifestPath, 'utf8'), manifestPath), manifestPath);
  const skills = [];
  const skillsRoot = path.join(root, 'skills');
  let children = [];
  try {
    children = await readdir(skillsRoot, { withFileTypes: true });
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  assert(children.filter((item) => item.isDirectory()).length <= 64, `${skillsRoot}: MiniMax Code supports at most 64 Skills per plugin`);
  for (const child of children.filter((item) => item.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const skillPath = path.join(skillsRoot, child.name, 'SKILL.md');
    validateSkillText(await readFile(skillPath, 'utf8'), child.name, skillPath);
    skills.push(child.name);
  }
  let mcpServers = [];
  const mcpPath = path.join(root, 'mcp.json');
  try {
    mcpServers = validateMcp(parseJson(await readFile(mcpPath, 'utf8'), mcpPath), mcpPath);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  assert(skills.length + mcpServers.length > 0, `${root}: plugin must expose at least one Skill or MCP server`);
  return { manifest, skills: skills.sort(), mcpServers };
}
