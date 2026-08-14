import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

test('example stdio MCP completes initialize, tools/list, and tools/call', async (context) => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: path.join(root, 'examples', 'hello-mcode-mcp'),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  context.after(() => child.kill());
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const responses = [];
  lines.on('line', (line) => responses.push(JSON.parse(line)));

  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1.0.0' } } })}\n`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })}\n`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'hello_mcode', arguments: {} } })}\n`);

  await waitFor(() => responses.length === 3);
  assert.equal(responses[0].result.serverInfo.name, 'hello-mcode-mcp');
  assert.equal(responses[1].result.tools[0].name, 'hello_mcode');
  assert.equal(responses[2].result.content[0].text, 'Hello from MCode MCP!');
});

async function waitFor(predicate) {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for MCP responses');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
