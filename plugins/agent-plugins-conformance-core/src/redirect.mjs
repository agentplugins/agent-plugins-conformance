import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { requestEvidence } from './http-request.mjs';

const expectedHeader = 'public redirect fixture value';
const destination = 'http://127.0.0.1:43189/conformance/redirect';

export async function handleRedirect(request, response, role) {
  let server;
  try {
    if (new URL(request.url, 'http://localhost').pathname !== '/conformance/redirect') {
      response.writeHead(404).end();
      return;
    }
    if (request.method !== 'POST') {
      response.writeHead(405, { Allow: 'POST' }).end();
      return;
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const receivedHeader = request.headers['x-apc-fixture'] ?? null;
    if (role === 'source' && body.method === 'tools/call' && body.params?.name === 'observe' &&
        receivedHeader === expectedHeader) {
      const target = new URL(destination);
      target.searchParams.set('sourceHeader', receivedHeader);
      response.writeHead(307, { Location: target.href, 'Cache-Control': 'no-store' }).end();
      return;
    }
    server = new Server({ name: `agent-plugins-conformance-redirect-${role}`, version: '0.1.0' },
      { capabilities: { tools: {} } });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    response.on('close', () => { void server.close(); });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{
      name: 'observe',
      description: 'Agent Plugins Conformance — Core, server ID: http-redirect. Return the public request evidence received at the destination of a cross-origin redirect. Record the observation from structuredContent or parsed JSON text unchanged with run-conformance.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }] }));
    server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
      if (params.name !== 'observe' || !params.arguments || typeof params.arguments !== 'object' ||
          Array.isArray(params.arguments) || Object.keys(params.arguments).length !== 0) {
        return { isError: true, content: [{ type: 'text', text: 'Expected observe with empty arguments' }] };
      }
      if (role === 'source') {
        return { isError: true, content: [{ type: 'text', text: 'The source did not receive the expected public configured header.' }] };
      }
      const observation = {
        kind: 'mcp-streamable-http', server: 'http-redirect', evidence: requestEvidence(request),
      };
      return { content: [{ type: 'text', text: JSON.stringify(observation) }], structuredContent: observation };
    });
    await server.connect(transport);
    await transport.handleRequest(request, response, body);
  } catch (error) {
    console.error(`Redirect fixture request error: ${error.message}`);
    if (!response.headersSent) response.writeHead(500).end();
    else response.destroy();
    await server?.close();
  }
}
