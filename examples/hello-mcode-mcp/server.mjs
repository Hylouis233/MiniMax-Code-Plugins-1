import { createInterface } from 'node:readline';

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });

input.on('line', (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.id === undefined) return;
  const response = handle(message);
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, ...response })}\n`);
});

function handle(message) {
  if (message.method === 'initialize') {
    return {
      result: {
        protocolVersion: message.params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'hello-mcode-mcp', version: '0.1.0' },
      },
    };
  }
  if (message.method === 'tools/list') {
    return {
      result: {
        tools: [
          {
            name: 'hello_mcode',
            description: 'Return a greeting from the example MCP server.',
            inputSchema: { type: 'object', properties: {}, additionalProperties: false },
          },
        ],
      },
    };
  }
  if (message.method === 'tools/call' && message.params?.name === 'hello_mcode') {
    return { result: { content: [{ type: 'text', text: 'Hello from MCode MCP!' }] } };
  }
  return { error: { code: -32601, message: `Method not found: ${String(message.method)}` } };
}
