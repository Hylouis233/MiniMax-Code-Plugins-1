import assert from 'node:assert/strict';
import test from 'node:test';

import { validateMcp, validatePluginManifest, validateRegistryEntry, validateSkillText } from '../scripts/lib/validation.mjs';

test('accepts the portable Agent Plugins manifest', () => {
  const value = validatePluginManifest({
    $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
    name: 'example-plugin',
    version: '1.0.0',
  });
  assert.equal(value.name, 'example-plugin');
});

test('rejects unsupported plugin capabilities in the manifest', () => {
  assert.throws(
    () => validatePluginManifest({
      $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
      name: 'example-plugin',
      hooks: './hooks.json',
    }),
    /unknown field hooks/u,
  );
});

test('accepts a valid Skill and rejects a mismatched directory name', () => {
  const skill = '---\nname: example-skill\ndescription: Run the example when requested.\n---\n\n# Example\n';
  assert.equal(validateSkillText(skill, 'example-skill').name, 'example-skill');
  assert.throws(() => validateSkillText(skill, 'different-skill'), /must equal different-skill/u);
});

test('validates supported MCP transports and reserved environment variables', () => {
  const base = { $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json' };
  assert.deepEqual(validateMcp({ ...base, mcpServers: { docs: { type: 'streamable-http', url: 'https://example.com/mcp' } } }), ['docs']);
  assert.deepEqual(validateMcp({ ...base, mcpServers: { local: { type: 'stdio', command: './server.js' } } }), ['local']);
  assert.throws(
    () => validateMcp({ ...base, mcpServers: { unsafe: { type: 'streamable-http', url: 'http://example.com/mcp' } } }),
    /HTTPS or loopback HTTP/u,
  );
  assert.throws(
    () => validateMcp({ ...base, mcpServers: { local: { type: 'stdio', command: 'node', env: { PLUGIN_ROOT: 'bad' } } } }),
    /env is invalid/u,
  );
});

test('requires immutable source and at least one capability in registry entries', () => {
  const entry = {
    schemaVersion: 1,
    name: 'example-plugin',
    repository: 'https://github.com/example/example-plugin',
    commit: 'a'.repeat(40),
    path: '.',
    summary: 'A useful example plugin for registry tests.',
    license: 'Apache-2.0',
    maintainers: ['example'],
    categories: ['developer-tools'],
    capabilities: { skills: ['example-skill'], mcpServers: [] },
    requirements: { executables: [], accounts: [], platforms: ['macos', 'windows', 'linux'] },
    dataAndNetwork: { networkAccess: false, destinations: [], dataHandled: [] },
    lifecycle: {
      disableBehavior: 'Stops exposing the plugin capabilities to future turns.',
      uninstallBehavior: 'Removes the package while leaving author-owned remote data unchanged.',
    },
  };
  assert.equal(validateRegistryEntry(entry).name, 'example-plugin');
  assert.throws(
    () => validateRegistryEntry({ ...entry, commit: 'main' }),
    /full lowercase SHA/u,
  );
  assert.throws(
    () => validateRegistryEntry({ ...entry, capabilities: { skills: [], mcpServers: [] } }),
    /at least one MCode capability/u,
  );
});
