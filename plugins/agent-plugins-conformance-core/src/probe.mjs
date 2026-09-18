import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isAbsolute } from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { observeDataWrite } from './data-write.mjs';

const serverName = process.argv[2];
if (!['default', 'relative', 'root', 'data'].includes(serverName)) {
  throw new Error('Expected probe mode: default, relative, root, or data');
}
// Both src/ and dist/ are immediate children of the installed plugin root.
// This value is independent of the client-provided PLUGIN_ROOT environment.
const root = realpathSync.native(fileURLToPath(new URL('..', import.meta.url)));
const environmentNames = ['PLUGIN_ROOT', 'PLUGIN_DATA', 'APC_VALUE', 'APC_EXPANSION', 'APC_LITERAL'];
let resolvedData = null;
if (process.env.PLUGIN_DATA && isAbsolute(process.env.PLUGIN_DATA)) {
  try { resolvedData = realpathSync.native(process.env.PLUGIN_DATA); } catch { /* Unobservable target remains null. */ }
}
const launch = {
  server: serverName,
  root,
  resolvedData,
  // Compare directory identity even when the OS retains a junction/alias spelling.
  cwd: realpathSync.native(process.cwd()),
  argv: process.argv.slice(2),
  env: Object.fromEntries(environmentNames.filter((name) => process.env[name] !== undefined)
    .map((name) => [name, process.env[name]])),
};
const server = new Server({ name: `agent-plugins-conformance-${serverName}`, version: '0.1.0' },
  { capabilities: { tools: {} } });
const observeTool = {
  name: 'observe',
  description: 'Return this process launch evidence, including only fixture environment variables.' +
    (serverName === 'default' ? ' Each call also creates, writes, closes, and removes a uniquely named temporary file directly in an absolute PLUGIN_DATA directory, recording any operation or cleanup error.' : '') +
    ' Record the observation object from structuredContent (or parsed JSON text) unchanged with the run-conformance reporter; exclude the MCP result wrapper.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  annotations: { readOnlyHint: serverName !== 'default', destructiveHint: false, idempotentHint: serverName !== 'default', openWorldHint: false },
};
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [observeTool] }));
server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
  try {
    const args = params.arguments;
    if (params.name === 'observe') {
      if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).length !== 0) {
        throw new Error('observe requires an empty object');
      }
      const observation = { kind: 'mcp-stdio', server: serverName, evidence: { version: 1, ...launch } };
      if (serverName === 'default') observation.evidence.dataWrite = observeDataWrite(process.env.PLUGIN_DATA);
      return { content: [{ type: 'text', text: JSON.stringify(observation) }], structuredContent: observation };
    }
    throw new Error(`Unknown tool: ${params.name}`);
  } catch (error) {
    return { isError: true, content: [{ type: 'text', text: error.message }] };
  }
});
await server.connect(new StdioServerTransport());
