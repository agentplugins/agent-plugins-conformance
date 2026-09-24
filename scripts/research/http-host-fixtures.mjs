import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { buildReport } from '../../plugins/agent-plugins-conformance/src/report.mjs';

const helperPath = fileURLToPath(new URL(
  '../../plugins/agent-plugins-conformance-core/dist/serve-http.mjs', import.meta.url,
));
const resultPath = fileURLToPath(new URL('../../reports/http-host-fixtures/result.json', import.meta.url));
const HTTP_CONTROL_URL = 'http://127.0.0.1:43187/conformance/mcp?value=$APC_HTTP_VALUE';
const SSE_CONTROL_URL = 'http://127.0.0.1:43187/conformance/sse?value=$APC_SSE_VALUE';
const CASES = [
  {
    id: 'mcp.streamable-http.url.non-loopback-http',
    kind: 'mcp-streamable-http',
    server: 'recovery-http-non-loopback',
    transport: 'streamable-http',
    url: 'http://0.0.0.0:43187/conformance/recovery-http-non-loopback',
  },
  {
    id: 'mcp.sse.url.non-loopback-http',
    kind: 'mcp-sse',
    server: 'recovery-sse-non-loopback',
    transport: 'sse',
    url: 'http://0.0.0.0:43187/conformance/recovery-sse-non-loopback',
  },
];

function errorData(error) {
  return {
    name: error.name,
    message: error.message,
    ...(error.code === undefined ? {} : { code: error.code }),
    ...(error.cause ? { cause: errorData(error.cause) } : {}),
  };
}

async function within(promise, milliseconds, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${milliseconds} ms`)), milliseconds);
        timer.unref();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function waitForReady(child, exited, stdoutState, stderrState) {
  await within(Promise.race([
    (async () => {
      while (true) {
        const lineEnd = stdoutState.value.indexOf('\n');
        if (lineEnd !== -1) {
          const line = stdoutState.value.slice(0, lineEnd);
          assert.equal(JSON.parse(line).ready, true, `Unexpected helper readiness line: ${line}`);
          return;
        }
        await once(child.stdout, 'data');
      }
    })(),
    exited.then(([code, signal]) => {
      throw new Error(`HTTP helper exited before readiness (code ${code}, signal ${signal}): ${stderrState.value}`);
    }),
  ]), 10_000, 'HTTP helper readiness');
}

async function healthCheck() {
  const response = await within(fetch('http://127.0.0.1:43187/conformance/health'), 5_000, 'HTTP helper health check');
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(body, { fixture: 'agent-plugins-conformance-http', version: 1 });
  return { status: response.status, body };
}

async function exchange({ transport: transportName, url, server, kind }) {
  const requestedUrl = new URL(url);
  const requests = [];
  const trackedFetch = async (input, init) => {
    requests.push({ url: String(input), method: init?.method ?? 'GET' });
    return fetch(input, init);
  };
  const transport = transportName === 'streamable-http'
    ? new StreamableHTTPClientTransport(requestedUrl, { fetch: trackedFetch })
    : new SSEClientTransport(requestedUrl, {
      fetch: trackedFetch,
      eventSourceInit: { fetch: trackedFetch },
    });
  const client = new Client({ name: 'agent-plugins-conformance-http-host-research', version: '1.0.0' });
  try {
    await within(client.connect(transport), 10_000, `${server} initialize`);
    const listed = await within(client.listTools(), 10_000, `${server} tools/list`);
    assert.deepEqual(listed.tools.map(({ name }) => name), ['observe']);
    const called = await within(client.callTool({ name: 'observe', arguments: {} }), 10_000, `${server} tools/call`);
    assert.equal(called.isError, undefined);
    assert.ok(called.structuredContent && typeof called.structuredContent === 'object');
    assert.equal(called.structuredContent.kind, kind);
    assert.equal(called.structuredContent.server, server);
    assert.ok(requests.length >= 3, `${server}: expected initialize, listTools, and callTool network requests`);
    return {
      status: 'completed',
      requestedUrl: requestedUrl.href,
      requests,
      listedTools: listed.tools.map(({ name }) => name),
      observation: called.structuredContent,
    };
  } catch (error) {
    return { status: 'error', requestedUrl: requestedUrl.href, requests, error: errorData(error) };
  } finally {
    await within(client.close(), 5_000, `${server} client close`);
  }
}

function recoveryControl() {
  return {
    kind: 'mcp-stdio',
    server: 'recovery-valid',
    evidence: {
      version: 1,
      server: 'recovery-valid',
      resolvedData: '/synthetic/reporter-fixture/recovery-data',
      symlinkCwd: 'symlink',
    },
  };
}

function reporterObservation(exchangeResult, definition) {
  assert.equal(exchangeResult.status, 'completed', `${definition.server}: ${JSON.stringify(exchangeResult)}`);
  return {
    ...exchangeResult.observation,
    ...(definition.kind === 'mcp-streamable-http' ? { serverHealthCheck: 'passed' } : {}),
  };
}

function connectionError(definition) {
  return {
    kind: definition.kind,
    server: definition.server,
    evidence: { type: 'error', message: 'Synthetic reporter connection-error fixture', classification: null },
    ...(definition.kind === 'mcp-streamable-http' ? { serverHealthCheck: 'passed' } : {}),
  };
}

function selectedResult(report, id) {
  const result = report.results.find((candidate) => candidate.id === id);
  assert.ok(result, `Missing reporter result: ${id}`);
  return { status: result.status, detail: result.detail, summary: report.summary };
}

function verifyReporter(definition, invalidObservation, validControl) {
  const discoveryAbsent = { kind: 'mcp-discovery', server: definition.server, advertised: false };
  const controls = [recoveryControl(), validControl];
  const scenarios = {
    attributableRuntime: buildReport({
      schemaVersion: 1,
      observations: [discoveryAbsent, ...controls, invalidObservation],
    }),
    completeDiscoveryAbsence: buildReport({
      schemaVersion: 1,
      observations: [discoveryAbsent, ...controls],
    }),
    missingEvidence: buildReport({ schemaVersion: 1, observations: [] }),
    connectionError: buildReport({
      schemaVersion: 1,
      observations: [discoveryAbsent, ...controls, connectionError(definition)],
    }),
  };
  const actual = Object.fromEntries(Object.entries(scenarios)
    .map(([name, report]) => [name, selectedResult(report, definition.id)]));
  assert.deepEqual(Object.fromEntries(Object.entries(actual).map(([name, value]) => [name, value.status])), {
    attributableRuntime: 'fail',
    completeDiscoveryAbsence: 'pass',
    missingEvidence: 'not_verified',
    connectionError: 'not_verified',
  });
  for (const report of Object.values(scenarios)) {
    assert.deepEqual(buildReport({ schemaVersion: report.schemaVersion, observations: report.observations }), report);
  }
  return actual;
}

const child = spawn(process.execPath, [helperPath], { stdio: ['ignore', 'pipe', 'pipe'] });
const exited = once(child, 'exit');
const stdoutState = { value: '' };
const stderrState = { value: '' };
child.stdout.on('data', (chunk) => { stdoutState.value += chunk; });
child.stderr.on('data', (chunk) => { stderrState.value += chunk; });

const evidence = {
  provenance: {
    exchanges: 'Actual full initialize, tools/list, and tools/call exchanges through the official SDK and bundled Core helper.',
    reporterRuntimeFailures: 'Actual invalid-URL observations returned by those SDK exchanges.',
    reporterControls: 'Synthetic saved-observation fixtures matching test/report.test.mjs; they test evaluator branches and are not native-client pass evidence.',
  },
  environment: {
    platform: process.platform,
    release: os.release(),
    arch: process.arch,
    node: process.version,
    sdk: '@modelcontextprotocol/sdk@1.30.0',
  },
  helper: { path: helperPath },
  exchanges: {},
  reporter: {},
};
let completed = false;

try {
  await waitForReady(child, exited, stdoutState, stderrState);
  evidence.helper.health = await healthCheck();

  const httpControlDefinition = {
    kind: 'mcp-streamable-http', server: 'http', transport: 'streamable-http', url: HTTP_CONTROL_URL,
  };
  const sseControlDefinition = { kind: 'mcp-sse', server: 'sse', transport: 'sse', url: SSE_CONTROL_URL };
  evidence.exchanges.httpControl = await exchange(httpControlDefinition);
  evidence.exchanges.sseControl = await exchange(sseControlDefinition);
  const validControls = {
    'streamable-http': reporterObservation(evidence.exchanges.httpControl, httpControlDefinition),
    sse: reporterObservation(evidence.exchanges.sseControl, sseControlDefinition),
  };

  for (const definition of CASES) {
    const actual = await exchange(definition);
    evidence.exchanges[definition.server] = actual;
    const observation = reporterObservation(actual, definition);
    assert.equal(actual.requestedUrl, new URL(definition.url).href);
    assert.equal(actual.requests[0].url, new URL(definition.url).href);
    assert.ok(actual.requests.every(({ url }) => new URL(url).hostname === '0.0.0.0'),
      `${definition.server}: SDK rewrote a request away from 0.0.0.0`);
    if (definition.kind === 'mcp-streamable-http') {
      assert.equal(observation.evidence.pathname, `/conformance/${definition.server}`);
    } else {
      assert.equal(observation.evidence.type, 'sse-session');
      assert.equal(observation.evidence.connection.origin, 'http://0.0.0.0:43187');
      assert.equal(observation.evidence.connection.pathname, `/conformance/${definition.server}`);
      assert.ok(observation.evidence.messages.length >= 3);
      assert.ok(observation.evidence.messages.every(({ origin }) => origin === 'http://0.0.0.0:43187'));
    }
    evidence.reporter[definition.id] = verifyReporter(
      definition,
      observation,
      validControls[definition.transport],
    );
  }
  completed = true;
} finally {
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  await within(exited, 5_000, 'HTTP helper shutdown').catch(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
  });
  evidence.helper.stdout = stdoutState.value;
  evidence.helper.stderr = stderrState.value;
  evidence.helper.exit = { code: child.exitCode, signal: child.signalCode };
  await mkdir(new URL('../../reports/http-host-fixtures/', import.meta.url), { recursive: true });
  await writeFile(resultPath, `${JSON.stringify(evidence, null, 2)}\n`);
  if (completed) {
    // Windows terminates SIGTERM targets directly instead of running their handler.
    assert.deepEqual(evidence.helper.exit, process.platform === 'win32'
      ? { code: null, signal: 'SIGTERM' } : { code: 0, signal: null },
    'HTTP helper did not stop as requested');
  }
}

console.log(`HTTP host fixture research passed; evidence: ${resultPath}`);
