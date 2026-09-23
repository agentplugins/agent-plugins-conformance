import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { requestEvidence } from './http-request.mjs';

const connectionPath = '/conformance/sse';
const messagePath = '/conformance/sse/messages';
const sessions = new Map();
const origin = 'http://127.0.0.1:43187';

export async function handleSse(request, response, pathname) {
  if (pathname !== connectionPath && pathname !== messagePath) return false;
  const method = pathname === connectionPath ? 'GET' : 'POST';
  if (request.method !== method) {
    response.writeHead(405, { Allow: method }).end();
    return true;
  }
  if (pathname === messagePath) {
    const ids = new URL(request.url, 'http://127.0.0.1:43187').searchParams.getAll('sessionId');
    const session = ids.length === 1 ? sessions.get(ids[0]) : undefined;
    if (!session) {
      response.writeHead(404).end('Unknown SSE session');
      return true;
    }
    session.observation.evidence.messages.push({
      origin,
      headers: {
        'x-apc-fixture': request.headers['x-apc-fixture'] ?? null,
      },
    });
    try {
      await session.transport.handlePostMessage(request, response);
    } catch (error) {
      console.error(`SSE fixture message error: ${error.message}`);
      if (!response.headersSent) response.writeHead(500).end();
      else if (!response.writableEnded) response.destroy();
    }
    return true;
  }

  const transport = new SSEServerTransport(messagePath, response, {
    enableDnsRebindingProtection: true,
    allowedHosts: ['127.0.0.1:43187'],
    allowedOrigins: ['http://127.0.0.1:43187'],
  });
  const invalidHeaders = transport.validateRequestHeaders(request);
  if (invalidHeaders) {
    response.writeHead(403).end(invalidHeaders);
    return true;
  }
  const { pathname: initialPath, query, headers } = requestEvidence(request);
  const observation = {
    kind: 'mcp-sse', server: 'sse', evidence: {
      type: 'sse-session', version: 1,
      connection: {
        origin, pathname: initialPath, query,
        headers: { ...headers, accept: request.headers.accept ?? null },
      },
      redirectSource: null,
      messages: [],
    },
  };
  const server = new Server({ name: 'agent-plugins-conformance-sse', version: '0.1.0' },
    { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{
    name: 'observe',
    description: 'Agent Plugins Conformance — Core, server ID: sse. Return this legacy SSE session’s initial connection and message-request evidence, including public fixture and protocol headers. Record the observation object from structuredContent (or parsed JSON text) unchanged with the run-conformance reporter; exclude the MCP result wrapper.',
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
    const snapshot = structuredClone(observation);
    return { content: [{ type: 'text', text: JSON.stringify(snapshot) }], structuredContent: snapshot };
  });
  sessions.set(transport.sessionId, { server, transport, observation });
  response.once('close', () => {
    sessions.delete(transport.sessionId);
    void server.close();
  });
  try {
    await server.connect(transport);
  } catch (error) {
    console.error(`SSE fixture connection error: ${error.message}`);
    sessions.delete(transport.sessionId);
    if (!response.headersSent) response.writeHead(500).end();
    else response.destroy();
    await server.close();
  }
  return true;
}

export function closeSseSessions() {
  for (const { server } of sessions.values()) void server.close();
  sessions.clear();
}
