import { createServer } from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const host = '127.0.0.1';
const port = 43187;
const pathname = '/conformance/mcp';
const url = `http://${host}:${port}${pathname}?value=$APC_HTTP_VALUE`;

// No session or observation state is shared between requests or client runs.
const listener = createServer(async (request, response) => {
  // Keep the received pathname intact: URL parsing would normalize dot segments.
  const separator = request.url.indexOf('?');
  const requestPathname = separator === -1 ? request.url : request.url.slice(0, separator);
  if (requestPathname === '/conformance/health') {
    if (request.method !== 'GET') {
      response.writeHead(405, { Allow: 'GET' }).end();
      return;
    }
    response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      .end(JSON.stringify({ fixture: 'agent-plugins-conformance-http', version: 1 }));
    return;
  }
  if (requestPathname !== pathname) {
    response.writeHead(404).end();
    return;
  }
  if (request.method !== 'POST') {
    response.writeHead(405, { Allow: 'POST' }).end();
    return;
  }
  const observation = {
    kind: 'mcp-streamable-http',
    server: 'http',
    evidence: {
      version: 1,
      pathname: requestPathname,
      // URLSearchParams yields decoded pairs and preserves duplicates and order.
      query: [...new URLSearchParams(separator === -1 ? '' : request.url.slice(separator + 1))],
      headers: { 'x-apc-fixture': request.headers['x-apc-fixture'] ?? null },
    },
  };
  const server = new Server({ name: 'agent-plugins-conformance-http', version: '0.1.0' },
    { capabilities: { tools: {} } });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  response.on('close', () => { void server.close(); });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{
    name: 'observe',
    description: 'Return this tool request’s URL pathname, decoded query pairs, and public x-apc-fixture header. Record the observation object from structuredContent (or parsed JSON text) unchanged with the run-conformance reporter; exclude the MCP result wrapper.',
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

listener.on('error', (error) => {
  console.error(`HTTP fixture could not listen at ${url}: ${error.code ?? error.message}`);
  process.exitCode = 1;
});
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    listener.close();
    listener.closeAllConnections();
  });
}
listener.listen(port, host, () => {
  console.log(JSON.stringify({ ready: true, url }));
});
