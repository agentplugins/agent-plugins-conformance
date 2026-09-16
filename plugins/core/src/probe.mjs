import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isAbsolute } from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { buildReport, formatReport } from './report.mjs';

const serverName = process.argv[2];
if (!['default', 'relative', 'root', 'data'].includes(serverName)) {
  throw new Error('Expected probe mode: default, relative, root, or data');
}
// Both src/ and dist/ are immediate children of the installed plugin root.
// This value is independent of the client-provided PLUGIN_ROOT environment.
const root = realpathSync(fileURLToPath(new URL('..', import.meta.url)));
const environmentNames = ['PLUGIN_ROOT', 'PLUGIN_DATA', 'APC_VALUE', 'APC_EXPANSION', 'APC_LITERAL'];
let resolvedData = null;
if (process.env.PLUGIN_DATA && isAbsolute(process.env.PLUGIN_DATA)) {
  try { resolvedData = realpathSync(process.env.PLUGIN_DATA); } catch { /* Unobservable target remains null. */ }
}
const launch = {
  server: serverName,
  root,
  resolvedData,
  // Compare directory identity even when the OS retains a junction/alias spelling.
  cwd: realpathSync(process.cwd()),
  argv: process.argv.slice(2),
  env: Object.fromEntries(environmentNames.filter((name) => process.env[name] !== undefined)
    .map((name) => [name, process.env[name]])),
};
const server = new Server({ name: `agent-plugins-conformance-${serverName}`, version: '0.1.0' },
  { capabilities: { tools: {} } });
const observeTool = {
  name: 'observe',
  description: 'Return this process launch evidence. Carry the observation object from structuredContent (or parsed JSON text) unchanged to report; exclude the MCP result wrapper. Reads only fixture variables.',
  inputSchema: { type: 'object', properties: { runId: { type: 'string', minLength: 1, maxLength: 100 } }, required: ['runId'], additionalProperties: false },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};
const reportTool = {
  name: 'report',
  description: 'Evaluate collected observations and return one deterministic report in JSON and human-readable form. Missing observations become not_verified. Never execute probes to fill missing observations.',
  inputSchema: { type: 'object', properties: { input: { type: 'object', description: 'Report input: schemaVersion 1, runId, client {name,version}, observations array of unchanged observe results or client-discovered skill markers.' } }, required: ['input'], additionalProperties: false },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: serverName === 'default' ? [observeTool, reportTool] : [observeTool] }));
server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
  try {
    const args = params.arguments;
    if (params.name === 'observe') {
      if (!args || Object.keys(args).length !== 1 || typeof args.runId !== 'string' || !args.runId.trim() || args.runId.length > 100) {
        throw new Error('observe requires only a nonempty runId string of at most 100 characters');
      }
      const observation = { kind: 'runtime', server: serverName, evidence: { version: 1, runId: args.runId, ...launch } };
      return { content: [{ type: 'text', text: JSON.stringify(observation) }], structuredContent: observation };
    }
    if (params.name === 'report' && serverName === 'default') {
      if (!args || Object.keys(args).length !== 1 || !Object.hasOwn(args, 'input')) throw new Error('report requires only an input object');
      const report = buildReport(args.input);
      return { content: [{ type: 'text', text: formatReport(report) }, { type: 'text', text: JSON.stringify(report, null, 2) }], structuredContent: report };
    }
    throw new Error(`Unknown tool: ${params.name}`);
  } catch (error) {
    return { isError: true, content: [{ type: 'text', text: error.message }] };
  }
});
await server.connect(new StdioServerTransport());
