import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { formatReport } from '../plugins/agent-plugins-conformance/src/report-format.mjs';
import { buildReport } from '../plugins/agent-plugins-conformance/src/report.mjs';

const script = fileURLToPath(new URL('../plugins/agent-plugins-conformance/skills/run-conformance/scripts/report.mjs', import.meta.url));
const start = { action: 'start' };
const skill = (name = 'alpha', marker = `APC_${name.toUpperCase()}_V1`) => ({ kind: 'skill', skill: `conformance-${name}`, marker });
const discovery = (advertised = false) => ({ kind: 'skill-discovery', skill: 'conformance-nested', advertised });
const mcp = () => ({
  kind: 'mcp-stdio', server: 'default', evidence: {
    version: 1, server: 'default', root: '/plugin', cwd: '/plugin', resolvedData: '/data',
    dataWrite: { path: '/data/.agent-plugins-conformance-write-test', error: null, cleanupError: null },
    argv: ['default', 'arg with spaces', '', '/plugin', '/data', '${APC_UNKNOWN}', '$APC_VALUE', '${PLUGIN_ROOT_SUFFIX}'],
    env: {
      PLUGIN_ROOT: '/plugin', PLUGIN_DATA: '/data', APC_VALUE: 'fixture value with spaces',
      APC_EXPANSION: '/plugin|/data|/plugin', APC_LITERAL: '${APC_UNKNOWN}|$APC_VALUE|${PLUGIN_ROOT_SUFFIX}',
    },
  },
});
const recoverySkill = (marker = 'APC_RECOVERY_VALID_V1') => ({
  kind: 'skill', skill: 'conformance-recovery-valid', marker,
});
const recoveryMcp = (symlinkCwd = 'symlink') => ({
  kind: 'mcp-stdio', server: 'recovery-valid',
  evidence: { version: 1, server: 'recovery-valid', resolvedData: '/recovery-data', symlinkCwd },
});
const invalidServerRuntime = (server = 'recovery-cwd-escape', root = '/recovery-plugin', cwd = '/parent') => ({
  kind: 'mcp-stdio', server,
  evidence: { version: 1, server, root, cwd },
});
const invalidServerDiscovery = (server = 'recovery-cwd-escape', advertised = false) => ({
  kind: 'mcp-discovery', server, advertised,
});
const invalidServerCases = [
  ['recovery-cwd-invalid-form', 'mcp.stdio.cwd.invalid-form'],
  ['recovery-cwd-escape', 'mcp.stdio.cwd.plugin-relative-escape'],
  ['recovery-cwd-data-escape', 'mcp.stdio.cwd.plugin-data-escape'],
  ['recovery-cwd-symlink-escape', 'filesystem.containment.cwd-symlink-escape'],
  ['recovery-unknown-field', 'mcp.stdio.config.unknown-field'],
  ['recovery-missing-type', 'mcp.config.missing-type'],
  ['recovery-env-plugin-root', 'mcp.stdio.env.reserved-plugin-root'],
  ['recovery-env-plugin-data', 'mcp.stdio.env.reserved-plugin-data'],
];
const invalidHttpServerCases = [
  ['recovery-http-relative-url', 'mcp.streamable-http.url.relative'],
  ['recovery-http-fragment', 'mcp.streamable-http.url.fragment'],
  ['recovery-http-duplicate-headers', 'mcp.streamable-http.headers.duplicate-names'],
  ['recovery-http-userinfo', 'mcp.streamable-http.url.userinfo'],
  ['recovery-http-header-name', 'mcp.streamable-http.headers.invalid-name'],
  ['recovery-http-header-value', 'mcp.streamable-http.headers.invalid-value'],
];
const expected = (observations) => buildReport({ schemaVersion: 1, observations });
const http = () => ({
  kind: 'mcp-streamable-http', server: 'http', evidence: {
    type: 'request', version: 1, pathname: '/conformance/mcp', query: [['value', '$APC_HTTP_VALUE']],
    headers: { 'x-apc-fixture': '${PLUGIN_ROOT}|${PLUGIN_DATA}|fixture value with spaces' },
  },
});
const missingHttp = () => ({ kind: 'mcp-streamable-http', server: 'http', evidence: null });
const invalidHttp = (server, evidence = {
  type: 'request', version: 1, pathname: `/conformance/${server}`, query: [],
  headers: { 'x-apc-fixture': null },
}) => ({ kind: 'mcp-streamable-http', server, evidence });
const redirectError = (classification, message = 'native error\n  with exact whitespace  ') => ({
  kind: 'mcp-streamable-http', server: 'http-redirect',
  evidence: { type: 'error', message, classification },
});

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'record-report-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const outputPath = join(directory, 'nested directory', 'report with spaces.json');
  const run = (message, args = [outputPath], reporter = script, nodeArgs = []) => spawnSync(process.execPath, [...nodeArgs, reporter, ...args], {
    cwd: directory, input: typeof message === 'string' ? message : JSON.stringify(message), encoding: 'utf8', timeout: 10_000,
  });
  const success = (message, reporter) => {
    const result = run(message, [outputPath], reporter);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout, message.action === 'start' ? 'Report started.\n' : 'Observation recorded.\n');
    return result;
  };
  const record = (observation) => success({ action: 'record', observation });
  const read = async () => JSON.parse(await readFile(outputPath, 'utf8'));
  return { directory, outputPath, run, success, record, read };
}

// Preload a fetch double in the recorder process, avoiding shared fixed-port listeners.
async function mockHealth(f) {
  const loader = join(f.directory, 'mock-fetch.mjs');
  const responseFile = join(f.directory, 'health-response.json');
  const callsFile = join(f.directory, 'health-calls.txt');
  await writeFile(loader, `
    import assert from 'node:assert/strict';
    import { appendFile, readFile } from 'node:fs/promises';
    globalThis.fetch = async (url, options) => {
      await appendFile(${JSON.stringify(callsFile)}, 'request\\n');
      assert.equal(url, 'http://127.0.0.1:43187/conformance/health');
      assert.equal(options.redirect, 'error');
      const response = JSON.parse(await readFile(${JSON.stringify(responseFile)}, 'utf8'));
      if (response.error) throw new Error(response.error);
      return { status: response.status, json: async () => response.body };
    };
  `);
  const setResponse = (response) => writeFile(responseFile, JSON.stringify(response));
  await setResponse({ status: 200, body: { fixture: 'agent-plugins-conformance-http', version: 1 } });
  return {
    setResponse,
    calls: async () => {
      try { return (await readFile(callsFile, 'utf8')).trim().split('\n').length; }
      catch (error) { if (error.code === 'ENOENT') return 0; throw error; }
    },
    run: (message, reporter = script) => f.run(message, [f.outputPath], reporter, ['--import', pathToFileURL(loader).href]),
  };
}

test('every HTTP record gets fresh reporter health and replaces the prior attempt in both directions', async (t) => {
  const f = await fixture(t);
  const health = await mockHealth(f);
  for (const message of [start, { action: 'record', observation: skill() }]) {
    const result = health.run(message);
    assert.equal(result.status, 0, result.stderr);
  }
  const attempts = [
    [http(), 'passed'], [missingHttp(), 'passed'], [missingHttp(), 'failed'], [http(), 'failed'],
  ];
  let calls = 0;
  for (const [observation, serverHealthCheck] of attempts) {
    await health.setResponse(serverHealthCheck === 'passed'
      ? { status: 200, body: { fixture: 'agent-plugins-conformance-http', version: 1 } }
      : { error: 'connection refused' });
    const result = health.run({ action: 'record', observation });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'Observation recorded.\n');
    const report = await f.read();
    assert.deepEqual(report, expected([skill(), { ...observation, serverHealthCheck }]));
    assert.equal(report.results.find(({ id }) => id === 'mcp.streamable-http.tool-availability').status,
      observation.evidence ? 'pass' : serverHealthCheck === 'passed' ? 'fail' : 'not_verified');
    assert.equal(await health.calls(), ++calls);
  }
  const reset = health.run(start);
  assert.equal(reset.status, 0, reset.stderr);
  assert.deepEqual(await f.read(), expected([]));
  assert.equal(await health.calls(), calls);
});

test('unrelated records preserve saved HTTP evidence and health without another health request', async (t) => {
  const f = await fixture(t);
  const health = await mockHealth(f);
  for (const observation of [http(), missingHttp()]) {
    const reset = health.run(start);
    assert.equal(reset.status, 0, reset.stderr);
    const result = health.run({ action: 'record', observation });
    assert.equal(result.status, 0, result.stderr);
    const calls = await health.calls();
    for (const observation of [skill(), mcp()]) {
      const result = health.run({ action: 'record', observation });
      assert.equal(result.status, 0, result.stderr);
    }
    assert.deepEqual(await f.read(), expected([skill(), mcp(), { ...observation, serverHealthCheck: 'passed' }]));
    assert.equal(await health.calls(), calls);
  }
});

test('SSE records preserve diagnostics and replace runtime evidence without HTTP health requests', async (t) => {
  const f = await fixture(t);
  const health = await mockHealth(f);
  f.success(start);
  const control = http();
  assert.equal(health.run({ action: 'record', observation: control }).status, 0);
  const diagnostic = 'Agent Plugins legacy SSE transport is not supported\n  exact detail\t';
  const runtime = { ...http().evidence, pathname: '/conformance/sse', query: [['value', '$APC_SSE_VALUE']] };
  const session = {
    type: 'sse-session', version: 1,
    connection: {
      origin: 'http://127.0.0.1:43187', pathname: runtime.pathname, query: runtime.query,
      headers: { ...runtime.headers, accept: 'text/event-stream' },
    },
    redirectSource: null,
    messages: [{ origin: 'http://127.0.0.1:43187', headers: { ...runtime.headers } }],
  };
  for (const evidence of [
    { type: 'error', message: diagnostic, classification: null }, runtime, session, null,
    { type: 'error', message: diagnostic, classification: null },
  ]) {
    const observation = { kind: 'mcp-sse', server: 'sse', evidence };
    const result = health.run({ action: 'record', observation });
    assert.equal(result.status, 0, result.stderr);
    const report = await f.read();
    assert.deepEqual(report, expected([{ ...control, serverHealthCheck: 'passed' }, observation]));
    assert.ok(report.results.filter(({ id }) => id.startsWith('mcp.sse.'))
      .every(({ id, status }) => status === (
        evidence?.type === 'sse-session' || evidence?.type === 'request' && id !== 'mcp.sse.headers.literal-post-value'
          ? 'pass' : 'not_verified')));
    assert.equal(await health.calls(), 1);
  }
  const summary = spawnSync(process.execPath, [fileURLToPath(new URL(
    '../plugins/agent-plugins-conformance/skills/run-conformance/scripts/summarize.mjs', import.meta.url)), f.outputPath],
  { encoding: 'utf8' });
  assert.equal(summary.status, 0, summary.stderr);
  assert.equal(summary.stdout.trimEnd(), formatReport(await f.read()));
  const before = await readFile(f.outputPath, 'utf8');
  const rejected = health.run({ action: 'record', observation: {
    kind: 'mcp-sse', server: 'sse', evidence: runtime, serverHealthCheck: 'passed',
  } });
  assert.equal(rejected.status, 2);
  assert.equal(await readFile(f.outputPath, 'utf8'), before);
  assert.equal(await health.calls(), 1);
});

test('redirect records receive fresh health and replace independently with exact error text', async (t) => {
  const f = await fixture(t);
  const health = await mockHealth(f);
  assert.equal(health.run(start).status, 0);
  assert.equal(health.run({ action: 'record', observation: http() }).status, 0);
  const exact = 'native error\n\n  indented detail\t';
  assert.equal(health.run({ action: 'record', observation: redirectError('redirect-refused', exact) }).status, 0);
  let report = await f.read();
  assert.deepEqual(report.observations, [
    { ...http(), serverHealthCheck: 'passed' },
    { ...redirectError('redirect-refused', exact), serverHealthCheck: 'passed' },
  ]);
  assert.equal(report.observations[1].evidence.message, exact);
  assert.equal(report.results.find(({ id }) => id === 'mcp.streamable-http.headers.cross-origin-redirect').status, 'pass');

  await health.setResponse({ error: 'source health unavailable' });
  assert.equal(health.run({ action: 'record', observation: redirectError(null, exact) }).status, 0);
  report = await f.read();
  assert.deepEqual(report.observations, [
    { ...http(), serverHealthCheck: 'passed' },
    { ...redirectError(null, exact), serverHealthCheck: 'failed' },
  ]);
  assert.equal(report.results.find(({ id }) => id === 'mcp.streamable-http.headers.cross-origin-redirect').status, 'not_verified');
  assert.equal(await health.calls(), 3);
});

test('missing evidence and an interrupted collection stay unverified without health checks', async (t) => {
  const f = await fixture(t);
  const health = await mockHealth(f);
  const result = health.run(start);
  assert.equal(result.status, 0, result.stderr);
  assert.equal((await f.read()).summary.fail, 0);
  const recorded = health.run({ action: 'record', observation: skill() });
  assert.equal(recorded.status, 0, recorded.stderr);
  const report = await f.read();
  assert.deepEqual(report.observations, [skill()]);
  assert.ok(report.results.filter(({ id }) => id.startsWith('mcp.streamable-http.'))
    .every(({ status }) => status === 'not_verified'));
  assert.equal(await health.calls(), 0);
});

test('invalid HTTP input and saved state are rejected before any network request or mutation', async (t) => {
  const f = await fixture(t);
  const health = await mockHealth(f);
  let result = health.run({ action: 'record', observation: missingHttp() });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /start collection first/);
  result = health.run(start);
  assert.equal(result.status, 0, result.stderr);
  const before = await readFile(f.outputPath, 'utf8');
  const observations = [
    { ...http(), serverHealthCheck: 'passed' },
    { ...missingHttp(), serverHealthCheck: 'failed' },
    { ...http(), evidence: {} },
    { ...http(), evidence: false },
    { kind: 'mcp-streamable-http', server: 'http' },
    { ...http(), server: 'other' },
    { ...http(), kind: 'other' },
  ];
  for (const observation of observations) {
    result = health.run({ action: 'record', observation });
    assert.equal(result.status, 2, result.stderr);
    assert.equal(await readFile(f.outputPath, 'utf8'), before);
  }
  for (const content of ['{broken',
    JSON.stringify({ ...expected([]), observations: [http()] }),
    JSON.stringify({ ...expected([]), observations: [{ ...missingHttp(), serverHealthCheck: 'unknown' }] }),
    JSON.stringify({ ...expected([]), summary: { pass: 999 } })]) {
    await writeFile(f.outputPath, content);
    result = health.run({ action: 'record', observation: missingHttp() });
    assert.equal(result.status, 2, result.stderr);
    assert.equal(await readFile(f.outputPath, 'utf8'), content);
  }
  assert.equal(await health.calls(), 0);
});

test('start creates nested parents and replaces all previous evidence', async (t) => {
  const f = await fixture(t);
  f.success(start);
  assert.deepEqual(await f.read(), expected([]));
  f.record(skill());
  f.record(mcp());
  f.success(start);
  assert.deepEqual(await f.read(), expected([]));
  // Explicit start also recovers from a malformed old artifact.
  await writeFile(f.outputPath, '{broken');
  f.success(start);
  assert.deepEqual(await f.read(), expected([]));
});

test('distinct keys accumulate in deterministic order; repeated keys fully replace observations', async (t) => {
  const f = await fixture(t);
  f.success(start);
  f.record(mcp());
  f.record(skill('beta'));
  f.record(skill('alpha'));
  assert.deepEqual(await f.read(), expected([mcp(), skill('beta'), skill('alpha')]));
  f.record(skill('alpha', 'wrong-marker'));
  let report = await f.read();
  assert.equal(report.observations.length, 3);
  assert.equal(report.results.find(({ id }) => id === 'skills.discovery.immediate-children').status, 'fail');
  const replacement = mcp();
  replacement.evidence.env = {};
  replacement.evidence.argv = ['default'];
  replacement.evidence.resolvedData = null;
  replacement.evidence.dataWrite = null;
  f.record(replacement);
  report = await f.read();
  assert.deepEqual(report, expected([replacement, skill('beta'), skill('alpha', 'wrong-marker')]));
  assert.deepEqual(report.observations.find(({ kind }) => kind === 'mcp-stdio').evidence.env, {});
  assert.equal(report.results.find(({ id }) => id === 'mcp.stdio.env.plugin-root').status, 'fail');
  assert.equal(report.results.find(({ id }) => id === 'mcp.stdio.env.expansion').status, 'not_verified');
  assert.deepEqual(await readdir(join(f.directory, 'nested directory')), ['report with spaces.json']);
});

test('recovery observations have distinct recorder keys and repeated keys replace canonically', async (t) => {
  const f = await fixture(t);
  f.success(start);
  f.record(mcp());
  f.record(recoveryMcp());
  f.record(recoverySkill());
  let report = await f.read();
  assert.deepEqual(report.observations, [recoverySkill(), mcp(), recoveryMcp()]);
  assert.equal(report.results.find(({ id }) => id === 'skills.recovery.valid-skill-available').status, 'pass');
  assert.equal(report.results.find(({ id }) => id === 'mcp.stdio.recovery.valid-server-available').status, 'pass');

  f.record(recoverySkill('incorrect marker'));
  report = await f.read();
  assert.equal(report.observations.length, 3);
  assert.deepEqual(report.observations.find(({ skill }) => skill === 'conformance-recovery-valid'),
    recoverySkill('incorrect marker'));
  assert.deepEqual(report.observations.find(({ server }) => server === 'default'), mcp());
  assert.deepEqual(report.observations.find(({ server }) => server === 'recovery-valid'), recoveryMcp());
  assert.equal(report.results.find(({ id }) => id === 'skills.recovery.valid-skill-available').status, 'fail');
});

test('invalid server identities persist and replace under separate recorder keys', async (t) => {
  const f = await fixture(t);
  f.success(start);
  f.record(recoveryMcp());
  for (const [server] of invalidServerCases) f.record(invalidServerDiscovery(server, false));

  let report = await f.read();
  assert.deepEqual(report.observations, [...invalidServerCases.map(([server]) => invalidServerDiscovery(server, false)), recoveryMcp()]);
  for (const [, id] of invalidServerCases) assert.equal(report.results.find((item) => item.id === id).status, 'pass');

  const runtimes = invalidServerCases.map(([server], index) => invalidServerRuntime(server, '/recovery-plugin', index ? '/data-parent' : '/parent'));
  for (const runtime of runtimes) f.record(runtime);
  report = await f.read();
  assert.deepEqual(report.observations, [
    ...invalidServerCases.map(([server]) => invalidServerDiscovery(server, false)), recoveryMcp(), ...runtimes,
  ]);
  for (const [, id] of invalidServerCases) assert.equal(report.results.find((item) => item.id === id).status, 'fail');

  for (const [server, id] of invalidServerCases) {
    f.record(invalidServerDiscovery(server, true));
    f.record(invalidServerDiscovery(server, false));
    report = await f.read();
    assert.equal(report.results.find((item) => item.id === id).status, 'fail');
    assert.ok(report.observations.some(({ kind, server: observed }) => kind === 'mcp-stdio' && observed === server));
  }

  const replacementRuntime = invalidServerRuntime('recovery-unknown-field', '/recovery-plugin', '/recovery-plugin');
  f.record(replacementRuntime);
  report = await f.read();
  assert.deepEqual(report.observations.find(({ kind, server }) => kind === 'mcp-stdio' && server === 'recovery-unknown-field'), replacementRuntime);
  assert.equal(report.results.find((item) => item.id === 'mcp.stdio.config.unknown-field').status, 'fail');
});

test('symlink cwd recovery state replaces canonically and gates an absent target', async (t) => {
  const f = await fixture(t);
  f.success(start);
  const server = 'recovery-cwd-symlink-escape';
  const id = 'filesystem.containment.cwd-symlink-escape';
  f.record(invalidServerDiscovery(server, false));
  for (const [symlinkCwd, status] of [
    ['other', 'not_verified'], ['missing', 'pass'], [null, 'not_verified'], ['symlink', 'pass'],
  ]) {
    f.record(recoveryMcp(symlinkCwd));
    const report = await f.read();
    assert.equal(report.results.find((item) => item.id === id).status, status);
    assert.deepEqual(report.observations.find(({ server: observed }) => observed === 'recovery-valid'),
      recoveryMcp(symlinkCwd));
  }
  const oldRecovery = recoveryMcp();
  delete oldRecovery.evidence.symlinkCwd;
  f.record(oldRecovery);
  const oldReport = await f.read();
  assert.equal(oldReport.results.find((item) => item.id === id).status, 'not_verified');
  assert.deepEqual(oldReport.observations.find(({ server: observed }) => observed === 'recovery-valid'), oldRecovery);
});

test('invalid HTTP discovery and runtime records replace independently and use reporter health', async (t) => {
  const f = await fixture(t);
  const health = await mockHealth(f);
  assert.equal(health.run(start).status, 0);
  f.record(recoveryMcp());
  for (const [server] of invalidHttpServerCases) f.record(invalidServerDiscovery(server, false));
  const control = http();
  assert.equal(health.run({ action: 'record', observation: control }).status, 0);
  let calls = 1;
  let report = await f.read();
  for (const [, id] of invalidHttpServerCases) {
    assert.equal(report.results.find((item) => item.id === id).status, 'pass');
  }

  const [failedServer, failedId] = invalidHttpServerCases[0];
  assert.equal(health.run({ action: 'record', observation: invalidHttp(failedServer) }).status, 0);
  report = await f.read();
  assert.equal(await health.calls(), ++calls);
  assert.equal(report.results.find((item) => item.id === failedId).status, 'fail');
  for (const [, id] of invalidHttpServerCases.slice(1)) {
    assert.equal(report.results.find((item) => item.id === id).status, 'pass');
  }
  assert.equal(report.observations.find(({ kind, server }) =>
    kind === 'mcp-streamable-http' && server === failedServer).serverHealthCheck, 'passed');

  const exact = 'native refusal\n\n  scoped detail\t';
  await health.setResponse({ error: 'fixture unavailable after attempt' });
  assert.equal(health.run({ action: 'record', observation: invalidHttp(failedServer, {
    type: 'error', message: exact, classification: null,
  }) }).status, 0);
  report = await f.read();
  assert.equal(await health.calls(), ++calls);
  const saved = report.observations.find(({ kind, server }) =>
    kind === 'mcp-streamable-http' && server === failedServer);
  assert.deepEqual(saved, {
    ...invalidHttp(failedServer, { type: 'error', message: exact, classification: null }),
    serverHealthCheck: 'failed',
  });
  assert.equal(report.results.find((item) => item.id === failedId).status, 'not_verified');
  for (const [, id] of invalidHttpServerCases.slice(1)) {
    assert.equal(report.results.find((item) => item.id === id).status, 'pass');
  }

  assert.equal(health.run({ action: 'record', observation: invalidHttp(failedServer, null) }).status, 0);
  report = await f.read();
  assert.equal(await health.calls(), ++calls);
  assert.deepEqual(report.observations.find(({ kind, server }) =>
    kind === 'mcp-streamable-http' && server === failedServer), {
    ...invalidHttp(failedServer, null), serverHealthCheck: 'failed',
  });
  assert.equal(report.results.find((item) => item.id === failedId).status, 'not_verified');
  for (const [, id] of invalidHttpServerCases.slice(1)) {
    assert.equal(report.results.find((item) => item.id === id).status, 'pass');
  }
});

test('malformed invalid HTTP runtime records fail before health or report mutation', async (t) => {
  const f = await fixture(t);
  const health = await mockHealth(f);
  assert.equal(health.run(start).status, 0);
  const before = await readFile(f.outputPath, 'utf8');
  for (const [server] of invalidHttpServerCases) {
    for (const observation of [
      invalidHttp(server, { type: 'request', version: 2, pathname: '/', query: [], headers: { 'x-apc-fixture': null } }),
      invalidHttp(server, { type: 'request', version: 1, pathname: '/', query: [], headers: {} }),
      invalidHttp(server, { type: 'error', message: '', classification: null }),
    ]) {
      const result = health.run({ action: 'record', observation });
      assert.equal(result.status, 2, result.stderr);
      assert.equal(await readFile(f.outputPath, 'utf8'), before);
    }
  }
  assert.equal(await health.calls(), 0);
});

test('record preserves a cleanup warning while keeping successful writability passing', async (t) => {
  const f = await fixture(t);
  f.success(start);
  const observation = mcp();
  observation.evidence.dataWrite.cleanupError = { code: 'EBUSY', message: 'resource busy' };
  f.record(observation);

  const report = await f.read();
  const writable = report.results.find(({ id }) => id === 'filesystem.data.writable');
  assert.equal(writable.status, 'pass');
  assert.equal(typeof writable.warning, 'string');
  assert.match(writable.warning, /\/data\/\.agent-plugins-conformance-write-test/);
  assert.match(writable.warning, /EBUSY/);
  assert.match(writable.warning, /resource busy/);
  assert.deepEqual(report.observations, [observation]);
});

test('invalid requests fail without changing an existing report', async (t) => {
  const f = await fixture(t);
  f.success(start);
  const before = await readFile(f.outputPath, 'utf8');
  const requests = [
    '', '{', 'null', '[]', {}, { action: 'other' },
    { action: 'start', extra: true },
    { action: 'record' }, { action: 'record', observation: skill(), extra: true },
    { action: 'record', observation: { ...skill(), arbitrary: true } },
    { action: 'record', observation: { kind: 'mcp-stdio', server: 'default', evidence: {} } },
  ];
  for (const request of requests) {
    const result = f.run(request);
    assert.equal(result.status, 2, `${JSON.stringify(request).slice(0, 120)}: ${result.stderr}`);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /^Report error: /);
    assert.equal(await readFile(f.outputPath, 'utf8'), before);
  }
});

test('reporter requires exactly one absolute path and a previous start for record', async (t) => {
  const f = await fixture(t);
  for (const args of [[], ['report.json'], [f.outputPath, 'extra']]) {
    const result = f.run(start, args);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /Usage:/);
    assert.equal(result.stdout, '');
  }
  const result = f.run({ action: 'record', observation: skill() });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /start collection first/);
  assert.deepEqual(await readdir(f.directory), []);
});

test('malformed saved state is rejected even when its bad observation would be replaced', async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.directory, 'nested directory'));
  const malformed = [
    '{', 'null', JSON.stringify({ schemaVersion: 1, observations: [] }),
    JSON.stringify({ ...expected([]), summary: { pass: 999, fail: 0, not_verified: 0, total: 999 } }),
    JSON.stringify({ ...expected([skill()]), observations: [{ ...skill(), unexpected: true }] }),
  ];
  for (const content of malformed) {
    await writeFile(f.outputPath, content);
    const result = f.run({ action: 'record', observation: skill() });
    assert.equal(result.status, 2, result.stderr);
    assert.equal(result.stdout, '');
    assert.equal(await readFile(f.outputPath, 'utf8'), content);
  }
});

test('write errors report failure and remove sibling temporary files', async (t) => {
  const f = await fixture(t);
  await mkdir(f.outputPath, { recursive: true });
  const result = f.run(start);
  assert.equal(result.status, 2);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /Report error:/);
  assert.deepEqual(await readdir(join(f.directory, 'nested directory')), ['report with spaces.json']);
  const blocker = join(f.directory, 'file');
  await writeFile(blocker, 'keep');
  const blocked = f.run(start, [join(blocker, 'report.json')]);
  assert.equal(blocked.status, 2);
  assert.equal(await readFile(blocker, 'utf8'), 'keep');
});

test('copied primary plugin records and summarizes without sibling plugins or runtime dependencies', async (t) => {
  const f = await fixture(t);
  const copiedPlugin = join(f.directory, 'copied plugin');
  await cp(new URL('../plugins/agent-plugins-conformance', import.meta.url), copiedPlugin, { recursive: true });
  assert.equal((await readdir(copiedPlugin)).includes('node_modules'), false);
  const copiedScript = join(copiedPlugin, 'skills/run-conformance/scripts/report.mjs');
  f.success(start, copiedScript);
  f.success({ action: 'record', observation: skill('alpha') }, copiedScript);
  f.success({ action: 'record', observation: skill('beta') }, copiedScript);
  f.success({ action: 'record', observation: discovery() }, copiedScript);
  const report = await f.read();
  assert.deepEqual(report, expected([skill('alpha'), skill('beta'), discovery()]));
  assert.equal(report.results.find(({ id }) => id === 'skills.discovery.immediate-children').status, 'pass');
  const summary = spawnSync(process.execPath, [join(copiedPlugin, 'skills/run-conformance/scripts/summarize.mjs'), f.outputPath], {
    cwd: f.directory, encoding: 'utf8', timeout: 10_000,
  });
  assert.equal(summary.status, 0, summary.stderr);
  assert.equal(summary.stdout.trimEnd(), formatReport(report));

  const health = await mockHealth(f);
  const result = health.run({ action: 'record', observation: missingHttp() }, copiedScript);
  assert.equal(result.status, 0, result.stderr);
  const withHttp = await f.read();
  assert.deepEqual(withHttp, expected([skill('alpha'), skill('beta'), discovery(), { ...missingHttp(), serverHealthCheck: 'passed' }]));
  // Reading saved evidence must remain deterministic after fixture state changes.
  await health.setResponse({ error: 'fixture stopped after collection' });
  const savedSummary = health.run('', join(copiedPlugin, 'skills/run-conformance/scripts/summarize.mjs'));
  assert.equal(savedSummary.status, 0, savedSummary.stderr);
  assert.equal(savedSummary.stdout.trimEnd(), formatReport(withHttp));
  assert.equal(await health.calls(), 1);
  assert.deepEqual(await f.read(), withHttp);
});

test('malformed MCP skill records and replaces independently and appears in the saved summary', async (t) => {
  const f = await fixture(t);
  f.success(start);
  f.record(recoverySkill());
  f.record(recoveryMcp());
  const baseline = await f.read();
  const id = 'skills.recovery.invalid-mcp-document';
  for (const [marker, status] of [['APC_INVALID_MCP_VALID_V1', 'pass'], ['incorrect marker', 'fail']]) {
    const observation = { kind: 'skill', skill: 'conformance-invalid-mcp-valid', marker };
    f.record(observation);
    const report = await f.read();
    assert.deepEqual(report, expected([recoverySkill(), recoveryMcp(), observation]));
    assert.equal(report.observations.length, 3);
    assert.equal(report.results.find((item) => item.id === id).status, status);
    assert.deepEqual(report.results.filter((item) => item.id !== id), baseline.results.filter((item) => item.id !== id));
    const summary = spawnSync(process.execPath, [fileURLToPath(new URL('../plugins/agent-plugins-conformance/skills/run-conformance/scripts/summarize.mjs', import.meta.url)), f.outputPath], { encoding: 'utf8' });
    assert.equal(summary.status, 0, summary.stderr);
    assert.equal(summary.stdout.trimEnd(), formatReport(report));
    if (status === 'fail') assert.ok(summary.stdout.includes(id));
  }
});


test('nested discovery records replace in both directions and preserve unrelated observations', async (t) => {
  const f = await fixture(t);
  f.success(start);
  f.record(mcp());
  f.record(recoverySkill());
  f.record(skill('alpha'));
  f.record(skill('beta'));
  const id = 'skills.discovery.immediate-children';
  const baseline = await f.read();
  assert.equal(baseline.results.find((item) => item.id === id).status, 'not_verified');
  for (const advertised of [false, true, false]) {
    f.record(discovery(advertised));
    const report = await f.read();
    assert.deepEqual(report, expected([mcp(), recoverySkill(), skill('alpha'), skill('beta'), discovery(advertised)]));
    assert.equal(report.results.find((item) => item.id === id).status, advertised ? 'fail' : 'pass');
    assert.deepEqual(report.results.filter((item) => item.id !== id), baseline.results.filter((item) => item.id !== id));
  }

  f.success(start);
  f.record(discovery(false));
  assert.equal((await f.read()).results.find((item) => item.id === id).status, 'not_verified');
  f.record(discovery(true));
  assert.equal((await f.read()).results.find((item) => item.id === id).status, 'fail');
  f.record(skill('alpha'));
  f.record(skill('beta'));
  assert.equal((await f.read()).results.find((item) => item.id === id).status, 'fail');
  f.record(discovery(false));
  assert.equal((await f.read()).results.find((item) => item.id === id).status, 'pass');
});
