import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { buildReport, CASE_IDS } from '../plugins/agent-plugins-conformance-core/src/report.mjs';

function input(root = '/fixture/plugin', data = '/state/plugin') {
  const flavor = root.startsWith('/') ? path.posix : path.win32;
  return {
    schemaVersion: 1, client: { name: 'Test client', version: '1.0' },
    observations: [
      ...['guide', 'alpha', 'beta'].map((name) => ({ kind: 'skill', skill: `conformance-${name}`, marker: `APC_${name.toUpperCase()}_V1` })),
      ...['default', 'relative', 'root', 'data'].map((server) => ({
        kind: 'mcp-stdio', server,
        evidence: {
          version: 1, server, root, resolvedData: data,
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

test('complete valid evidence passes every case and preserves canonical evidence', () => {
  const value = input();
  const report = buildReport(value);
  assert.deepEqual(report.summary, { pass: 14, fail: 0, not_verified: 0, total: 14 });
  assert.deepEqual(report.results.map(({ id }) => id), CASE_IDS);
  assert.equal(report.specVersion, '1.0.0');
  assert.deepEqual(result(report, 'mcp.stdio.env.plugin-root').specSections, ['9.1']);
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

test('missing observations remain unverified and every result identifies its hierarchy and label', () => {
  const value = input();
  value.observations = [];
  const report = buildReport(value);
  assert.deepEqual(report.summary, { pass: 0, fail: 0, not_verified: 14, total: 14 });
  const skills = report.results.filter(({ id }) => id.startsWith('skills.'));
  const mcp = report.results.filter(({ id }) => id.startsWith('mcp.'));
  assert.deepEqual(skills.map(({ id }) => id), ['skills.discovery.immediate-children']);
  assert.equal(mcp.length, 13);
  assert.ok(mcp.some(({ id }) => id === 'mcp.stdio.env.plugin-root'));
  for (const result of report.results) {
    assert.ok(result.label.length > 0);
  }
});

test('missing default environment fails independent checks and leaves dependent expansion unverified', () => {
  const value = input();
  runtime(value).env = {};
  const report = buildReport(value);
  for (const id of ['mcp.stdio.env.plugin-root', 'mcp.stdio.env.plugin-data-absolute', 'mcp.stdio.env.configured-value']) assert.equal(result(report, id).status, 'fail');
  for (const id of ['mcp.stdio.args.preservation-and-expansion', 'mcp.stdio.env.expansion']) assert.equal(result(report, id).status, 'not_verified');
  assert.equal(result(report, 'mcp.stdio.tool-availability.cwd-omitted').status, 'pass');
  assert.equal(result(report, 'mcp.stdio.cwd.plugin-data').status, 'pass');
});

test('data cwd uses its own resolved evidence and unavailable resolution leaves that comparison unverified', () => {
  const value = input();
  runtime(value, 'data').env.PLUGIN_DATA = '/separate/data';
  runtime(value, 'data').resolvedData = '/separate/data';
  runtime(value, 'data').cwd = '/separate/data';
  assert.equal(result(buildReport(value), 'mcp.stdio.cwd.plugin-data').status, 'pass');
  delete runtime(value, 'data').env.PLUGIN_DATA;
  runtime(value, 'data').resolvedData = null;
  assert.equal(result(buildReport(value), 'mcp.stdio.cwd.plugin-data').status, 'not_verified');
});

test('data cwd follows resolved aliases while expansion preserves the original environment path', () => {
  const value = input('/fixture/plugin', '/tmp/data');
  for (const observation of value.observations.filter(({ kind }) => kind === 'mcp-stdio')) {
    observation.evidence.resolvedData = '/private/tmp/data';
  }
  runtime(value, 'data').cwd = '/private/tmp/data';
  const report = buildReport(value);
  assert.equal(report.summary.pass, 14);
  assert.equal(report.observations[6].evidence.resolvedData, '/private/tmp/data');
  assert.equal(report.observations[3].evidence.env.PLUGIN_DATA, '/tmp/data');
  runtime(value, 'data').resolvedData = null;
  assert.equal(result(buildReport(value), 'mcp.stdio.cwd.plugin-data').status, 'not_verified');
  assert.equal(result(buildReport(value), 'mcp.stdio.env.plugin-data-absolute').status, 'pass');
});

test('wrong values fail mechanically with expected and observed diagnostics', () => {
  const changes = [
    ['mcp.stdio.env.plugin-root', (value) => { runtime(value).env.PLUGIN_ROOT = '/wrong'; }],
    ['mcp.stdio.env.plugin-data-absolute', (value) => { runtime(value).env.PLUGIN_DATA = 'relative'; }],
    ['mcp.stdio.env.configured-value', (value) => { delete runtime(value).env.APC_VALUE; }],
    ['mcp.stdio.args.preservation-and-expansion', (value) => { runtime(value).argv.splice(2, 1); }],
    ['mcp.stdio.env.expansion', (value) => { runtime(value).env.APC_LITERAL = 'expanded'; }],
    ['mcp.stdio.cwd.plugin-relative', (value) => { runtime(value, 'relative').cwd = '/wrong'; }],
    ['skills.discovery.immediate-children', (value) => { value.observations[1].marker = 'wrong'; }],
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
    assert.equal(result(buildReport(value), 'mcp.stdio.args.preservation-and-expansion').status, 'fail');
  }
});

test('path comparisons follow producing OS and normalize path components', () => {
  for (const [root, data] of [['/plugin with spaces', '/data with spaces'], ['C:\\plugin', 'D:\\data'], ['\\\\host\\share\\plugin', '\\\\host\\share\\data']]) {
    const value = input(root, data);
    assert.equal(buildReport(value).summary.pass, 14);
    const flavor = root.startsWith('/') ? path.posix : path.win32;
    runtime(value).cwd = `${root}${flavor.sep}sub${flavor.sep}..`;
    assert.equal(result(buildReport(value), 'mcp.stdio.cwd.omitted').status, 'pass');
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
    assert.equal(result(buildReport(value), 'mcp.stdio.env.plugin-data-absolute').status, expected);
  }
});

test('unknown keys, duplicate observations, identities, versions and types are rejected', () => {
  const invalid = [
    [(v) => { v.status = 'pass'; }, /input.status: unknown field/],
    [(v) => { v.observations[4] = v.observations[3]; }, /duplicate mcp-stdio/],
    [(v) => { v.observations[1] = v.observations[0]; }, /duplicate skill/],
    [(v) => { runtime(v).env.SECRET = 'not allowed'; }, /unknown field/],
    [(v) => { runtime(v).server = 'other'; }, /must match observation.server/],
    [(v) => { v.observations[3].server = 'other'; }, /expected one of/],
    [(v) => { runtime(v).version = 2; }, /expected 1/],
    [(v) => { runtime(v).extra = true; }, /extra: unknown field/],
    [(v) => { runtime(v).root = 'relative'; }, /absolute/],
    [(v) => { delete runtime(v).resolvedData; }, /resolvedData: required/],
    [(v) => { runtime(v).resolvedData = 'relative'; }, /absolute/],
    [(v) => { runtime(v).resolvedData = 1; }, /resolvedData: expected/],
    [(v) => { runtime(v).argv = [1]; }, /expected a string/],
    [(v) => { runtime(v).env.APC_VALUE = null; }, /expected a string/],
    [(v) => { v.observations[0].evidence = {}; }, /unknown field/],
    [(v) => { v.observations[3].kind = 'unknown'; }, /expected one of: mcp-stdio, skill/],
  ];
  for (const [change, pattern] of invalid) { const value = input(); change(value); assert.throws(() => buildReport(value), pattern); }
});

test('failure diagnostics preserve value boundaries and escape control characters', () => {
  const value = input();
  runtime(value).env.APC_VALUE = 'wrong\nvalue';
  delete runtime(value).env.APC_EXPANSION;
  runtime(value).env.APC_LITERAL = 'changed';
  const report = buildReport(value);
  assert.equal(result(report, 'mcp.stdio.env.configured-value').detail,
    'APC_VALUE: expected "fixture value with spaces"; observed "wrong\\nvalue".');
  const expansion = result(report, 'mcp.stdio.env.expansion').detail;
  assert.match(expansion, /APC_EXPANSION: expected .*; observed missing/);
  assert.match(expansion, /APC_LITERAL: expected .*; observed "changed"/);
  assert.ok(!expansion.includes('undefined'));
});

test('skill discovery aggregate requires all immediate child skills and preserves partial observations', () => {
  for (let included = 0; included < 8; included += 1) {
    const value = input();
    value.observations = value.observations.filter(({ kind }, index) =>
      kind !== 'skill' || (included & (1 << index)));
    const report = buildReport(value);
    const discovery = result(report, 'skills.discovery.immediate-children');
    assert.equal(discovery.status, included === 7 ? 'pass' : 'not_verified');
    assert.deepEqual(report.observations, value.observations);
    for (const [index, skill] of ['guide', 'alpha', 'beta'].entries()) {
      if (!(included & (1 << index))) assert.ok(discovery.detail.includes(`conformance-${skill}`));
    }
    assert.equal(report.summary.total, 14);
    assert.equal(report.summary.fail, 0);
    assert.equal(report.summary.not_verified, included === 7 ? 0 : 1);
  }
});

test('incorrect skill markers fail the aggregate even when another skill is missing', () => {
  for (const missing of [false, true]) {
    const value = input();
    value.observations[0].marker = 'wrong guide';
    value.observations[1].marker = 'wrong alpha';
    if (missing) value.observations.splice(2, 1);
    const report = buildReport(value);
    const discovery = result(report, 'skills.discovery.immediate-children');
    assert.equal(discovery.status, 'fail');
    assert.match(discovery.detail, /conformance-guide: expected "APC_GUIDE_V1"; observed "wrong guide"/);
    assert.match(discovery.detail, /conformance-alpha: expected "APC_ALPHA_V1"; observed "wrong alpha"/);
    assert.equal(discovery.detail.includes('Missing skill observations: conformance-beta.'), missing);
    assert.deepEqual(report.summary, { pass: 13, fail: 1, not_verified: 0, total: 14 });
    value.observations.reverse();
    assert.equal(JSON.stringify(buildReport(value)), JSON.stringify(report));
  }
});
