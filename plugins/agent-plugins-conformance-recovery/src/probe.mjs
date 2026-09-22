import { lstatSync, readlinkSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

let resolvedData = null;
if (process.env.PLUGIN_DATA && isAbsolute(process.env.PLUGIN_DATA)) {
  try { resolvedData = realpathSync.native(process.env.PLUGIN_DATA); } catch { /* Unobservable target remains null. */ }
}
const identity = [
  'recovery-cwd-escape', 'recovery-cwd-data-escape', 'recovery-unknown-field',
  'recovery-env-plugin-root', 'recovery-env-plugin-data',
  'recovery-cwd-symlink-escape',
].includes(process.argv[2])
  ? process.argv[2] : 'recovery-valid';
const root = realpathSync.native(fileURLToPath(new URL('..', import.meta.url)));
// Prototype evidence: record the filesystem state without inferring who changed it.
function symlinkEvidence() {
  const path = join(root, 'escape-link');
  const evidence = { root, path, kind: null, linkText: null, resolvedPath: null, resolvedKind: null, error: null };
  try {
    const entry = lstatSync(path);
    evidence.kind = entry.isSymbolicLink() ? 'symlink' : entry.isFile() ? 'file' : entry.isDirectory() ? 'directory' : 'other';
    if (entry.isSymbolicLink()) evidence.linkText = readlinkSync(path);
    evidence.resolvedPath = realpathSync.native(path);
    const target = statSync(path);
    evidence.resolvedKind = target.isDirectory() ? 'directory' : target.isFile() ? 'file' : 'other';
  } catch (error) {
    if (evidence.kind === null && error.code === 'ENOENT') evidence.kind = 'missing';
    evidence.error = error.code ?? error.message;
  }
  return evidence;
}
const server = new Server({ name: `agent-plugins-conformance-${identity}`, version: '0.1.0' },
  { capabilities: { tools: {} } });
const observeTool = {
  name: 'observe',
  description: identity === 'recovery-valid'
    ? 'Return an observation from the valid recovery server. Record the observation object from structuredContent (or parsed JSON text) unchanged with the run-conformance reporter; exclude the MCP result wrapper.'
    : `Return an observation from the ${identity} fixture server, including its resolved plugin root and actual working directory. Record the complete observation object from structuredContent (or parsed JSON text) unchanged; exclude the MCP result wrapper.`,
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
    const observation = identity === 'recovery-valid'
      ? { kind: 'mcp-stdio', server: 'recovery-valid', evidence: { version: 1, server: 'recovery-valid', resolvedData, cwdSymlink: symlinkEvidence() } }
      : {
          kind: 'mcp-stdio',
          server: identity,
          evidence: {
            version: 1,
            server: identity,
            root,
            cwd: realpathSync.native(process.cwd()),
          },
        };
    return { content: [{ type: 'text', text: JSON.stringify(observation) }], structuredContent: observation };
  } catch (error) {
    return { isError: true, content: [{ type: 'text', text: error.message }] };
  }
});
await server.connect(new StdioServerTransport());
