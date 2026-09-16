import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildReport, formatReport, CASE_IDS } from '../plugins/core/src/report.mjs';

function input(root = '/fixture/plugin', data = '/state/plugin') {
  const flavor = root.startsWith('/') ? path.posix : path.win32;
  return {
    schemaVersion: 1, runId: 'test-run', client: { name: 'Test client', version: '1.0' },
    collection: { kind: 'client', route: 'native plugin installation' },
    observations: [
      ...['guide', 'alpha', 'beta'].map((name) => ({ kind: 'skill', skill: `conformance-${name}`, marker: `APC_${name.toUpperCase()}_V1` })),
      ...['default', 'relative', 'root', 'data'].map((server) => ({
        kind: 'runtime', server,
        evidence: {
          version: 1, runId: 'test-run', server, root, resolvedData: data,
          cwd: server === 'default' ? root : server === 'data' ? data : flavor.join(root, 'probe-workdir'),
          argv: ['default', 'arg with spaces', '', root, data, '${APC_UNKNOWN}', '$APC_VALUE', '${PLUGIN_ROOT_SUFFIX}'],
          env: { PLUGIN_ROOT: root, PLUGIN_DATA: data, APC_VALUE: 'fixture value with spaces',
            APC_EXPANSION: `${root}|${data}|${root}`, APC_LITERAL: '${APC_UNKNOWN}|$APC_VALUE|${PLUGIN_ROOT_SUFFIX}' },
        },
      })),
    ],
  };
}
const runtime = (value, server = 'default') => value.observations.find((observation) => observation.server === server).evidence;
const result = (report, id) => report.results.find((item) => item.id === id);

test('complete valid evidence passes every case and preserves canonical bounded evidence', () => {
  const value = input();
  const report = buildReport(value);
  assert.deepEqual(report.summary, { pass: 16, fail: 0, not_verified: 0, total: 16 });
  assert.deepEqual(report.results.map(({ id }) => id), CASE_IDS);
  assert.equal(report.specVersion, '1.0.0');
  assert.deepEqual(result(report, 'stdio.root').specSections, ['9.1']);
  assert.deepEqual(report.observations, value.observations);
  runtime(value).argv.push('after report');
  assert.equal(report.observations[3].evidence.argv.length, 8);
});

test('report bytes are deterministic across observation and property orders', () => {
  const first = input();
  const second = input();
  second.observations.reverse();
  runtime(second).env = Object.fromEntries(Object.entries(runtime(second).env).reverse());
  assert.equal(JSON.stringify(buildReport(first)), JSON.stringify(buildReport(second)));
});

test('missing observations remain unverified and every result identifies its category and label', () => {
  const value = input();
  value.observations = [];
  const report = buildReport(value);
  assert.deepEqual(report.summary, { pass: 0, fail: 0, not_verified: 16, total: 16 });
  const skills = report.results.filter(({ category }) => category === 'skills');
  const mcp = report.results.filter(({ category }) => category === 'mcp');
  assert.deepEqual(skills.map(({ id }) => id), ['skills.guide', 'skills.alpha', 'skills.beta']);
  assert.equal(mcp.length, 13);
  assert.ok(mcp.some(({ id }) => id === 'stdio.root'));
  for (const result of report.results) assert.ok(result.label.length > 0);
  assert.equal(Object.hasOwn(report, 'expectedPasses'), false);
  assert.equal(Object.hasOwn(report, 'unmetExpectations'), false);
});

test('missing default environment fails independent checks and leaves dependent expansion unverified', () => {
  const value = input();
  runtime(value).env = {};
  const report = buildReport(value);
  for (const id of ['stdio.root', 'stdio.data', 'stdio.env']) assert.equal(result(report, id).status, 'fail');
  for (const id of ['stdio.args', 'stdio.expansion']) assert.equal(result(report, id).status, 'not_verified');
  assert.equal(result(report, 'mcp.default.tool').status, 'pass');
  assert.equal(result(report, 'mcp.data.cwd').status, 'pass');
});

test('data cwd uses its own resolved evidence and unavailable resolution leaves that comparison unverified', () => {
  const value = input();
  runtime(value, 'data').env.PLUGIN_DATA = '/separate/data';
  runtime(value, 'data').resolvedData = '/separate/data';
  runtime(value, 'data').cwd = '/separate/data';
  assert.equal(result(buildReport(value), 'mcp.data.cwd').status, 'pass');
  delete runtime(value, 'data').env.PLUGIN_DATA;
  runtime(value, 'data').resolvedData = null;
  assert.equal(result(buildReport(value), 'mcp.data.cwd').status, 'not_verified');
});

test('data cwd follows resolved aliases while expansion preserves the original environment path', () => {
  const value = input('/fixture/plugin', '/tmp/data');
  for (const observation of value.observations.filter(({ kind }) => kind === 'runtime')) {
    observation.evidence.resolvedData = '/private/tmp/data';
  }
  runtime(value, 'data').cwd = '/private/tmp/data';
  const report = buildReport(value);
  assert.equal(report.summary.pass, 16);
  assert.equal(report.observations[6].evidence.resolvedData, '/private/tmp/data');
  assert.equal(report.observations[3].evidence.env.PLUGIN_DATA, '/tmp/data');
  runtime(value, 'data').resolvedData = null;
  assert.equal(result(buildReport(value), 'mcp.data.cwd').status, 'not_verified');
  assert.equal(result(buildReport(value), 'stdio.data').status, 'pass');
});

test('wrong values fail mechanically with expected and observed diagnostics', () => {
  const changes = [
    ['stdio.root', (value) => { runtime(value).env.PLUGIN_ROOT = '/wrong'; }],
    ['stdio.data', (value) => { runtime(value).env.PLUGIN_DATA = 'relative'; }],
    ['stdio.env', (value) => { delete runtime(value).env.APC_VALUE; }],
    ['stdio.args', (value) => { runtime(value).argv.splice(2, 1); }],
    ['stdio.expansion', (value) => { runtime(value).env.APC_LITERAL = 'expanded'; }],
    ['mcp.relative.cwd', (value) => { runtime(value, 'relative').cwd = '/wrong'; }],
    ['skills.alpha', (value) => { value.observations[1].marker = 'wrong'; }],
  ];
  for (const [id, change] of changes) {
    const value = input(); change(value);
    const report = buildReport(value);
    assert.equal(result(report, id).status, 'fail', id);
    assert.match(result(report, id).detail, /expected .*; observed /, id);
  }
});

test('arguments preserve empty values, literal placeholders, spaces, and exact order', () => {
  for (const change of [
    (args) => args.reverse(),
    (args) => args.splice(1, 1, 'arg', 'with', 'spaces'),
    (args) => { args[5] = ''; },
    (args) => args.push('extra'),
  ]) {
    const value = input(); change(runtime(value).argv);
    assert.equal(result(buildReport(value), 'stdio.args').status, 'fail');
  }
});

test('path comparisons follow producing OS and normalize path components', () => {
  for (const [root, data] of [['/plugin with spaces', '/data with spaces'], ['C:\\plugin', 'D:\\data'], ['\\\\host\\share\\plugin', '\\\\host\\share\\data']]) {
    const value = input(root, data);
    assert.equal(buildReport(value).summary.pass, 16);
    const flavor = root.startsWith('/') ? path.posix : path.win32;
    runtime(value).cwd = `${root}${flavor.sep}sub${flavor.sep}..`;
    assert.equal(result(buildReport(value), 'mcp.default.cwd').status, 'pass');
  }
});

test('data environment must be absolute under the producing operating system path rules', () => {
  for (const [root, data, expected] of [
    ['/plugin', 'C:\\data', 'fail'],
    ['C:\\plugin', '/data', 'pass'],
    ['C:\\plugin', '//server/share/data', 'pass'],
    ['C:\\plugin', 'C:data', 'fail'],
  ]) {
    const value = input(root);
    runtime(value).env.PLUGIN_DATA = data;
    assert.equal(result(buildReport(value), 'stdio.data').status, expected);
  }
});

test('unknown keys, duplicate observations, identities, versions, types and oversized values are rejected', () => {
  const invalid = [
    [(v) => { v.status = 'pass'; }, /input.status: unknown field/],
    [(v) => { v.expectedPasses = []; }, /input.expectedPasses: unknown field/],
    [(v) => { v.unmetExpectations = []; }, /input.unmetExpectations: unknown field/],
    [(v) => { v.observations[4] = v.observations[3]; }, /duplicate runtime/],
    [(v) => { v.observations[1] = v.observations[0]; }, /duplicate skill/],
    [(v) => { runtime(v).env.SECRET = 'not allowed'; }, /unknown field/],
    [(v) => { runtime(v).server = 'other'; }, /must match observation.server/],
    [(v) => { v.observations[3].server = 'other'; }, /expected one of/],
    [(v) => { runtime(v).version = 2; }, /expected 1/],
    [(v) => { runtime(v).runId = 'stale-run'; }, /must match input.runId/],
    [(v) => { runtime(v).root = 'relative'; }, /absolute/],
    [(v) => { delete runtime(v).resolvedData; }, /resolvedData: required/],
    [(v) => { runtime(v).resolvedData = 'relative'; }, /absolute/],
    [(v) => { runtime(v).resolvedData = 1; }, /resolvedData: expected/],
    [(v) => { runtime(v).argv = [1]; }, /expected a string/],
    [(v) => { runtime(v).env.APC_VALUE = null; }, /expected a string/],
    [(v) => { v.client.name = 'a'.repeat(201); }, /at most 200/],
    [(v) => { v.runId = 'x'.repeat(101); }, /at most 100/],
    [(v) => { v.collection.kind = 'certified'; }, /expected one of/],
    [(v) => { v.observations[0].evidence = {}; }, /unknown field/],
  ];
  for (const [change, pattern] of invalid) { const value = input(); change(value); assert.throws(() => buildReport(value), pattern); }
});

test('oversized total input is rejected even if individual values fit bounds', () => {
  const value = input();
  for (const observation of value.observations.filter(({ kind }) => kind === 'runtime')) {
    observation.evidence.argv = Array(32).fill('a'.repeat(4096));
  }
  assert.throws(() => buildReport(value), /exceeds 262144 bytes/);
});

test('failure diagnostics preserve value boundaries and escape control characters', () => {
  const value = input();
  runtime(value).env.APC_VALUE = 'wrong\nvalue';
  delete runtime(value).env.APC_EXPANSION;
  runtime(value).env.APC_LITERAL = 'changed';
  const report = buildReport(value);
  assert.equal(result(report, 'stdio.env').detail,
    'APC_VALUE: expected "fixture value with spaces"; observed "wrong\\nvalue".');
  const expansion = result(report, 'stdio.expansion').detail;
  assert.match(expansion, /APC_EXPANSION: expected .*; observed missing/);
  assert.match(expansion, /APC_LITERAL: expected .*; observed "changed"/);
  assert.ok(!expansion.includes('undefined'));
});

test('CLI succeeds for evaluated outcomes and reserves nonzero exit for report errors', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'apc-report-test-'));
  try {
    const filename = path.join(directory, 'observations.json');
    const cli = fileURLToPath(new URL('../plugins/core/src/report-cli.mjs', import.meta.url));
    const run = (...args) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
    const value = input();
    await writeFile(filename, JSON.stringify(value));
    const json = run(filename, '--json');
    assert.equal(json.status, 0, json.stderr);
    assert.deepEqual(JSON.parse(json.stdout), buildReport(value));
    assert.equal(run(filename).stdout.trim(), formatReport(buildReport(value)));
    runtime(value).argv = [];
    await writeFile(filename, JSON.stringify(value));
    const failed = run(filename, '--json');
    assert.equal(failed.status, 0, failed.stderr);
    assert.ok(JSON.parse(failed.stdout).summary.fail > 0);
    assert.equal(run(filename).status, 0);
    value.observations = [];
    await writeFile(filename, JSON.stringify(value));
    const missing = run(filename, '--json');
    assert.equal(missing.status, 0, missing.stderr);
    assert.equal(JSON.parse(missing.stdout).summary.not_verified, 16);
    assert.equal(run(filename).status, 0);
    await writeFile(filename, JSON.stringify({ ...value, observations: 'invalid' }));
    assert.equal(run(filename, '--json').status, 2);
    await writeFile(filename, '{broken');
    assert.equal(run(filename).status, 2);
    assert.equal(run(filename, '--unknown').status, 2);
    assert.match(run().stderr, /Usage:/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
