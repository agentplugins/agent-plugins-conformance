import { randomUUID } from 'node:crypto';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { AbsoluteSseServerTransport } from './absolute-sse-transport.mjs';
import { requestEvidence } from './http-request.mjs';

const sourceOrigin = 'http://127.0.0.1:43187';
const destinationOrigin = 'http://127.0.0.1:43189';
const redirectAttemptParameter = 'apcRedirectAttempt';
const redirectAttemptLifetime = 30_000;
const sessions = new Map();
const redirectAttempts = new Map();

const fixtures = new Map([
  [`${sourceOrigin}/conformance/sse`, {
    server: 'sse', expectedHeader: null,
    messageOrigin: sourceOrigin, messagePath: '/conformance/sse/messages',
  }],
  [`${sourceOrigin}/conformance/sse-header-precedence`, {
    server: 'sse-header-precedence', expectedHeader: null,
    messageOrigin: sourceOrigin, messagePath: '/conformance/sse/messages',
  }],
]);

function connectionEvidence(request, listenerOrigin) {
  const received = requestEvidence(request);
  return {
    origin: listenerOrigin,
    pathname: received.pathname,
    query: received.query,
    headers: {
      'x-apc-fixture': received.headers['x-apc-fixture'],
      accept: request.headers.accept ?? null,
    },
  };
}

function validateConnectionHeaders(request, listenerOrigin) {
  const expectedHost = new URL(listenerOrigin).host;
  if (request.headers.host !== expectedHost) return `Invalid Host header: ${request.headers.host}`;
  const origin = request.headers.origin;
  if (origin && origin !== sourceOrigin && origin !== destinationOrigin) return `Invalid Origin header: ${origin}`;
}

function messageEvidence(request, listenerOrigin) {
  return {
    origin: listenerOrigin,
    headers: { 'x-apc-fixture': request.headers['x-apc-fixture'] ?? null },
  };
}

function makeServer(serverId, evidence) {
  const server = new Server({ name: `agent-plugins-conformance-${serverId}`, version: '0.1.0' },
    { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{
    name: 'observe',
    description: `Agent Plugins Conformance — Core, server ID: ${serverId}. Return this legacy SSE session's public connection and message evidence. Record the observation object from structuredContent (or parsed JSON text) unchanged with the run-conformance reporter; exclude the MCP result wrapper.`,
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
    const observation = structuredClone({ kind: 'mcp-sse', server: serverId, evidence });
    return { content: [{ type: 'text', text: JSON.stringify(observation) }], structuredContent: observation };
  });
  return server;
}

async function openSession(request, response, fixture, connection, redirectSource = null) {
  const evidence = { type: 'sse-session', version: 1, connection, redirectSource, messages: [] };
  const endpoint = `${fixture.messageOrigin}${fixture.messagePath}`;
  const options = {
    enableDnsRebindingProtection: true,
    allowedHosts: [new URL(fixture.messageOrigin).host],
    allowedOrigins: [sourceOrigin, destinationOrigin],
  };
  const transport = fixture.messageOrigin === connection.origin
    ? new SSEServerTransport(fixture.messagePath, response, options)
    : new AbsoluteSseServerTransport(endpoint, response, options);
  const server = makeServer(fixture.server, evidence);
  const session = {
    server, transport, evidence,
    messageOrigin: fixture.messageOrigin, messagePath: fixture.messagePath,
  };
  sessions.set(transport.sessionId, session);
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
}

async function handleMessage(request, response, pathname, listenerOrigin) {
  const ids = new URL(request.url, listenerOrigin).searchParams.getAll('sessionId');
  const session = ids.length === 1 ? sessions.get(ids[0]) : undefined;
  if (!session || session.messageOrigin !== listenerOrigin || session.messagePath !== pathname) {
    response.writeHead(404).end('Unknown SSE session');
    return;
  }
  session.evidence.messages.push(messageEvidence(request, listenerOrigin));
  try {
    await session.transport.handlePostMessage(request, response);
  } catch (error) {
    console.error(`SSE fixture message error: ${error.message}`);
    if (!response.headersSent) response.writeHead(500).end();
    else if (!response.writableEnded) response.destroy();
  }
}

function redirectToDestination(request, response) {
  const source = connectionEvidence(request, sourceOrigin);
  if (source.headers['x-apc-fixture'] !== 'public SSE redirect fixture value') {
    response.writeHead(403).end('The source did not receive the expected public configured header.');
    return;
  }
  const attemptId = randomUUID();
  const timer = setTimeout(() => redirectAttempts.delete(attemptId), redirectAttemptLifetime);
  timer.unref();
  redirectAttempts.set(attemptId, { source, timer });
  const destination = new URL('/conformance/sse-redirect', destinationOrigin);
  destination.search = new URL(request.url, sourceOrigin).search;
  destination.searchParams.set(redirectAttemptParameter, attemptId);
  response.writeHead(307, { Location: destination.href, 'Cache-Control': 'no-store' }).end();
}

async function openRedirectDestination(request, response) {
  const url = new URL(request.url, destinationOrigin);
  const ids = url.searchParams.getAll(redirectAttemptParameter);
  const attempt = ids.length === 1 ? redirectAttempts.get(ids[0]) : undefined;
  if (!attempt) {
    response.writeHead(404).end('Unknown SSE redirect attempt');
    return;
  }
  clearTimeout(attempt.timer);
  redirectAttempts.delete(ids[0]);
  const fixture = {
    server: 'sse-redirect',
    messageOrigin: sourceOrigin,
    messagePath: '/conformance/sse-redirect/messages',
  };
  await openSession(
    request,
    response,
    fixture,
    connectionEvidence(request, destinationOrigin),
    attempt.source,
  );
}

export async function handleSse(request, response, pathname, listenerOrigin) {
  const isMessagePath = pathname === '/conformance/sse/messages' ||
    pathname === '/conformance/sse-redirect/messages';
  if (isMessagePath) {
    if (request.method !== 'POST') {
      response.writeHead(405, { Allow: 'POST' }).end();
      return true;
    }
    await handleMessage(request, response, pathname, listenerOrigin);
    return true;
  }

  const fixture = fixtures.get(`${listenerOrigin}${pathname}`);
  const isRedirectSource = listenerOrigin === sourceOrigin && pathname === '/conformance/sse-redirect';
  const isRedirectDestination = listenerOrigin === destinationOrigin && pathname === '/conformance/sse-redirect';
  if (!fixture && !isRedirectSource && !isRedirectDestination) return false;
  if (request.method !== 'GET') {
    response.writeHead(405, { Allow: 'GET' }).end();
    return true;
  }
  const invalidHeaders = validateConnectionHeaders(request, listenerOrigin);
  if (invalidHeaders) {
    response.writeHead(403).end(invalidHeaders);
    return true;
  }
  if (isRedirectSource) {
    redirectToDestination(request, response);
    return true;
  }
  if (isRedirectDestination) {
    await openRedirectDestination(request, response);
    return true;
  }
  const connection = connectionEvidence(request, listenerOrigin);
  if (fixture.expectedHeader && connection.headers['x-apc-fixture'] !== fixture.expectedHeader) {
    response.writeHead(403).end('The source did not receive the expected public configured header.');
    return true;
  }
  await openSession(request, response, fixture, connection);
  return true;
}

export function closeSseSessions() {
  for (const { server } of sessions.values()) void server.close();
  sessions.clear();
  for (const { timer } of redirectAttempts.values()) clearTimeout(timer);
  redirectAttempts.clear();
}
