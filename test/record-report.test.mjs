import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { formatReport } from '../plugins/agent-plugins-conformance/src/report-format.mjs';
import { buildReport } from '../plugins/agent-plugins-conformance/src/report.mjs';

const script = fileURLToPath(new URL('../plugins/agent-plugins-conformance/skills/run-conformance/scripts/report.mjs', import.meta.url));
const start = { action: 'start' };
const skill = (name = 'alpha', marker = `APC_${name.toUpperCase()}_V1`) => ({ kind: 'skill', skill: `conformance-${name}`, marker });
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
const expected = (observations) => buildReport({ schemaVersion: 1, observations });

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'record-report-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const outputPath = join(directory, 'nested directory', 'report with spaces.json');
  const run = (message, args = [outputPath], reporter = script) => spawnSync(process.execPath, [reporter, ...args], {
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
  const report = await f.read();
  assert.deepEqual(report, expected([skill('alpha'), skill('beta')]));
  assert.equal(report.results.find(({ id }) => id === 'skills.discovery.immediate-children').status, 'pass');
  const summary = spawnSync(process.execPath, [join(copiedPlugin, 'skills/run-conformance/scripts/summarize.mjs'), f.outputPath], {
    cwd: f.directory, encoding: 'utf8', timeout: 10_000,
  });
  assert.equal(summary.status, 0, summary.stderr);
  assert.equal(summary.stdout.trimEnd(), formatReport(report));
});
