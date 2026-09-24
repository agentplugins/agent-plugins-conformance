import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { copyFile, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { createServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { buildReport } from '../plugins/agent-plugins-conformance/src/report.mjs';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const origin = 'http://127.0.0.1:43187';
const endpoint = `${origin}/conformance/mcp`;
const sseEndpoint = `${origin}/conformance/sse`;
const nonLoopbackOrigin = 'http://0.0.0.0:43187';
const sourceOrigin = origin;
const destinationOrigin = 'http://127.0.0.1:43189';
const redirectHeader = 'public SSE redirect fixture value';
const endpointHeader = 'public SSE endpoint fixture value';

async function within(promise, milliseconds, message) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

// Copy only the bundle: no source tree or node_modules can supply runtime imports.
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'apc-http-'));
  let stop;
  t.after(async () => {
    try { await stop?.(); } finally { await rm(directory, { recursive: true, force: true }); }
  });
  const entry = join(directory, 'serve-http.mjs');
  await copyFile(new URL('../plugins/agent-plugins-conformance-core/dist/serve-http.mjs', import.meta.url), entry);
  assert.deepEqual(await readdir(directory), ['serve-http.mjs']);
  const child = spawn(process.execPath, [entry], { cwd: directory, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = once(child, 'exit');
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (data) => { stdout += data; });
  child.stderr.on('data', (data) => { stderr += data; });
  stop = async (signal = 'SIGTERM') => {
    if (child.exitCode === null && child.signalCode === null) child.kill(signal);
    try { return await within(exited, 3_000, 'HTTP fixture did not stop'); }
    catch (error) {
      child.kill('SIGKILL');
      await exited;
      throw error;
    }
  };
  await within(Promise.race([
    (async () => {
      while (!stdout.includes('\n')) await once(child.stdout, 'data');
      assert.deepEqual(JSON.parse(stdout.trim()), {
        ready: true, url: `${endpoint}?value=$APC_HTTP_VALUE`,
      });
    })(),
    exited.then(([code, signal]) => { throw new Error(`HTTP fixture exited (${code ?? signal}): ${stderr}`); }),
  ]), 10_000, 'HTTP fixture did not become ready');
  return { stop, stderr: () => stderr };
}

function http(path, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const outgoing = request(`${origin}`, { path, method, headers, agent: false }, (incoming) => {
      let text = '';
      incoming.setEncoding('utf8');
      incoming.on('data', (chunk) => { text += chunk; });
      incoming.on('end', () => resolve({ status: incoming.statusCode, headers: incoming.headers, text }));
      incoming.on('error', reject);
    });
    outgoing.on('error', reject);
    outgoing.end(body);
  });
}

async function connect(t, query = '', headers = {}) {
  const client = new Client({ name: 'conformance-http-reference-test', version: '1' });
  t.after(() => client.close());
  await client.connect(new StreamableHTTPClientTransport(new URL(`${endpoint}${query}`), {
    requestInit: { headers },
  }));
  return client;
}

async function connectSseAt(t, endpointUrl, query = '', headers = {}, fetchImpl = fetch) {
  const requests = [];
  const client = new Client({ name: 'conformance-sse-reference-test', version: '1' });
  t.after(() => client.close());
  await client.connect(new SSEClientTransport(new URL(`${endpointUrl}${query}`), {
    requestInit: { headers },
    fetch: async (input, init) => {
      requests.push({ method: init?.method ?? 'GET', url: String(input) });
      return fetchImpl(input, init);
    },
  }));
  return { client, requests };
}

const connectSse = (t, query = '', headers = {}) => connectSseAt(t, sseEndpoint, query, headers);

function eventReader(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const queue = [];
  const waiters = [];
  let buffer = '';
  let failure;
  function deliver(event) {
    const waiter = waiters.shift();
    if (waiter) waiter.resolve(event);
    else queue.push(event);
  }
  void (async () => {
    try {
      while (true) {
        const { value, done } = await reader.read();
        buffer += decoder.decode(value, { stream: !done }).replaceAll('\r\n', '\n');
        let separator;
        while ((separator = buffer.indexOf('\n\n')) !== -1) {
          const block = buffer.slice(0, separator);
          buffer = buffer.slice(separator + 2);
          let type = 'message';
          const data = [];
          for (const line of block.split('\n')) {
            if (line.startsWith('event:')) type = line.slice(6).trimStart();
            if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
          }
          if (data.length) deliver({ type, data: data.join('\n') });
        }
        if (done) throw new Error('SSE stream ended');
      }
    } catch (error) {
      failure = error;
      for (const waiter of waiters.splice(0)) waiter.reject(error);
    }
  })();
  return {
    async next() {
      if (queue.length) return queue.shift();
      if (failure) throw failure;
      return new Promise((resolve, reject) => waiters.push({ resolve, reject }));
    },
    close: () => reader.cancel(),
  };
}

async function openStream(url, headers, redirect = 'follow') {
  const response = await fetch(url, {
    headers: { ...headers, accept: 'text/event-stream' },
    redirect,
  });
  assert.equal(response.status, 200);
  const events = eventReader(response);
  const endpointEvent = await within(events.next(), 3_000, 'missing endpoint event');
  assert.equal(endpointEvent.type, 'endpoint');
  return { events, endpoint: new URL(endpointEvent.data), response };
}

async function runProtocol(t, stream, messageHeaders) {
  let id = 0;
  let messageIndex = 0;
  async function post(message, expectResponse) {
    const marker = messageHeaders[Math.min(messageIndex, messageHeaders.length - 1)];
    messageIndex += 1;
    const response = await fetch(stream.endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(marker === null ? {} : { 'x-apc-fixture': marker }),
      },
      body: JSON.stringify(message),
    });
    assert.equal(response.status, 202);
    if (!expectResponse) return;
    const event = await within(stream.events.next(), 3_000, `missing response to ${message.method}`);
    assert.equal(event.type, 'message');
    const result = JSON.parse(event.data);
    assert.equal(result.id, message.id);
    return result;
  }
  await post({
    jsonrpc: '2.0', id: ++id, method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'reference', version: '1' } },
  }, true);
  await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, false);
  await post({ jsonrpc: '2.0', id: ++id, method: 'tools/list', params: {} }, true);
  const call = await post({
    jsonrpc: '2.0', id: ++id, method: 'tools/call',
    params: { name: 'observe', arguments: {} },
  }, true);
  t.after(() => stream.events.close());
  return call.result.structuredContent;
}

async function manualRedirectStream(destinationHeader) {
  const source = await fetch(`${sourceOrigin}/conformance/sse-redirect?value=%24APC_SSE_REDIRECT_VALUE`, {
    headers: { accept: 'text/event-stream', 'x-apc-fixture': redirectHeader },
    redirect: 'manual',
  });
  assert.equal(source.status, 307);
  const target = new URL(source.headers.get('location'));
  assert.equal(target.origin, destinationOrigin);
  return openStream(target, destinationHeader === null ? {} : { 'x-apc-fixture': destinationHeader });
}

test('standalone HTTP bundle serves independent MCP requests and stops cleanly', { timeout: 30_000 }, async (t) => {
  const server = await fixture(t);

  await t.test('health identifies the fixture and routes enforce exact paths and methods', async () => {
    const health = await http('/conformance/health');
    assert.equal(health.status, 200);
    assert.equal(health.headers['content-type'], 'application/json');
    assert.deepEqual(JSON.parse(health.text), { fixture: 'agent-plugins-conformance-http', version: 1 });
    for (const path of ['/', '/conformance/mcp/', '/conformance/./mcp', '/conformance/%6dcp']) {
      assert.equal((await http(path)).status, 404, path);
    }
    for (const method of ['GET', 'DELETE', 'PUT', 'OPTIONS']) {
      const response = await http('/conformance/mcp', { method });
      assert.equal(response.status, 405, method);
      assert.equal(response.headers.allow, 'POST');
    }
    const wrongHealthMethod = await http('/conformance/health', { method: 'POST' });
    assert.equal(wrongHealthMethod.status, 405);
    assert.equal(wrongHealthMethod.headers.allow, 'GET');
  });

  await t.test('initialization, tool discovery, and calls return exact public request evidence', async (t) => {
    const client = await connect(t, '?value=first+value&value=%24APC_HTTP_VALUE&empty=&encoded=%26%3D%2B', {
      'x-apc-fixture': 'public marker', authorization: 'Bearer private sentinel', 'x-unrelated': 'private header',
    });
    assert.equal(client.getServerVersion().name, 'agent-plugins-conformance-http');
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map(({ name }) => name), ['observe']);
    assert.deepEqual(tools[0].inputSchema, { type: 'object', properties: {}, additionalProperties: false });
    assert.equal(tools[0].annotations.readOnlyHint, true);
    const result = await client.callTool({ name: 'observe', arguments: {} });
    assert.equal(result.isError, undefined);
    assert.deepEqual(result.structuredContent, {
      kind: 'mcp-streamable-http', server: 'http', evidence: {
        type: 'request', version: 1, pathname: '/conformance/mcp',
        query: [['value', 'first value'], ['value', '$APC_HTTP_VALUE'], ['empty', ''], ['encoded', '&=+']],
        headers: { 'x-apc-fixture': 'public marker' },
      },
    });
    assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
    assert.equal(JSON.stringify(result).includes('private'), false);
  });

  await t.test('non-loopback plaintext recovery URLs remain attributable through complete SDK exchanges', async (t) => {
    const mcp = JSON.parse(await readFile(new URL('../plugins/agent-plugins-conformance-recovery/mcp.json', import.meta.url), 'utf8'));
    const cases = [
      {
        server: 'recovery-http-non-loopback', type: 'streamable-http',
        kind: 'mcp-streamable-http', id: 'mcp.streamable-http.url.non-loopback-http',
      },
      {
        server: 'recovery-sse-non-loopback', type: 'sse',
        kind: 'mcp-sse', id: 'mcp.sse.url.non-loopback-http',
      },
    ];

    for (const { server: serverName, type, kind, id } of cases) {
      const configured = mcp.mcpServers[serverName];
      const configuredUrl = `${nonLoopbackOrigin}/conformance/${serverName}`;
      assert.deepEqual(configured, { type, url: configuredUrl });

      const requests = [];
      const trackedFetch = async (input, init) => {
        requests.push({ method: init?.method ?? 'GET', url: String(input) });
        return fetch(input, init);
      };
      const client = new Client({ name: 'non-loopback-reference-test', version: '1' });
      t.after(() => client.close());
      const transport = type === 'streamable-http'
        ? new StreamableHTTPClientTransport(new URL(configured.url), { fetch: trackedFetch })
        : new SSEClientTransport(new URL(configured.url), { fetch: trackedFetch });
      await client.connect(transport);

      assert.equal(client.getServerVersion().name, `agent-plugins-conformance-${serverName}`);
      const tools = (await client.listTools()).tools;
      assert.deepEqual(tools.map(({ name }) => name), ['observe']);
      assert.ok(tools[0].description.includes(`server ID: ${serverName}.`));
      const result = await client.callTool({ name: 'observe', arguments: {} });
      assert.equal(result.isError, undefined);
      assert.equal(result.structuredContent.kind, kind);
      assert.equal(result.structuredContent.server, serverName);
      assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);

      assert.equal(requests[0].url, configured.url);
      assert.ok(requests.length >= 3);
      assert.ok(requests.every(({ url }) => new URL(url).hostname === '0.0.0.0'));
      if (type === 'streamable-http') {
        assert.equal(result.structuredContent.evidence.pathname, `/conformance/${serverName}`);
      } else {
        const { connection, messages } = result.structuredContent.evidence;
        assert.equal(connection.origin, nonLoopbackOrigin);
        assert.ok(messages.length > 0);
        assert.ok(messages.every(({ origin: messageOrigin }) => messageOrigin === nonLoopbackOrigin));
      }

      const observation = type === 'streamable-http'
        ? { ...result.structuredContent, serverHealthCheck: 'passed' }
        : result.structuredContent;
      const report = buildReport({ schemaVersion: 1, observations: [observation] });
      assert.equal(report.results.find((candidate) => candidate.id === id).status, 'fail');
    }
  });

  await t.test('legacy SSE routes reject incompatible methods, sessions, and Streamable HTTP', async (t) => {
    for (const [path, method, status, allow] of [
      ['/conformance/sse', 'POST', 405, 'GET'],
      ['/conformance/sse', 'DELETE', 405, 'GET'],
      ['/conformance/sse/messages', 'GET', 405, 'POST'],
      ['/conformance/sse/messages', 'PUT', 405, 'POST'],
    ]) {
      const response = await http(path, { method });
      assert.equal(response.status, status, `${method} ${path}`);
      assert.equal(response.headers.allow, allow, `${method} ${path}`);
    }
    assert.equal((await http('/conformance/sse/messages', { method: 'POST' })).status, 404);
    assert.equal((await http('/conformance/sse/messages?sessionId=unknown', { method: 'POST' })).status, 404);
    assert.equal((await http('/conformance/sse/messages?sessionId=first&sessionId=second', { method: 'POST' })).status, 404);
    assert.equal((await http('/conformance/sse/')).status, 404);
    assert.equal((await http('/conformance/sse', { headers: { Origin: 'https://unrelated.example' } })).status, 403);
    for (const path of [
      '/conformance/sse',
      '/conformance/sse-header-precedence',
      '/conformance/sse-endpoint-origin',
      '/conformance/sse-redirect',
    ]) {
      assert.equal((await http(path, { headers: { Host: '0.0.0.0:43187' } })).status, 403, path);
    }
    assert.equal((await http('/conformance/recovery-sse-non-loopback', {
      headers: { Host: 'fixture.invalid:43187' },
    })).status, 404);

    const client = new Client({ name: 'incompatible-sse-reference-test', version: '1' });
    t.after(() => client.close());
    await assert.rejects(client.connect(new StreamableHTTPClientTransport(new URL(sseEndpoint))));
  });

  await t.test('legacy SSE clients preserve initial request evidence and isolate session lifetime', async (t) => {
    const literalHeader = '${PLUGIN_ROOT}|${PLUGIN_DATA}|fixture value with spaces';
    const mcp = JSON.parse(await readFile(new URL('../plugins/agent-plugins-conformance-core/mcp.json', import.meta.url), 'utf8'));
    const configured = mcp.mcpServers.sse;
    assert.equal(configured.type, 'sse');
    assert.equal(configured.url, `${sseEndpoint}?value=$APC_SSE_VALUE`);
    const [first, second] = await Promise.all([
      connectSse(t, new URL(configured.url).search, {
        ...configured.headers,
        authorization: 'Bearer private sentinel',
      }),
      connectSse(t, '?value=second+session&value=%26%3D', {
        'x-apc-fixture': 'independent session',
      }),
    ]);

    for (const { client } of [first, second]) {
      assert.equal(client.getServerVersion().name, 'agent-plugins-conformance-sse');
      const { tools } = await client.listTools();
      assert.deepEqual(tools.map(({ name }) => name), ['observe']);
      assert.deepEqual(tools[0].inputSchema, { type: 'object', properties: {}, additionalProperties: false });
      assert.equal(tools[0].annotations.readOnlyHint, true);
    }

    const [firstResult, secondResult] = await Promise.all([first, second].map(({ client }) => (
      client.callTool({ name: 'observe', arguments: {} })
    )));
    assert.deepEqual(firstResult.structuredContent, {
      kind: 'mcp-sse', server: 'sse', evidence: {
        type: 'sse-session', version: 1,
        connection: {
          origin, pathname: '/conformance/sse', query: [['value', '$APC_SSE_VALUE']],
          headers: { 'x-apc-fixture': literalHeader, accept: 'text/event-stream' },
        },
        redirectSource: null,
        messages: Array.from({ length: 4 }, () => ({
          origin, headers: { 'x-apc-fixture': literalHeader },
        })),
      },
    });
    assert.deepEqual(JSON.parse(firstResult.content[0].text), firstResult.structuredContent);
    assert.equal(JSON.stringify(firstResult).includes('private sentinel'), false);
    assert.deepEqual(secondResult.structuredContent.evidence, {
      type: 'sse-session', version: 1,
      connection: {
        origin, pathname: '/conformance/sse', query: [['value', 'second session'], ['value', '&=']],
        headers: { 'x-apc-fixture': 'independent session', accept: 'text/event-stream' },
      },
      redirectSource: null,
      messages: Array.from({ length: 4 }, () => ({
        origin, headers: { 'x-apc-fixture': 'independent session' },
      })),
    });

    const firstGet = first.requests.find(({ method }) => method === 'GET');
    assert.equal(firstGet.url, `${sseEndpoint}?value=$APC_SSE_VALUE`);
    const firstMessageUrl = first.requests.find(({ method }) => method === 'POST').url;
    const secondMessageUrl = second.requests.find(({ method }) => method === 'POST').url;
    assert.equal(new URL(firstMessageUrl).pathname, '/conformance/sse/messages');
    assert.notEqual(firstMessageUrl, secondMessageUrl);

    await first.client.close();
    for (let attempt = 0; attempt < 100; attempt++) {
      const stale = await http(new URL(firstMessageUrl).pathname + new URL(firstMessageUrl).search, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      });
      if (stale.status === 404) break;
      assert.notEqual(attempt, 99, 'Closed SSE session was not removed');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const later = (await second.client.callTool({ name: 'observe', arguments: {} })).structuredContent;
    assert.deepEqual(later.evidence.connection, secondResult.structuredContent.evidence.connection);
    assert.deepEqual(later.evidence.messages.slice(0, -1), secondResult.structuredContent.evidence.messages);
    assert.equal(later.evidence.messages.length, 5);
  });

  await t.test('legacy SSE retains an early incorrect POST header after later correct requests', async (t) => {
    const literal = '${PLUGIN_ROOT}|${PLUGIN_DATA}|fixture value with spaces';
    const client = new Client({ name: 'sse-header-fault-control', version: '1' });
    t.after(() => client.close());
    await client.connect(new SSEClientTransport(new URL(`${sseEndpoint}?value=$APC_SSE_VALUE`), {
      requestInit: { headers: { 'x-apc-fixture': literal } },
      fetch: async (input, init) => {
        const headers = new Headers(init?.headers);
        if (init?.method === 'POST' && JSON.parse(init.body).method === 'initialize') {
          headers.set('x-apc-fixture', 'incorrect early value');
        }
        return fetch(input, { ...init, headers });
      },
    }));
    const observation = (await client.callTool({ name: 'observe', arguments: {} })).structuredContent;
    assert.equal(observation.evidence.messages[0].headers['x-apc-fixture'], 'incorrect early value');
    assert.equal(observation.evidence.messages.at(-1).headers['x-apc-fixture'], literal);
    const report = buildReport({ schemaVersion: 1, observations: [observation] });
    assert.equal(report.results.find(({ id }) => id === 'mcp.sse.headers.literal-value').status, 'pass');
    assert.equal(report.results.find(({ id }) => id === 'mcp.sse.headers.literal-post-value').status, 'fail');
  });

  await t.test('legacy SSE generated Accept precedence has passing and faulty client controls', async (t) => {
    const mcp = JSON.parse(await readFile(new URL('../plugins/agent-plugins-conformance-core/mcp.json', import.meta.url), 'utf8'));
    const configured = mcp.mcpServers['sse-header-precedence'];
    assert.equal(configured.headers.AcCePt, 'application/x-apc-configured');
    const { client: baseline } = await connectSse(t);
    const baselineObservation = (await baseline.callTool({ name: 'observe', arguments: {} })).structuredContent;
    for (const faulty of [false, true]) {
      const client = new Client({ name: 'sse-precedence-reference-test', version: '1' });
      t.after(() => client.close());
      await client.connect(new SSEClientTransport(new URL(configured.url), {
        requestInit: { headers: configured.headers },
        fetch: async (input, init) => {
          const headers = new Headers(init?.headers);
          if (faulty && (init?.method ?? 'GET') === 'GET') headers.set('accept', configured.headers.AcCePt);
          return fetch(input, { ...init, headers });
        },
      }));
      const { tools } = await client.listTools();
      assert.match(tools[0].description, /server ID: sse-header-precedence/);
      const observation = (await client.callTool({ name: 'observe', arguments: {} })).structuredContent;
      assert.equal(observation.server, 'sse-header-precedence');
      assert.equal(observation.evidence.connection.headers.accept, faulty ? configured.headers.AcCePt : 'text/event-stream');
      const report = buildReport({ schemaVersion: 1, observations: [baselineObservation, observation] });
      assert.equal(report.results.find(({ id }) => id === 'mcp.sse.headers.generated-precedence').status,
        faulty ? 'fail' : 'pass');
    }
  });

  await t.test('SDK refuses an absolute cross-origin endpoint before sending initialize', async (t) => {
    const requests = [];
    const client = new Client({ name: 'sdk-origin-refusal', version: '1' });
    t.after(() => client.close());
    const transport = new SSEClientTransport(
      new URL(`${sourceOrigin}/conformance/sse-endpoint-origin?value=%24APC_SSE_ENDPOINT_VALUE`),
      {
        requestInit: { headers: { 'x-apc-fixture': endpointHeader } },
        fetch: async (input, init) => {
          requests.push({ method: init?.method ?? 'GET', url: String(input) });
          return fetch(input, init);
        },
      },
    );
    let diagnostic;
    await assert.rejects(client.connect(transport), (error) => {
      diagnostic = error.message;
      assert.equal(diagnostic, `Endpoint origin does not match connection origin: ${destinationOrigin}`);
      return true;
    });
    const observation = { kind: 'mcp-sse', server: 'sse-endpoint-origin', evidence: {
      type: 'error', message: diagnostic, classification: 'endpoint-refused',
    } };
    const report = buildReport({ schemaVersion: 1, observations: [observation] });
    assert.deepEqual(report.observations, [observation]);
    assert.equal(report.results.find(({ id }) => id === 'mcp.sse.headers.cross-origin-endpoint').status, 'pass');
    assert.deepEqual(requests, [{
      method: 'GET',
      url: `${sourceOrigin}/conformance/sse-endpoint-origin?value=%24APC_SSE_ENDPOINT_VALUE`,
    }]);
  });

  await t.test('permissive endpoint controls retain every stripped or leaked POST independently', async (t) => {
    const open = () => openStream(
      `${sourceOrigin}/conformance/sse-endpoint-origin?value=%24APC_SSE_ENDPOINT_VALUE`,
      { 'x-apc-fixture': endpointHeader },
    );
    const [stripped, leaked, earlyLeak] = await Promise.all([
      open().then((stream) => runProtocol(t, stream, [null])),
      open().then((stream) => runProtocol(t, stream, [endpointHeader])),
      open().then((stream) => runProtocol(t, stream, [endpointHeader, null, null, null])),
    ]);
    for (const evidence of [stripped, leaked, earlyLeak].map(({ evidence }) => evidence)) {
      assert.equal(evidence.type, 'sse-session');
      assert.equal(evidence.connection.origin, sourceOrigin);
      assert.equal(evidence.redirectSource, null);
      assert.equal(evidence.messages.length, 4);
      assert.ok(evidence.messages.every(({ origin }) => origin === destinationOrigin));
    }
    assert.ok(stripped.evidence.messages.every(({ headers }) => headers['x-apc-fixture'] === null));
    assert.ok(leaked.evidence.messages.every(({ headers }) => headers['x-apc-fixture'] === endpointHeader));
    assert.deepEqual(earlyLeak.evidence.messages.map(({ headers }) => headers['x-apc-fixture']),
      [endpointHeader, null, null, null]);
    for (const [observation, expected] of [[stripped, 'pass'], [leaked, 'fail'], [earlyLeak, 'fail']]) {
      const report = buildReport({ schemaVersion: 1, observations: [observation] });
      assert.equal(report.results.find(({ id }) => id === 'mcp.sse.headers.cross-origin-endpoint').status, expected);
    }
  });

  await t.test('redirect controls distinguish stripped and forwarded initial GET headers', async (t) => {
    const [stripped, forwarded] = await Promise.all([
      manualRedirectStream(null).then((stream) => runProtocol(t, stream, [redirectHeader])),
      manualRedirectStream(redirectHeader).then((stream) => runProtocol(t, stream, [redirectHeader])),
    ]);
    assert.equal(stripped.evidence.redirectSource.headers['x-apc-fixture'], redirectHeader);
    assert.equal(stripped.evidence.connection.origin, destinationOrigin);
    assert.equal(stripped.evidence.connection.headers['x-apc-fixture'], null);
    assert.equal(forwarded.evidence.connection.headers['x-apc-fixture'], redirectHeader);
    for (const [observation, expected] of [[stripped, 'pass'], [forwarded, 'fail']]) {
      const report = buildReport({ schemaVersion: 1, observations: [observation] });
      assert.equal(report.results.find(({ id }) => id === 'mcp.sse.headers.cross-origin-redirect').status, expected);
    }
    for (const evidence of [stripped.evidence, forwarded.evidence]) {
      assert.equal(evidence.redirectSource.origin, sourceOrigin);
      assert.equal(evidence.messages.length, 4);
      assert.ok(evidence.messages.every(({ origin }) => origin === sourceOrigin));
    }
  });

  await t.test('SDK redirect behavior returns destination GET evidence through the original-origin endpoint', async (t) => {
    const client = new Client({ name: 'sdk-get-redirect', version: '1' });
    t.after(() => client.close());
    await client.connect(new SSEClientTransport(
      new URL(`${sourceOrigin}/conformance/sse-redirect?value=%24APC_SSE_REDIRECT_VALUE`),
      { requestInit: { headers: { 'x-apc-fixture': redirectHeader } } },
    ));
    const result = await client.callTool({ name: 'observe', arguments: {} });
    assert.equal(result.structuredContent.server, 'sse-redirect');
    assert.equal(result.structuredContent.evidence.redirectSource.headers['x-apc-fixture'], redirectHeader);
    assert.equal(result.structuredContent.evidence.connection.headers['x-apc-fixture'], redirectHeader);
    const report = buildReport({ schemaVersion: 1, observations: [result.structuredContent] });
    assert.equal(report.results.find(({ id }) => id === 'mcp.sse.headers.cross-origin-redirect').status,
      result.structuredContent.evidence.connection.headers['x-apc-fixture'] === null ? 'pass' : 'fail');
  });

  await t.test('scheme-relative SSE URL route has a valid control and a deliberately permissive failure witness', async (t) => {
    const mcp = JSON.parse(await readFile(new URL('../plugins/agent-plugins-conformance-recovery/mcp.json', import.meta.url), 'utf8'));
    const serverName = 'recovery-sse-relative-url';
    const configured = mcp.mcpServers[serverName];
    assert.deepEqual(configured, {
      type: 'sse',
      url: '//127.0.0.1:43187/conformance/recovery-sse-relative-url',
    });

    const correctedUrl = `http:${configured.url}`;
    const observe = async (url) => {
      const { client } = await connectSseAt(t, String(url));
      assert.equal(client.getServerVersion().name, `agent-plugins-conformance-${serverName}`);
      assert.deepEqual((await client.listTools()).tools.map(({ name }) => name), ['observe']);
      const result = await client.callTool({ name: 'observe', arguments: {} });
      const expected = {
        kind: 'mcp-sse', server: serverName, evidence: {
          type: 'sse-session', version: 1,
          connection: { origin, pathname: `/conformance/${serverName}`, query: [],
            headers: { 'x-apc-fixture': null, accept: 'text/event-stream' } },
          redirectSource: null,
          messages: Array.from({ length: 4 }, () => ({ origin, headers: { 'x-apc-fixture': null } })),
        },
      };
      assert.equal(result.isError, undefined);
      assert.deepEqual(result.structuredContent, expected);
      assert.deepEqual(JSON.parse(result.content[0].text), expected);
      return result.structuredContent;
    };

    const validControl = await observe(new URL(correctedUrl));
    const permissiveUrl = new URL(configured.url, 'http://fixture.invalid/');
    assert.equal(permissiveUrl.href, correctedUrl);
    assert.deepEqual(await observe(permissiveUrl), validControl);
    assert.equal(configured.url, '//127.0.0.1:43187/conformance/recovery-sse-relative-url');
  });

  await t.test('invalid SSE URL and header routes have valid controls and permissive failure witnesses', async (t) => {
    const mcp = JSON.parse(await readFile(new URL('../plugins/agent-plugins-conformance-recovery/mcp.json', import.meta.url), 'utf8'));
    const observe = async (serverName, { url, headers = {}, fetch: fetchImpl, expectedHeader = null }) => {
      const { client } = await connectSseAt(t, String(url), '', headers, fetchImpl);
      assert.equal(client.getServerVersion().name, `agent-plugins-conformance-${serverName}`);
      assert.deepEqual((await client.listTools()).tools.map(({ name }) => name), ['observe']);
      const result = await client.callTool({ name: 'observe', arguments: {} });
      const expected = {
        kind: 'mcp-sse', server: serverName, evidence: {
          type: 'sse-session', version: 1,
          connection: { origin, pathname: `/conformance/${serverName}`, query: [],
            headers: { 'x-apc-fixture': expectedHeader, accept: 'text/event-stream' } },
          redirectSource: null,
          messages: Array.from({ length: 4 }, () => ({ origin, headers: { 'x-apc-fixture': expectedHeader } })),
        },
      };
      assert.equal(result.isError, undefined);
      assert.deepEqual(result.structuredContent, expected);
      assert.deepEqual(JSON.parse(result.content[0].text), expected);
    };

    const fragment = mcp.mcpServers['recovery-sse-fragment'];
    const fragmentControl = new URL(fragment.url);
    fragmentControl.hash = '';
    await observe('recovery-sse-fragment', { url: fragmentControl });
    await observe('recovery-sse-fragment', { url: new URL(fragment.url) });
    assert.equal(fragment.url.endsWith('#invalid-fragment'), true);

    const userinfo = mcp.mcpServers['recovery-sse-userinfo'];
    const userinfoControl = new URL(userinfo.url);
    userinfoControl.username = '';
    userinfoControl.password = '';
    await observe('recovery-sse-userinfo', { url: userinfoControl });
    let permissiveRequests = 0;
    await observe('recovery-sse-userinfo', {
      url: new URL(userinfo.url),
      fetch: async (input, init) => {
        const original = new URL(input instanceof Request ? input.url : String(input));
        assert.equal(original.username, 'fixture');
        assert.equal(original.password, 'fixture');
        original.username = '';
        original.password = '';
        permissiveRequests += 1;
        return fetch(original, init);
      },
    });
    assert.ok(permissiveRequests > 0);

    const duplicate = mcp.mcpServers['recovery-sse-duplicate-headers'];
    await observe('recovery-sse-duplicate-headers', {
      url: new URL(duplicate.url), headers: { 'x-apc-duplicate': 'second' },
    });
    await observe('recovery-sse-duplicate-headers', {
      url: new URL(duplicate.url), headers: duplicate.headers,
    });
    assert.deepEqual(duplicate.headers, { 'X-Apc-Duplicate': 'first', 'x-apc-duplicate': 'second' });

    for (const { serverName, correctedHeaders, correctedValue } of [
      { serverName: 'recovery-sse-header-name', correctedHeaders: { 'X-Apc-Fixture': 'fixture' }, correctedValue: 'fixture' },
      { serverName: 'recovery-sse-header-value', correctedHeaders: { 'x-apc-fixture': 'first second' }, correctedValue: 'first second' },
    ]) {
      const configured = mcp.mcpServers[serverName];
      await observe(serverName, { url: new URL(configured.url), headers: correctedHeaders, expectedHeader: correctedValue });
      // Model an incorrect loader that accepts the entry and drops its malformed header.
      await observe(serverName, { url: new URL(configured.url) });
    }
  });

  await t.test('SDK connects despite a conflicting configured Accept header', async (t) => {
    const mcp = JSON.parse(await readFile(new URL('../plugins/agent-plugins-conformance-core/mcp.json', import.meta.url), 'utf8'));
    const configured = mcp.mcpServers.http;
    const configuredUrl = new URL(configured.url);
    const client = await connect(t, configuredUrl.search, configured.headers);
    const result = await client.callTool({ name: 'observe', arguments: {} });
    assert.deepEqual(result.structuredContent, {
      kind: 'mcp-streamable-http', server: 'http', evidence: {
        type: 'request', version: 1, pathname: configuredUrl.pathname,
        query: [['value', '$APC_HTTP_VALUE']],
        headers: { 'x-apc-fixture': configured.headers['x-apc-fixture'] },
      },
    });
    const initialize = await http(configuredUrl.pathname + configuredUrl.search, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: configured.headers.AcCePt },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
      }),
    });
    assert.equal(initialize.status, 406);
  });

  await t.test('direct SDK transport can run semantically invalid recovery HTTP configs', async (t) => {
    const mcp = JSON.parse(await readFile(new URL('../plugins/agent-plugins-conformance-recovery/mcp.json', import.meta.url), 'utf8'));
    for (const serverName of ['recovery-http-fragment', 'recovery-http-duplicate-headers']) {
      const configured = mcp.mcpServers[serverName];
      const client = new Client({ name: 'invalid-config-reference-test', version: '1' });
      t.after(() => client.close());
      await client.connect(new StreamableHTTPClientTransport(new URL(configured.url), {
        requestInit: { headers: configured.headers },
      }));
      assert.equal(client.getServerVersion().name, `agent-plugins-conformance-${serverName}`);
      assert.deepEqual((await client.listTools()).tools.map(({ name }) => name), ['observe']);
      const result = await client.callTool({ name: 'observe', arguments: {} });
      assert.equal(result.isError, undefined);
      assert.deepEqual(result.structuredContent, {
        kind: 'mcp-streamable-http', server: serverName, evidence: {
          type: 'request', version: 1, pathname: `/conformance/${serverName}`,
          query: [], headers: { 'x-apc-fixture': null },
        },
      });
      assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
    }
  });

  await t.test('legacy HTTP type route has a valid control and a deliberately permissive failure witness', async (t) => {
    const mcp = JSON.parse(await readFile(new URL('../plugins/agent-plugins-conformance-recovery/mcp.json', import.meta.url), 'utf8'));
    const configured = mcp.mcpServers['recovery-http-type'];
    assert.deepEqual(configured, {
      type: 'http',
      url: 'http://127.0.0.1:43187/conformance/recovery-http-type',
    });
    const normalizedForHarness = { ...configured, type: 'streamable-http' };
    const client = new Client({ name: 'legacy-http-type-reference-test', version: '1' });
    t.after(() => client.close());
    await client.connect(new StreamableHTTPClientTransport(new URL(normalizedForHarness.url)));
    assert.equal(client.getServerVersion().name, 'agent-plugins-conformance-recovery-http-type');
    const tools = (await client.listTools()).tools;
    assert.deepEqual(tools.map(({ name }) => name), ['observe']);
    assert.match(tools[0].description, /server ID: recovery-http-type\./);
    const result = await client.callTool({ name: 'observe', arguments: {} });
    const observation = {
      kind: 'mcp-streamable-http', server: 'recovery-http-type', serverHealthCheck: 'passed',
      evidence: {
        type: 'request', version: 1, pathname: '/conformance/recovery-http-type',
        query: [], headers: { 'x-apc-fixture': null },
      },
    };
    assert.equal(result.isError, undefined);
    assert.deepEqual(result.structuredContent, {
      kind: observation.kind, server: observation.server, evidence: observation.evidence,
    });
    assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
    const report = buildReport({ schemaVersion: 1, observations: [observation] });
    assert.equal(report.results.find(({ id }) => id === 'mcp.config.legacy-http-type').status, 'fail');
    assert.deepEqual(report.observations, [observation]);
    assert.equal(configured.type, 'http');
  });

  await t.test('userinfo route has a valid control and a deliberately permissive failure witness', async (t) => {
    const mcp = JSON.parse(await readFile(new URL('../plugins/agent-plugins-conformance-recovery/mcp.json', import.meta.url), 'utf8'));
    const configured = mcp.mcpServers['recovery-http-userinfo'];
    const configuredUrl = new URL(configured.url);
    assert.equal(configuredUrl.username, 'fixture');
    assert.equal(configuredUrl.password, 'fixture');

    const expected = {
      kind: 'mcp-streamable-http', server: 'recovery-http-userinfo', evidence: {
        type: 'request', version: 1, pathname: '/conformance/recovery-http-userinfo',
        query: [], headers: { 'x-apc-fixture': null },
      },
    };
    const observe = async (transport) => {
      const client = new Client({ name: 'userinfo-reference-test', version: '1' });
      t.after(() => client.close());
      await client.connect(transport);
      assert.equal(client.getServerVersion().name, 'agent-plugins-conformance-recovery-http-userinfo');
      assert.deepEqual((await client.listTools()).tools.map(({ name }) => name), ['observe']);
      const result = await client.callTool({ name: 'observe', arguments: {} });
      assert.equal(result.isError, undefined);
      assert.deepEqual(result.structuredContent, expected);
      assert.deepEqual(JSON.parse(result.content[0].text), expected);
    };

    const validControl = new URL(configuredUrl);
    validControl.username = '';
    validControl.password = '';
    assert.equal(validControl.pathname, configuredUrl.pathname);
    await observe(new StreamableHTTPClientTransport(validControl));

    let permissiveRequests = 0;
    await observe(new StreamableHTTPClientTransport(new URL(configured.url), {
      // This test-only fetch models an incorrect client accepting the invalid entry.
      // It deliberately strips userinfo before calling the platform fetch; the SDK does not do that for us.
      fetch: async (input, init) => {
        const original = new URL(input instanceof Request ? input.url : String(input));
        assert.equal(original.username, 'fixture');
        assert.equal(original.password, 'fixture');
        const sent = new URL(original);
        sent.username = '';
        sent.password = '';
        permissiveRequests += 1;
        return fetch(sent, init);
      },
    }));
    assert.ok(permissiveRequests > 0);
    assert.equal(configuredUrl.username, 'fixture');
    assert.equal(configuredUrl.password, 'fixture');
  });

  await t.test('scheme-relative URL route has a valid control and a deliberately permissive failure witness', async (t) => {
    const mcp = JSON.parse(await readFile(new URL('../plugins/agent-plugins-conformance-recovery/mcp.json', import.meta.url), 'utf8'));
    const configured = mcp.mcpServers['recovery-http-relative-url'];
    assert.deepEqual(configured, {
      type: 'streamable-http',
      url: '//127.0.0.1:43187/conformance/recovery-http-relative-url',
    });

    const correctedUrl = `http:${configured.url}`;
    const observe = async (url) => {
      const client = new Client({ name: 'relative-url-reference-test', version: '1' });
      t.after(() => client.close());
      await client.connect(new StreamableHTTPClientTransport(url));
      assert.equal(client.getServerVersion().name, 'agent-plugins-conformance-recovery-http-relative-url');
      assert.deepEqual((await client.listTools()).tools.map(({ name }) => name), ['observe']);
      const result = await client.callTool({ name: 'observe', arguments: {} });
      const expected = {
        kind: 'mcp-streamable-http', server: 'recovery-http-relative-url', evidence: {
          type: 'request', version: 1, pathname: '/conformance/recovery-http-relative-url',
          query: [], headers: { 'x-apc-fixture': null },
        },
      };
      assert.equal(result.isError, undefined);
      assert.deepEqual(result.structuredContent, expected);
      assert.deepEqual(JSON.parse(result.content[0].text), expected);
      return result.structuredContent;
    };

    const validControl = await observe(new URL(correctedUrl));

    // Supplying a base models an incorrect loader accepting the unchanged
    // scheme-relative URL before constructing the SDK transport.
    const permissiveUrl = new URL(configured.url, 'http://fixture.invalid/');
    assert.equal(permissiveUrl.href, correctedUrl);
    const permissiveObservation = await observe(permissiveUrl);
    assert.deepEqual(permissiveObservation, validControl);
    assert.equal(configured.url, '//127.0.0.1:43187/conformance/recovery-http-relative-url');
  });

  await t.test('invalid header routes have valid controls and deliberately permissive failure witnesses', async (t) => {
    const mcp = JSON.parse(await readFile(new URL('../plugins/agent-plugins-conformance-recovery/mcp.json', import.meta.url), 'utf8'));
    const cases = [
      {
        server: 'recovery-http-header-name',
        configuredHeaders: { 'X Apc Fixture': 'fixture' },
        correctedHeaders: { 'X-Apc-Fixture': 'fixture' },
        correctedValue: 'fixture',
      },
      {
        server: 'recovery-http-header-value',
        configuredHeaders: { 'x-apc-fixture': 'first\r\nsecond' },
        correctedHeaders: { 'x-apc-fixture': 'first second' },
        correctedValue: 'first second',
      },
    ];

    for (const { server: serverName, configuredHeaders, correctedHeaders, correctedValue } of cases) {
      const configured = mcp.mcpServers[serverName];
      assert.deepEqual(configured.headers, configuredHeaders);

      const observe = async (headers, expectedValue) => {
        const client = new Client({ name: 'invalid-header-reference-test', version: '1' });
        t.after(() => client.close());
        await client.connect(new StreamableHTTPClientTransport(new URL(configured.url), {
          requestInit: { headers },
        }));
        assert.equal(client.getServerVersion().name, `agent-plugins-conformance-${serverName}`);
        assert.deepEqual((await client.listTools()).tools.map(({ name }) => name), ['observe']);
        const result = await client.callTool({ name: 'observe', arguments: {} });
        const expected = {
          kind: 'mcp-streamable-http', server: serverName, evidence: {
            type: 'request', version: 1, pathname: `/conformance/${serverName}`,
            query: [], headers: { 'x-apc-fixture': expectedValue },
          },
        };
        assert.equal(result.isError, undefined);
        assert.deepEqual(result.structuredContent, expected);
        assert.deepEqual(JSON.parse(result.content[0].text), expected);
      };

      await observe(correctedHeaders, correctedValue);

      // Model an incorrect configuration loader that accepts this invalid entry
      // and drops its malformed header before constructing the SDK transport.
      const permissiveHeaders = structuredClone(configured.headers);
      for (const name of Object.keys(permissiveHeaders)) delete permissiveHeaders[name];
      assert.deepEqual(permissiveHeaders, {});
      assert.deepEqual(configured.headers, configuredHeaders);
      await observe(permissiveHeaders, null);
    }
  });

  await t.test('invalid tool calls produce errors without observations', async (t) => {
    const client = await connect(t);
    for (const args of [{ extra: true }, undefined]) {
      const result = await client.callTool({ name: 'observe', ...(args === undefined ? {} : { arguments: args }) });
      assert.equal(result.isError, true);
      assert.equal(result.structuredContent, undefined);
      assert.match(result.content[0].text, /observe requires an empty object/);
    }
    const unknown = await client.callTool({ name: 'unknown', arguments: {} });
    assert.equal(unknown.isError, true);
    assert.equal(unknown.structuredContent, undefined);
    assert.match(unknown.content[0].text, /Unknown tool: unknown/);
    const malformed = await http('/conformance/mcp', {
      method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: '{',
    });
    assert.equal(malformed.status, 400);
    assert.equal((await client.callTool({ name: 'observe', arguments: {} })).isError, undefined);
  });

  await t.test('concurrent clients and repeated calls cannot share observation state', async (t) => {
    await Promise.all(Array.from({ length: 8 }, async (_, index) => {
      const client = await connect(t, `?value=client-${index}`, { 'x-apc-fixture': `header-${index}` });
      const results = await Promise.all(Array.from({ length: 3 }, () => client.callTool({ name: 'observe', arguments: {} })));
      for (const result of results) {
        assert.deepEqual(result.structuredContent.evidence.query, [['value', `client-${index}`]]);
        assert.deepEqual(result.structuredContent.evidence.headers, { 'x-apc-fixture': `header-${index}` });
      }
    }));
    const empty = await connect(t);
    const result = await empty.callTool({ name: 'observe', arguments: {} });
    assert.deepEqual(result.structuredContent.evidence.query, []);
    assert.deepEqual(result.structuredContent.evidence.headers, { 'x-apc-fixture': null });
  });

  await t.test('redirect fixture reports the request received at the destination', async (t) => {
    const client = new Client({ name: 'redirect-reference-test', version: '1' });
    t.after(() => client.close());
    await client.connect(new StreamableHTTPClientTransport(new URL(`${origin}/conformance/redirect`)));
    assert.deepEqual((await client.listTools()).tools.map(({ name }) => name), ['observe']);
    const body = JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'observe', arguments: {} } });
    const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
    for (const marker of [undefined, 'wrong']) {
      const response = await fetch(`${origin}/conformance/redirect`, {
        method: 'POST', headers: { ...headers, ...(marker === undefined ? {} : { 'x-apc-fixture': marker }) },
        body, redirect: 'manual',
      });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).result.isError, true);
    }
    const source = await fetch(`${origin}/conformance/redirect`, {
      method: 'POST', headers: { ...headers, 'x-apc-fixture': 'public redirect fixture value' }, body, redirect: 'manual',
    });
    assert.equal(source.status, 307);
    const target = new URL(source.headers.get('location'));
    assert.equal(target.origin, 'http://127.0.0.1:43189');
    assert.equal(target.searchParams.get('sourceHeader'), 'public redirect fixture value');
    for (const receivedHeader of [null, 'public redirect fixture value']) {
      const response = await fetch(target, {
        method: 'POST', headers: { ...headers, ...(receivedHeader === null ? {} : { 'x-apc-fixture': receivedHeader }) }, body,
      });
      assert.equal(response.status, 200);
      const result = (await response.json()).result;
      assert.deepEqual(result.structuredContent, {
        kind: 'mcp-streamable-http', server: 'http-redirect',
        evidence: {
          type: 'request', version: 1, pathname: '/conformance/redirect',
          query: [['sourceHeader', 'public redirect fixture value']],
          headers: { 'x-apc-fixture': receivedHeader },
        },
      });
      assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
    }
  });

  await t.test('stopping the process releases the listener', async () => {
    const openSse = await connectSse(t, '?value=open-during-shutdown');
    assert.deepEqual((await openSse.client.callTool({ name: 'observe', arguments: {} })).structuredContent.evidence.connection.query,
      [['value', 'open-during-shutdown']]);
    // Windows terminates the process directly rather than invoking its SIGTERM handler.
    assert.deepEqual(await server.stop(), process.platform === 'win32' ? [null, 'SIGTERM'] : [0, null]);
    assert.equal(server.stderr(), '');
    await assert.rejects(http('/conformance/health'), { code: 'ECONNREFUSED' });
  });
});

test('either occupied HTTP port prevents readiness and releases the other listener', { timeout: 15_000 }, async () => {
  const entry = new URL('../plugins/agent-plugins-conformance-core/dist/serve-http.mjs', import.meta.url);
  for (const occupied of [43187, 43189]) {
    const blocker = createServer();
    blocker.listen(occupied, '127.0.0.1');
    await once(blocker, 'listening');
    const child = spawn(process.execPath, [fileURLToPath(entry)], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    try {
      assert.deepEqual(await within(once(child, 'exit'), 3_000, 'Failed startup retained a listener'), [1, null]);
      assert.equal(stdout, '');
      assert.ok(stderr.includes(`127.0.0.1:${occupied}/`), stderr);
      assert.ok(stderr.includes('EADDRINUSE'), stderr);
      const other = createServer();
      other.listen(occupied === 43187 ? 43189 : 43187, '127.0.0.1');
      await once(other, 'listening');
      await new Promise((resolve) => other.close(resolve));
    } finally {
      child.kill('SIGKILL');
      await new Promise((resolve) => blocker.close(resolve));
    }
  }
});
