import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const origins = Object.freeze({
  'posix-exact': { server: 'command-token-posix', marker: 'intact' },
  'posix-decoy': { server: 'command-token-posix', marker: 'split' },
  'windows-exact': { server: 'command-token-windows', marker: 'intact' },
  'windows-decoy': { server: 'command-token-windows', marker: 'split' },
});
const [wrapperOrigin, suppliedMarker, ...argv] = process.argv.slice(2);
const expected = origins[wrapperOrigin];
const marker = expected?.marker === suppliedMarker ? suppliedMarker : 'unknown';
const serverName = expected?.server ?? 'command-token-unknown';
const pathFlavor = process.platform === 'win32' ? 'windows' : 'posix';
const observation = {
  kind: 'mcp-command-token-prototype',
  server: serverName,
  evidence: {
    version: 1,
    platform: process.platform,
    pathFlavor,
    wrapperOrigin: typeof wrapperOrigin === 'string' ? wrapperOrigin : null,
    marker,
    argv,
  },
};

const server = new Server({ name: `agent-plugins-conformance-${serverName}`, version: '0.1.0' },
  { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{
    name: 'observe',
    description: 'Return prototype evidence showing which packaged command-token wrapper launched this MCP server.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }],
}));
server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
  if (params.name !== 'observe') {
    return { isError: true, content: [{ type: 'text', text: `Unknown tool: ${params.name}` }] };
  }
  const args = params.arguments;
  if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).length !== 0) {
    return { isError: true, content: [{ type: 'text', text: 'observe requires an empty object' }] };
  }
  return { content: [{ type: 'text', text: JSON.stringify(observation) }], structuredContent: observation };
});
await server.connect(new StdioServerTransport());
