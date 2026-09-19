import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const origin = 'http://127.0.0.1:43187';
const endpoint = `${origin}/conformance/mcp`;

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
        version: 1, pathname: '/conformance/mcp',
        query: [['value', 'first value'], ['value', '$APC_HTTP_VALUE'], ['empty', ''], ['encoded', '&=+']],
        headers: { 'x-apc-fixture': 'public marker' },
      },
    });
    assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
    assert.equal(JSON.stringify(result).includes('private'), false);
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

  await t.test('stopping the process releases the listener', async () => {
    // Windows terminates the process directly rather than invoking its SIGTERM handler.
    assert.deepEqual(await server.stop(), process.platform === 'win32' ? [null, 'SIGTERM'] : [0, null]);
    assert.equal(server.stderr(), '');
    await assert.rejects(http('/conformance/health'), { code: 'ECONNREFUSED' });
  });
});
