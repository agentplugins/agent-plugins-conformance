import { createServer } from 'node:http';
import { requestEvidence } from './http-request.mjs';
import { handleRedirect } from './redirect.mjs';
import { handleSse, closeSseSessions } from './sse.mjs';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const host = '127.0.0.1';
const port = 43187;
const pathname = '/conformance/mcp';
const url = `http://${host}:${port}${pathname}?value=$APC_HTTP_VALUE`;
const recoveryRoutes = new Map([
  ['/conformance/recovery-http-relative-url', 'recovery-http-relative-url'],
  ['/conformance/recovery-http-header-name', 'recovery-http-header-name'],
  ['/conformance/recovery-http-header-value', 'recovery-http-header-value'],
  ['/conformance/recovery-http-userinfo', 'recovery-http-userinfo'],
  ['/conformance/recovery-http-fragment', 'recovery-http-fragment'],
  ['/conformance/recovery-http-duplicate-headers', 'recovery-http-duplicate-headers'],
]);

const listener = createServer(async (request, response) => {
  const separator = request.url.indexOf('?');
  const requestPathname = separator === -1 ? request.url : request.url.slice(0, separator);
  if (await handleSse(request, response, requestPathname)) return;
  if (requestPathname === '/conformance/redirect') {
    await handleRedirect(request, response, 'source');
    return;
  }
  if (requestPathname === '/conformance/health') {
    if (request.method !== 'GET') {
      response.writeHead(405, { Allow: 'GET' }).end();
      return;
    }
    response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      .end(JSON.stringify({ fixture: 'agent-plugins-conformance-http', version: 1 }));
    return;
  }
  const fixtureId = recoveryRoutes.get(requestPathname) ?? (requestPathname === pathname ? 'http' : null);
  if (fixtureId === null) {
    response.writeHead(404).end();
    return;
  }
  if (request.method !== 'POST') {
    response.writeHead(405, { Allow: 'POST' }).end();
    return;
  }
  const observation = {
    kind: 'mcp-streamable-http',
    server: fixtureId,
    evidence: requestEvidence(request),
  };
  const server = new Server({ name: `agent-plugins-conformance-${fixtureId}`, version: '0.1.0' },
    { capabilities: { tools: {} } });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  response.on('close', () => { void server.close(); });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{
    name: 'observe',
    description: `Agent Plugins Conformance — ${fixtureId === 'http' ? 'Core' : 'Recovery'}, server ID: ${fixtureId}. Return this tool request’s URL pathname, decoded query pairs, and public x-apc-fixture header. Record the observation object from structuredContent (or parsed JSON text) unchanged with the run-conformance reporter; exclude the MCP result wrapper.`,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }] }));
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    if (params.name !== 'observe') {
      return { isError: true, content: [{ type: 'text', text: `Unknown tool: ${params.name}` }] };
    }
    if (!params.arguments || typeof params.arguments !== 'object' ||
        Array.isArray(params.arguments) || Object.keys(params.arguments).length !== 0) {
      return { isError: true, content: [{ type: 'text', text: 'observe requires an empty object' }] };
    }
    return { content: [{ type: 'text', text: JSON.stringify(observation) }], structuredContent: observation };
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(request, response);
  } catch (error) {
    console.error(`HTTP fixture request error: ${error.message}`);
    if (!response.headersSent) response.writeHead(500).end();
    else response.destroy();
    await server.close();
  }
});

const redirectDestination = createServer((request, response) => handleRedirect(request, response, 'destination'));
const listeners = [
  { server: listener, port, url },
  { server: redirectDestination, port: 43189, url: `http://${host}:43189/conformance/redirect` },
];
let readyCount = 0;
let startupFailed = false;
function closeListeners() {
  closeSseSessions();
  for (const { server } of listeners) {
    server.close();
    server.closeAllConnections();
  }
}
for (const { server, port: serverPort, url: serverUrl } of listeners) {
  server.on('error', (error) => {
    startupFailed = true;
    console.error(`HTTP fixture could not listen at ${serverUrl}: ${error.code ?? error.message}`);
    process.exitCode = 1;
    closeListeners();
  });
  server.listen(serverPort, host, () => {
    if (startupFailed) { closeListeners(); return; }
    readyCount += 1;
    if (readyCount === listeners.length) console.log(JSON.stringify({ ready: true, url }));
  });
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, closeListeners);
