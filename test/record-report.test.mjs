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
const recoveryMcp = () => ({
  kind: 'mcp-stdio', server: 'recovery-valid', evidence: { version: 1, server: 'recovery-valid', resolvedData: '/recovery-data' },
});
const cwdEscapeRuntime = (root = '/recovery-plugin', cwd = '/parent') => ({
  kind: 'mcp-stdio', server: 'recovery-cwd-escape',
  evidence: { version: 1, server: 'recovery-cwd-escape', root, cwd },
});
const cwdEscapeDiscovery = (advertised = false) => ({
  kind: 'mcp-discovery', server: 'recovery-cwd-escape', advertised,
});
const expected = (observations) => buildReport({ schemaVersion: 1, observations });
const http = () => ({
  kind: 'mcp-streamable-http', server: 'http', evidence: {
    type: 'request', version: 1, pathname: '/conformance/mcp', query: [['value', '$APC_HTTP_VALUE']],
    headers: { 'x-apc-fixture': '${PLUGIN_ROOT}|${PLUGIN_DATA}|fixture value with spaces' },
  },
});
const missingHttp = () => ({ kind: 'mcp-streamable-http', server: 'http', evidence: null });
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

test('cwd escape discovery and runtime persist under separate recorder keys', async (t) => {
  const f = await fixture(t);
  const id = 'mcp.stdio.cwd.plugin-relative-escape';
  f.success(start);
  f.record(recoveryMcp());
  f.record(cwdEscapeDiscovery(false));

  let report = await f.read();
  assert.deepEqual(report, expected([recoveryMcp(), cwdEscapeDiscovery(false)]));
  assert.deepEqual(report.observations, [cwdEscapeDiscovery(false), recoveryMcp()]);
  assert.equal(report.results.find((item) => item.id === id).status, 'pass');

  const firstRuntime = cwdEscapeRuntime();
  f.record(firstRuntime);
  report = await f.read();
  assert.deepEqual(report.observations, [cwdEscapeDiscovery(false), recoveryMcp(), firstRuntime]);
  assert.equal(report.results.find((item) => item.id === id).status, 'fail');

  for (const advertised of [true, false]) {
    f.record(cwdEscapeDiscovery(advertised));
    report = await f.read();
    assert.deepEqual(report.observations, [cwdEscapeDiscovery(advertised), recoveryMcp(), firstRuntime]);
    assert.equal(report.results.find((item) => item.id === id).status, 'fail');
  }

  const replacementRuntime = cwdEscapeRuntime('/recovery-plugin', '/recovery-plugin');
  f.record(replacementRuntime);
  report = await f.read();
  assert.deepEqual(report.observations, [cwdEscapeDiscovery(false), recoveryMcp(), replacementRuntime]);
  assert.equal(report.results.find((item) => item.id === id).status, 'fail');
});

test('record preserves a cleanup warning while keeping successful writability passing', async (t) => {
  const f = await fixture(t);
  f.success(start);
  const observation = mcp();
  observation.evidence.dataWrite.cleanupError = { code: 'EBUSY', message: 'resource busy' };
  f.record(observation);

  const report = await f.read();
  const writable = report.results.find(({ id }) => id === 'mcp.stdio.data.writable');
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
