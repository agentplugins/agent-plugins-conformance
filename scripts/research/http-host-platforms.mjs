import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import { connect as tcpConnect } from 'node:net';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const records = [];
const record = value => { records.push(value); console.log(JSON.stringify(value)); };
const errorData = error => ({ name: error.name, message: error.message, code: error.code,
  ...(error.cause ? { cause: errorData(error.cause) } : {}) });
async function within(promise, milliseconds) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Timed out')), milliseconds); })]); }
  finally { clearTimeout(timer); }
}
function tcp(host) {
  return new Promise(resolve => {
    const socket = tcpConnect({ host, port: 43187 });
    const finish = result => { socket.destroy(); resolve(result); };
    socket.setTimeout(5000, () => finish({ status: 'timeout' }));
    socket.once('connect', () => finish({ status: 'connected', remoteAddress: socket.remoteAddress, remotePort: socket.remotePort }));
    socket.once('error', error => finish({ status: 'error', error: errorData(error) }));
  });
}
async function health(host) {
  try {
    const response = await fetch(`http://${host}:43187/conformance/health`, { signal: AbortSignal.timeout(5000) });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.fixture, 'agent-plugins-conformance-http');
    return { status: 'pass', httpStatus: response.status, body };
  } catch (error) { return { status: 'error', error: errorData(error) }; }
}
async function mcp(host) {
  const requested = `http://${host}:43187/conformance/mcp?hostProbe=${host}`;
  const requests = [];
  const marker = `host-probe-${host}`;
  const client = new Client({ name: 'host-policy-reference', version: '1' });
  const transport = new StreamableHTTPClientTransport(new URL(requested), {
    requestInit: { headers: { 'x-apc-fixture': marker } },
    fetch: (input, init) => {
      requests.push({ url: String(input), method: init?.method ?? 'GET' });
      return fetch(input, { ...init, signal: AbortSignal.any([...(init?.signal ? [init.signal] : []), AbortSignal.timeout(5000)]) });
    },
  });
  try {
    await within(client.connect(transport), 10000);
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map(tool => tool.name), ['observe']);
    const result = await client.callTool({ name: 'observe', arguments: {} });
    const observation = result.structuredContent;
    assert.equal(observation.server, 'http');
    assert.deepEqual(observation.evidence.query, [['hostProbe', host]]);
    assert.equal(observation.evidence.headers['x-apc-fixture'], marker);
    return { status: 'pass', requested, requests, observation };
  } catch (error) { return { status: 'error', requested, requests, error: errorData(error) }; }
  finally { await client.close(); }
}

record({ environment: { platform: process.platform, release: os.release(), arch: process.arch, node: process.version },
  purpose: 'Reference reachability and MCP exchange; deliberately no Agent Plugins URL policy enforcement' });
const child = spawn(process.execPath, [fileURLToPath(new URL('../../plugins/agent-plugins-conformance-core/dist/serve-http.mjs', import.meta.url))], { stdio: ['ignore', 'pipe', 'pipe'] });
const exited = once(child, 'exit');
let stdout = '', stderr = '';
child.stdout.on('data', chunk => { stdout += chunk; });
child.stderr.on('data', chunk => { stderr += chunk; });
try {
  await within(Promise.race([
    (async () => { while (!stdout.includes('\n')) await once(child.stdout, 'data'); assert.equal(JSON.parse(stdout.trim()).ready, true); })(),
    exited.then(() => { throw new Error(`Helper exited: ${stderr}`); }),
  ]), 10000);
  for (const host of ['127.0.0.1', '0.0.0.0']) {
    const results = { host, tcp: await tcp(host), health: await health(host), mcp: await mcp(host) };
    record(results);
    if (host === '127.0.0.1') {
      assert.equal(results.tcp.status, 'connected');
      assert.equal(results.health.status, 'pass');
      assert.equal(results.mcp.status, 'pass');
    }
  }
} finally {
  if (child.exitCode === null && child.signalCode === null) child.kill();
  await within(exited, 5000).catch(async () => { child.kill('SIGKILL'); await exited; });
  record({ helperStderr: stderr });
  await mkdir('reports/http-host', { recursive: true });
  await writeFile('reports/http-host/results.json', JSON.stringify(records, null, 2) + '\n');
}
