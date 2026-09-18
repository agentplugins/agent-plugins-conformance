import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { buildReport, CASE_IDS } from '../plugins/agent-plugins-conformance/src/report.mjs';

function input(root = '/fixture/plugin', data = '/state/plugin') {
  const flavor = root.startsWith('/') ? path.posix : path.win32;
  return {
    schemaVersion: 1,
    observations: [
      ...['alpha', 'beta'].map((name) => ({ kind: 'skill', skill: `conformance-${name}`, marker: `APC_${name.toUpperCase()}_V1` })),
      ...['default', 'relative', 'root', 'data'].map((server) => ({
        kind: 'mcp-stdio', server,
        evidence: {
          version: 1, server, root, resolvedData: data,
          ...(server === 'default' ? { dataWrite: { path: flavor.join(data, '.agent-plugins-conformance-write-test'), error: null, cleanupError: null } } : {}),
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
const recoveryObservations = () => [
  { kind: 'skill', skill: 'conformance-recovery-valid', marker: 'APC_RECOVERY_VALID_V1' },
  {
    kind: 'mcp-stdio', server: 'recovery-valid',
    evidence: { version: 1, server: 'recovery-valid', resolvedData: '/state/recovery' },
  },
];

test('complete core evidence passes every core case and preserves canonical evidence', () => {
  const value = input();
  const report = buildReport(value);
  assert.deepEqual(report.summary, { pass: 16, fail: 0, not_verified: 3, total: 19 });
  assert.deepEqual(report.results.map(({ id }) => id), CASE_IDS);
  assert.equal(report.specVersion, '1.0.0');
  assert.deepEqual(result(report, 'mcp.stdio.env.plugin-root').specSections, ['9.1']);
  assert.deepEqual(report.observations, value.observations);
  runtime(value).argv.push('after report');
  runtime(value).dataWrite.cleanupError = { code: 'LATE', message: 'after report' };
  assert.equal(report.observations[2].evidence.argv.length, 8);
  assert.equal(report.observations[2].evidence.dataWrite.cleanupError, null);
});

test('recovery witnesses extend the canonical report without changing core-only results', () => {
  const coreOnly = buildReport(input());
  assert.deepEqual(coreOnly.summary, { pass: 16, fail: 0, not_verified: 3, total: 19 });
  assert.equal(result(coreOnly, 'skills.recovery.valid-skill-available').status, 'not_verified');
  assert.equal(result(coreOnly, 'mcp.stdio.recovery.valid-server-available').status, 'not_verified');

  const recoveryOnly = buildReport({ schemaVersion: 1, observations: recoveryObservations() });
  assert.deepEqual(recoveryOnly.summary, { pass: 2, fail: 0, not_verified: 17, total: 19 });
  assert.equal(result(recoveryOnly, 'skills.recovery.valid-skill-available').status, 'pass');
  assert.equal(result(recoveryOnly, 'mcp.stdio.recovery.valid-server-available').status, 'pass');

  const combinedInput = input();
  combinedInput.observations.push(...recoveryObservations());
  const combined = buildReport(combinedInput);
  assert.deepEqual(combined.summary, { pass: 19, fail: 0, not_verified: 0, total: 19 });
  assert.deepEqual(combined.results.map(({ id }) => id), CASE_IDS);
  const recoveryIds = new Set([
    'skills.recovery.valid-skill-available',
    'mcp.stdio.recovery.valid-server-available',
  ]);
  assert.deepEqual(combined.results.filter(({ id }) => !recoveryIds.has(id) && id !== 'mcp.stdio.data.distinct-across-plugins'),
    coreOnly.results.filter(({ id }) => !recoveryIds.has(id) && id !== 'mcp.stdio.data.distinct-across-plugins'));
  assert.deepEqual(combined.observations, [
    ...combinedInput.observations.filter(({ kind }) => kind === 'skill'),
    ...combinedInput.observations.filter(({ kind }) => kind === 'mcp-stdio'),
  ]);
  const reordered = structuredClone(combinedInput);
  reordered.observations.reverse();
  const recoveryMcp = reordered.observations.find(({ server }) => server === 'recovery-valid');
  recoveryMcp.evidence = { server: recoveryMcp.evidence.server, version: recoveryMcp.evidence.version, resolvedData: recoveryMcp.evidence.resolvedData };
  assert.equal(JSON.stringify(buildReport(reordered)), JSON.stringify(combined));

  const missing = buildReport({ schemaVersion: 1, observations: [] });
  assert.deepEqual(missing.summary, { pass: 0, fail: 0, not_verified: 19, total: 19 });
});

test('an incorrect recovery skill marker fails its availability check independently', () => {
  const observations = recoveryObservations();
  observations[0].marker = 'wrong recovery marker';
  const report = buildReport({ schemaVersion: 1, observations });
  const availability = result(report, 'skills.recovery.valid-skill-available');
  assert.equal(availability.status, 'fail');
  assert.match(availability.detail, /expected "APC_RECOVERY_VALID_V1"; observed "wrong recovery marker"/);
  assert.equal(result(report, 'mcp.stdio.recovery.valid-server-available').status, 'pass');
  assert.deepEqual(report.summary, { pass: 1, fail: 1, not_verified: 17, total: 19 });
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
  assert.deepEqual(report.summary, { pass: 0, fail: 0, not_verified: 19, total: 19 });
  const skills = report.results.filter(({ id }) => id.startsWith('skills.'));
  const mcp = report.results.filter(({ id }) => id.startsWith('mcp.'));
  assert.deepEqual(skills.map(({ id }) => id), ['skills.discovery.immediate-children', 'skills.recovery.valid-skill-available']);
  assert.equal(mcp.length, 17);
  assert.ok(mcp.some(({ id }) => id === 'mcp.stdio.env.plugin-root'));
  for (const result of report.results) {
    assert.ok(result.label.length > 0);
  }
});

test('missing default environment fails independent checks and leaves dependent expansion unverified', () => {
  const value = input();
  runtime(value).env = {};
  runtime(value).dataWrite = null;
  const report = buildReport(value);
  for (const id of ['mcp.stdio.env.plugin-root', 'mcp.stdio.env.plugin-data-absolute', 'mcp.stdio.env.configured-value']) assert.equal(result(report, id).status, 'fail');
  for (const id of ['mcp.stdio.args.preservation-and-expansion', 'mcp.stdio.env.expansion']) assert.equal(result(report, id).status, 'not_verified');
  assert.equal(result(report, 'mcp.stdio.data.writable').status, 'not_verified');
  assert.equal(result(report, 'mcp.stdio.tool-availability.cwd-omitted').status, 'pass');
  assert.equal(result(report, 'mcp.stdio.cwd.plugin-data').status, 'pass');
});

test('plugin data writability distinguishes missing evidence, failed writes, successful writes, and cleanup warnings', () => {
  const value = input();
  const id = 'mcp.stdio.data.writable';
  const write = runtime(value).dataWrite;

  assert.equal(result(buildReport(value), id).status, 'pass');

  runtime(value).dataWrite = null;
  assert.equal(result(buildReport(value), id).status, 'not_verified');

  runtime(value).dataWrite = {
    path: write.path,
    error: { operation: 'write', code: 'EACCES', message: 'permission denied' },
    cleanupError: null,
  };
  const failed = result(buildReport(value), id);
  assert.equal(failed.status, 'fail');
  assert.match(failed.detail, /write/);
  assert.match(failed.detail, /EACCES/);
  assert.match(failed.detail, /permission denied/);

  runtime(value).dataWrite = {
    path: write.path,
    error: null,
    cleanupError: { code: 'EBUSY', message: 'resource busy' },
  };
  const warned = result(buildReport(value), id);
  assert.equal(warned.status, 'pass');
  assert.equal(typeof warned.warning, 'string');
  assert.match(warned.warning, /EBUSY/);
  assert.match(warned.warning, /resource busy/);
  assert.match(warned.warning, new RegExp(write.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
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
  runtime(value).dataWrite.path = '/private/tmp/data/.agent-plugins-conformance-write-test';
  runtime(value, 'data').cwd = '/private/tmp/data';
  const report = buildReport(value);
  assert.equal(report.summary.pass, 16);
  assert.equal(report.observations[5].evidence.resolvedData, '/private/tmp/data');
  assert.equal(report.observations[2].evidence.env.PLUGIN_DATA, '/tmp/data');
  runtime(value, 'data').resolvedData = null;
  assert.equal(result(buildReport(value), 'mcp.stdio.cwd.plugin-data').status, 'not_verified');
  assert.equal(result(buildReport(value), 'mcp.stdio.env.plugin-data-absolute').status, 'pass');
});

test('data paths must remain distinct across the recovery and complete core evidence', () => {
  const id = 'mcp.stdio.data.distinct-across-plugins';
  const value = input();
  value.observations.push(...recoveryObservations());
  assert.equal(result(buildReport(value), id).status, 'pass');

  // One observed collision is conclusive, even before every other core probe ran.
  const collision = structuredClone(value);
  collision.observations = collision.observations.filter(({ server }) => !server || ['default', 'data', 'recovery-valid'].includes(server));
  runtime(collision, 'data').resolvedData = '/state/recovery';
  assert.equal(result(buildReport(collision), id).status, 'fail');

  const partialButDistinct = structuredClone(value);
  partialButDistinct.observations = partialButDistinct.observations.filter(({ server }) => !server || server === 'default' || server === 'recovery-valid');
  assert.equal(result(buildReport(partialButDistinct), id).status, 'pass');
  runtime(partialButDistinct, 'recovery-valid').resolvedData = null;
  assert.equal(result(buildReport(partialButDistinct), id).status, 'not_verified');

  const windows = input('C:\\fixture\\plugin', 'D:\\state\\core');
  windows.observations.push(...recoveryObservations());
  runtime(windows, 'recovery-valid').resolvedData = 'D:\\state\\recovery';
  assert.equal(result(buildReport(windows), id).status, 'pass');
  runtime(windows, 'root').resolvedData = 'D:\\state\\recovery\\child\\..';
  assert.equal(result(buildReport(windows), id).status, 'fail');
});

test('core probes require one consistent resolved data path, under POSIX and Windows rules', () => {
  const id = 'mcp.stdio.data.consistent-within-plugin';
  for (const [root, data, different] of [
    ['/fixture/plugin', '/state/plugin', '/state/other'],
    ['C:\\fixture\\plugin', 'D:\\state\\plugin', 'D:\\state\\other'],
  ]) {
    const value = input(root, data);
    assert.equal(result(buildReport(value), id).status, 'pass');

    const mismatch = structuredClone(value);
    mismatch.observations = mismatch.observations.filter(({ server }) => !server || server === 'default' || server === 'data');
    runtime(mismatch, 'data').resolvedData = different;
    assert.equal(result(buildReport(mismatch), id).status, 'fail');

    const incomplete = structuredClone(value);
    incomplete.observations = incomplete.observations.filter(({ server }) => !server || server !== 'data');
    assert.equal(result(buildReport(incomplete), id).status, 'not_verified');
  }
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
    assert.equal(buildReport(value).summary.pass, 16);
    const flavor = root.startsWith('/') ? path.posix : path.win32;
    runtime(value).cwd = `${root}${flavor.sep}sub${flavor.sep}..`;
    assert.equal(result(buildReport(value), 'mcp.stdio.cwd.omitted').status, 'pass');
  }
});

test('data environment must be absolute under the producing operating system path rules', () => {
  for (const [root, data, expected, writable] of [
    ['/plugin', 'C:\\data', 'fail', 'not_verified'],
    ['C:\\plugin', '/data', 'pass', 'pass'],
    ['C:\\plugin', '//server/share/data', 'pass', 'pass'],
    ['C:\\plugin', 'C:data', 'fail', 'not_verified'],
  ]) {
    const value = input(root);
    runtime(value).env.PLUGIN_DATA = data;
    const report = buildReport(value);
    assert.equal(result(report, 'mcp.stdio.env.plugin-data-absolute').status, expected);
    assert.equal(result(report, 'mcp.stdio.data.writable').status, writable);
  }
});

test('unknown keys, duplicate observations, identities, versions and types are rejected', () => {
  const invalid = [
    [(v) => { v.status = 'pass'; }, /input.status: unknown field/],
    [(v) => { v.observations[3] = v.observations[2]; }, /duplicate mcp-stdio/],
    [(v) => { v.observations[1] = v.observations[0]; }, /duplicate skill/],
    [(v) => { runtime(v).env.SECRET = 'not allowed'; }, /unknown field/],
    [(v) => { runtime(v).server = 'other'; }, /must match observation.server/],
    [(v) => { v.observations[2].server = 'other'; }, /expected one of/],
    [(v) => { runtime(v).version = 2; }, /expected 1/],
    [(v) => { runtime(v).extra = true; }, /extra: unknown field/],
    [(v) => { runtime(v).root = 'relative'; }, /absolute/],
    [(v) => { delete runtime(v).resolvedData; }, /resolvedData: required/],
    [(v) => { delete runtime(v).dataWrite; }, /dataWrite: required/],
    [(v) => { runtime(v).resolvedData = 'relative'; }, /absolute/],
    [(v) => { runtime(v).resolvedData = 1; }, /resolvedData: expected/],
    [(v) => { runtime(v).argv = [1]; }, /expected a string/],
    [(v) => { runtime(v).env.APC_VALUE = null; }, /expected a string/],
    [(v) => { v.observations[0].evidence = {}; }, /unknown field/],
    [(v) => { v.observations[2].kind = 'unknown'; }, /expected one of: mcp-stdio, skill/],
  ];
  for (const [change, pattern] of invalid) { const value = input(); change(value); assert.throws(() => buildReport(value), pattern); }
});

test('recovery resolved data is nullable and uses the producing OS path syntax', () => {
  for (const resolvedData of [null, '/state/recovery', 'D:\\state\\recovery']) {
    const value = { schemaVersion: 1, observations: recoveryObservations() };
    value.observations[1].evidence.resolvedData = resolvedData;
    assert.doesNotThrow(() => buildReport(value));
  }
  for (const resolvedData of [undefined, 'relative/data', 1]) {
    const value = { schemaVersion: 1, observations: recoveryObservations() };
    if (resolvedData === undefined) delete value.observations[1].evidence.resolvedData;
    else value.observations[1].evidence.resolvedData = resolvedData;
    assert.throws(() => buildReport(value), /resolvedData/);
  }
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
  for (let included = 0; included < 4; included += 1) {
    const value = input();
    value.observations = value.observations.filter(({ kind }, index) =>
      kind !== 'skill' || (included & (1 << index)));
    const report = buildReport(value);
    const discovery = result(report, 'skills.discovery.immediate-children');
    assert.equal(discovery.status, included === 3 ? 'pass' : 'not_verified');
    assert.deepEqual(report.observations, value.observations);
    for (const [index, skill] of ['alpha', 'beta'].entries()) {
      if (!(included & (1 << index))) assert.ok(discovery.detail.includes(`conformance-${skill}`));
    }
    assert.equal(report.summary.total, 19);
    assert.equal(report.summary.fail, 0);
    assert.equal(report.summary.not_verified, included === 3 ? 3 : 4);
  }
});

test('incorrect skill markers fail the aggregate even when another skill is missing', () => {
  for (const missing of [false, true]) {
    const value = input();
    value.observations[0].marker = 'wrong alpha';
    value.observations[1].marker = 'wrong beta';
    if (missing) value.observations.splice(1, 1);
    const report = buildReport(value);
    const discovery = result(report, 'skills.discovery.immediate-children');
    assert.equal(discovery.status, 'fail');
    assert.match(discovery.detail, /conformance-alpha: expected "APC_ALPHA_V1"; observed "wrong alpha"/);
    if (!missing) assert.match(discovery.detail, /conformance-beta: expected "APC_BETA_V1"; observed "wrong beta"/);
    assert.equal(discovery.detail.includes('Missing skill observations: conformance-beta.'), missing);
    assert.deepEqual(report.summary, { pass: 15, fail: 1, not_verified: 3, total: 19 });
    value.observations.reverse();
    assert.equal(JSON.stringify(buildReport(value)), JSON.stringify(report));
  }
});
