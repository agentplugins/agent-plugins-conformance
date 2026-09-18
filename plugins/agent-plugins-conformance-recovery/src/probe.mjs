import { realpathSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

let resolvedData = null;
if (process.env.PLUGIN_DATA && isAbsolute(process.env.PLUGIN_DATA)) {
  try { resolvedData = realpathSync.native(process.env.PLUGIN_DATA); } catch { /* Unobservable target remains null. */ }
}
const server = new Server({ name: 'agent-plugins-conformance-recovery-valid', version: '0.1.0' },
  { capabilities: { tools: {} } });
const observeTool = {
  name: 'observe',
  description: 'Return an observation from the valid recovery server. Record the observation object from structuredContent (or parsed JSON text) unchanged with the run-conformance reporter; exclude the MCP result wrapper.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [observeTool] }));
server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
  try {
    if (params.name !== 'observe') throw new Error(`Unknown tool: ${params.name}`);
    const args = params.arguments;
    if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).length !== 0) {
      throw new Error('observe requires an empty object');
    }
    const observation = {
      kind: 'mcp-stdio', server: 'recovery-valid', evidence: { version: 1, server: 'recovery-valid', resolvedData },
    };
    return { content: [{ type: 'text', text: JSON.stringify(observation) }], structuredContent: observation };
  } catch (error) {
    return { isError: true, content: [{ type: 'text', text: error.message }] };
  }
});
await server.connect(new StdioServerTransport());
