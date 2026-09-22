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
      { kind: 'skill-discovery', skill: 'conformance-nested', advertised: false },
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
const cwdEscapeRuntime = (root = '/plugins/recovery', cwd = '/plugins') => ({
  kind: 'mcp-stdio', server: 'recovery-cwd-escape',
  evidence: { version: 1, server: 'recovery-cwd-escape', root, cwd },
});
const cwdEscapeDiscovery = (advertised = false) => ({
  kind: 'mcp-discovery', server: 'recovery-cwd-escape', advertised,
});

test('complete stdio and skill core evidence passes its cases and preserves canonical evidence', () => {
  const value = input();
  const report = buildReport(value);
  assert.deepEqual(report.summary, { pass: 16, fail: 0, not_verified: 9, total: 25 });
  assert.deepEqual(report.results.map(({ id }) => id), CASE_IDS);
  assert.equal(report.specVersion, '1.0.0');
  assert.deepEqual(result(report, 'mcp.stdio.env.plugin-root').specSections, ['9.1']);
  assert.deepEqual(report.observations, value.observations);
  runtime(value).argv.push('after report');
  runtime(value).dataWrite.cleanupError = { code: 'LATE', message: 'after report' };
  assert.equal(runtime(report).argv.length, 8);
  assert.equal(runtime(report).dataWrite.cleanupError, null);
});

test('recovery witnesses extend the canonical report without changing core-only results', () => {
  const coreOnly = buildReport(input());
  assert.deepEqual(coreOnly.summary, { pass: 16, fail: 0, not_verified: 9, total: 25 });
  assert.equal(result(coreOnly, 'skills.recovery.valid-skill-available').status, 'not_verified');
  assert.equal(result(coreOnly, 'mcp.stdio.recovery.valid-server-available').status, 'not_verified');

  const recoveryOnly = buildReport({ schemaVersion: 1, observations: recoveryObservations() });
  assert.deepEqual(recoveryOnly.summary, { pass: 2, fail: 0, not_verified: 23, total: 25 });
  assert.equal(result(recoveryOnly, 'skills.recovery.valid-skill-available').status, 'pass');
  assert.equal(result(recoveryOnly, 'mcp.stdio.recovery.valid-server-available').status, 'pass');

  const combinedInput = input();
  combinedInput.observations.push(...recoveryObservations());
  const combined = buildReport(combinedInput);
  assert.deepEqual(combined.summary, { pass: 19, fail: 0, not_verified: 6, total: 25 });
  assert.deepEqual(combined.results.map(({ id }) => id), CASE_IDS);
  const recoveryIds = new Set([
    'skills.recovery.valid-skill-available',
    'mcp.stdio.recovery.valid-server-available',
  ]);
  assert.deepEqual(combined.results.filter(({ id }) => !recoveryIds.has(id) && id !== 'mcp.stdio.data.distinct-across-plugins'),
    coreOnly.results.filter(({ id }) => !recoveryIds.has(id) && id !== 'mcp.stdio.data.distinct-across-plugins'));
  assert.deepEqual(combined.observations, [
    ...combinedInput.observations.filter(({ kind }) => kind === 'skill'),
    ...combinedInput.observations.filter(({ kind }) => kind === 'skill-discovery'),
    ...combinedInput.observations.filter(({ kind }) => kind === 'mcp-stdio'),
  ]);
  const reordered = structuredClone(combinedInput);
  reordered.observations.reverse();
  const recoveryMcp = reordered.observations.find(({ server }) => server === 'recovery-valid');
  recoveryMcp.evidence = { server: recoveryMcp.evidence.server, version: recoveryMcp.evidence.version, resolvedData: recoveryMcp.evidence.resolvedData };
  assert.equal(JSON.stringify(buildReport(reordered)), JSON.stringify(combined));

  const missing = buildReport({ schemaVersion: 1, observations: [] });
  assert.deepEqual(missing.summary, { pass: 0, fail: 0, not_verified: 25, total: 25 });
});

test('an incorrect recovery skill marker fails its availability check independently', () => {
  const observations = recoveryObservations();
  observations[0].marker = 'wrong recovery marker';
  const report = buildReport({ schemaVersion: 1, observations });
  const availability = result(report, 'skills.recovery.valid-skill-available');
  assert.equal(availability.status, 'fail');
  assert.match(availability.detail, /expected "APC_RECOVERY_VALID_V1"; observed "wrong recovery marker"/);
  assert.equal(result(report, 'mcp.stdio.recovery.valid-server-available').status, 'pass');
  assert.deepEqual(report.summary, { pass: 1, fail: 1, not_verified: 23, total: 25 });
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
  assert.deepEqual(report.summary, { pass: 0, fail: 0, not_verified: 25, total: 25 });
  const skills = report.results.filter(({ id }) => id.startsWith('skills.'));
  const mcp = report.results.filter(({ id }) => id.startsWith('mcp.'));
  assert.deepEqual(skills.map(({ id }) => id), ['skills.discovery.immediate-children', 'skills.recovery.valid-skill-available', 'skills.recovery.invalid-mcp-document']);
  assert.equal(mcp.length, 22);
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
  assert.equal(runtime(report, 'data').resolvedData, '/private/tmp/data');
  assert.equal(runtime(report).env.PLUGIN_DATA, '/tmp/data');
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
    [(v) => { v.observations[4] = v.observations[3]; }, /duplicate mcp-stdio/],
    [(v) => { v.observations[1] = v.observations[0]; }, /duplicate skill/],
    [(v) => { runtime(v).env.SECRET = 'not allowed'; }, /unknown field/],
    [(v) => { runtime(v).server = 'other'; }, /must match observation.server/],
    [(v) => { v.observations[3].server = 'other'; }, /expected one of/],
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
    [(v) => { v.observations[3].kind = 'unknown'; }, /expected one of: mcp-stdio, mcp-streamable-http, mcp-discovery, skill/],
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

test('cwd escape exclusion combines discovery with a loaded recovery witness and runtime always fails', () => {
  const id = 'mcp.stdio.cwd.plugin-relative-escape';
  const recoveryRuntime = recoveryObservations()[1];
  for (const [observations, status] of [
    [[], 'not_verified'],
    [[cwdEscapeDiscovery(false)], 'not_verified'],
    [[recoveryRuntime], 'not_verified'],
    [[cwdEscapeDiscovery(false), recoveryRuntime], 'pass'],
    [[cwdEscapeDiscovery(true)], 'fail'],
    [[cwdEscapeDiscovery(true), recoveryRuntime], 'fail'],
    [[cwdEscapeRuntime('/plugins/recovery', '/plugins')], 'fail'],
    [[cwdEscapeRuntime('/plugins/recovery', '/plugins/recovery')], 'fail'],
    [[cwdEscapeDiscovery(false), recoveryRuntime, cwdEscapeRuntime()], 'fail'],
  ]) {
    const report = buildReport({ schemaVersion: 1, observations });
    assert.equal(result(report, id).status, status, JSON.stringify(observations));
  }
  assert.match(result(buildReport({ schemaVersion: 1, observations: [cwdEscapeDiscovery(false)] }), id).detail,
    /recovery-valid runtime evidence is missing/);
  assert.match(result(buildReport({ schemaVersion: 1, observations: [recoveryRuntime] }), id).detail,
    /Missing MCP discovery observation/);
  assert.equal(result(buildReport({ schemaVersion: 1, observations: [cwdEscapeRuntime()] }), id).detail,
    'recovery-cwd-escape ran with working directory "/plugins" and plugin root "/plugins/recovery".');
  assert.equal(result(buildReport({ schemaVersion: 1, observations: [cwdEscapeDiscovery(true)] }), id).detail,
    'Agent reported the recovery-cwd-escape observe tool advertised by the client.');
  assert.equal(result(buildReport({ schemaVersion: 1, observations: [cwdEscapeDiscovery(false), recoveryRuntime] }), id).detail,
    'Agent reported the recovery-cwd-escape tool absent from the client inventory while recovery-valid runtime evidence was available.');
});

test('cwd escape discovery and runtime canonicalize separately and preserve existing results', () => {
  const id = 'mcp.stdio.cwd.plugin-relative-escape';
  const recoveryRuntime = recoveryObservations()[1];
  const discovery = cwdEscapeDiscovery(false);
  const escapeRuntime = cwdEscapeRuntime();
  const observations = [escapeRuntime, recoveryRuntime, discovery];
  const report = buildReport({ schemaVersion: 1, observations });
  assert.deepEqual(report.observations, [discovery, recoveryRuntime, escapeRuntime]);
  assert.equal(result(report, id).status, 'fail');
  assert.deepEqual(buildReport({ schemaVersion: 1, observations: report.observations }), report);
  assert.deepEqual(buildReport({ schemaVersion: 1, observations: [...observations].reverse() }), report);

  escapeRuntime.evidence.cwd = '/changed-after-report';
  discovery.advertised = true;
  assert.equal(report.observations[0].advertised, false);
  assert.equal(report.observations[2].evidence.cwd, '/plugins');

  const before = buildReport({ schemaVersion: 1, observations: [recoveryRuntime] });
  const after = buildReport({ schemaVersion: 1, observations: [recoveryRuntime, cwdEscapeDiscovery(false)] });
  assert.deepEqual(after.results.filter(({ id: resultId }) => resultId !== id),
    before.results.filter(({ id: resultId }) => resultId !== id));
  assert.equal(result(after, id).status, 'pass');
});

test('cwd escape discovery and runtime schemas are strict and independently unique', () => {
  const discovery = cwdEscapeDiscovery(false);
  for (const value of [
    { ...discovery, advertised: null },
    { ...discovery, advertised: 'false' },
    { ...discovery, server: 'recovery-valid' },
    { ...discovery, evidence: null },
    { kind: 'mcp-discovery', server: 'recovery-cwd-escape' },
  ]) assert.throws(() => buildReport({ schemaVersion: 1, observations: [value] }), TypeError);
  assert.throws(() => buildReport({ schemaVersion: 1, observations: [discovery, cwdEscapeDiscovery(true)] }), /duplicate/);

  const invalidRuntime = [
    (value) => { value.evidence.version = 2; },
    (value) => { value.evidence.server = 'recovery-valid'; },
    (value) => { value.evidence.root = 'relative'; },
    (value) => { value.evidence.cwd = 'relative'; },
    (value) => { delete value.evidence.root; },
    (value) => { delete value.evidence.cwd; },
    (value) => { value.evidence.resolvedData = '/data'; },
    (value) => { value.evidence.argv = []; },
  ];
  for (const change of invalidRuntime) {
    const value = cwdEscapeRuntime();
    change(value);
    assert.throws(() => buildReport({ schemaVersion: 1, observations: [value] }), TypeError);
  }
  assert.throws(() => buildReport({ schemaVersion: 1, observations: [cwdEscapeRuntime(), cwdEscapeRuntime()] }), /duplicate/);
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

test('skill discovery requires both correct markers and explicit nested exclusion; contradictions fail immediately', () => {
  for (const alpha of [undefined, 'APC_ALPHA_V1', 'wrong']) {
    for (const beta of [undefined, 'APC_BETA_V1', 'wrong']) {
      for (const advertised of [undefined, false, true]) {
        const observations = [
          ...(alpha === undefined ? [] : [{ kind: 'skill', skill: 'conformance-alpha', marker: alpha }]),
          ...(beta === undefined ? [] : [{ kind: 'skill', skill: 'conformance-beta', marker: beta }]),
          ...(advertised === undefined ? [] : [{ kind: 'skill-discovery', skill: 'conformance-nested', advertised }]),
        ];
        const report = buildReport({ schemaVersion: 1, observations });
        const expected = alpha === 'wrong' || beta === 'wrong' || advertised === true ? 'fail'
          : alpha !== undefined && beta !== undefined && advertised === false ? 'pass' : 'not_verified';
        assert.equal(result(report, 'skills.discovery.immediate-children').status, expected,
          JSON.stringify({ alpha, beta, advertised }));
        assert.deepEqual(report.observations, observations);
        assert.deepEqual(buildReport({ schemaVersion: 1, observations: report.observations }), report);
        assert.deepEqual(buildReport({ schemaVersion: 1, observations: [...observations].reverse() }), report);
        assert.equal(report.results.length, CASE_IDS.length);
        assert.ok(report.results.filter(({ id }) => id !== 'skills.discovery.immediate-children')
          .every(({ status }) => status === 'not_verified'));
      }
    }
  }
});

test('nested discovery observations require the exact identity, boolean, fields, and uniqueness', () => {
  const observation = { kind: 'skill-discovery', skill: 'conformance-nested', advertised: false };
  const invalid = [
    ...[undefined, null, 0, 1, 'false', 'true', {}, []].map((advertised) => ({ ...observation, advertised })),
    { kind: 'skill-discovery', skill: 'conformance-nested' },
    { ...observation, skill: 'conformance-alpha' },
    { ...observation, marker: 'APC_NESTED_V1' },
    { ...observation, server: 'default' },
  ];
  for (const value of invalid) {
    assert.throws(() => buildReport({ schemaVersion: 1, observations: [value] }), TypeError);
  }
  assert.throws(() => buildReport({ schemaVersion: 1, observations: [observation, { ...observation, advertised: true }] }), /duplicate/);
});

test('malformed MCP skill evidence affects only its own result for missing, correct, and incorrect markers', () => {
  const id = 'skills.recovery.invalid-mcp-document';
  const value = input();
  value.observations.push(...recoveryObservations());
  const baseline = buildReport(value);
  assert.equal(result(baseline, id).status, 'not_verified');
  for (const [marker, status] of [['APC_INVALID_MCP_VALID_V1', 'pass'], ['incorrect marker', 'fail']]) {
    const observation = { kind: 'skill', skill: 'conformance-invalid-mcp-valid', marker };
    const report = buildReport({ schemaVersion: 1, observations: [...value.observations, observation] });
    assert.equal(result(report, id).status, status);
    assert.deepEqual(result(report, id).specSections, ['7.2.2']);
    assert.deepEqual(report.results.filter((item) => item.id !== id), baseline.results.filter((item) => item.id !== id));
    assert.deepEqual(report.observations.find(({ skill }) => skill === observation.skill), observation);
    assert.deepEqual(report.summary, { pass: status === 'pass' ? 20 : 19, fail: status === 'fail' ? 1 : 0, not_verified: 5, total: 25 });
    if (status === 'fail') assert.match(result(report, id).detail, /expected "APC_INVALID_MCP_VALID_V1"; observed "incorrect marker"/);
    const reversed = { schemaVersion: 1, observations: [...value.observations, observation].reverse() };
    assert.equal(JSON.stringify(buildReport(reversed)), JSON.stringify(report));
  }
});

const httpObservation = () => ({
  kind: 'mcp-streamable-http', server: 'http', serverHealthCheck: 'passed', evidence: {
    type: 'request', version: 1, pathname: '/conformance/mcp', query: [['value', '$APC_HTTP_VALUE']],
    headers: { 'x-apc-fixture': '${PLUGIN_ROOT}|${PLUGIN_DATA}|fixture value with spaces' },
  },
});
const httpResults = (report) => report.results.filter(({ id }) =>
  id.startsWith('mcp.streamable-http.') && id !== 'mcp.streamable-http.headers.cross-origin-redirect');

test('native HTTP observation passes availability and evaluates URL and header independently', () => {
  const observation = httpObservation();
  const value = { schemaVersion: 1, observations: [observation] };
  const report = buildReport(value);
  assert.deepEqual(httpResults(report).map(({ status }) => status), ['pass', 'pass', 'pass']);
  assert.deepEqual(report.observations, [observation]);
  observation.evidence.query[0][1] = 'expanded';
  observation.evidence.headers['x-apc-fixture'] = null;
  assert.equal(report.observations[0].evidence.query[0][1], '$APC_HTTP_VALUE');
  assert.notEqual(report.observations[0].evidence.headers['x-apc-fixture'], null);
  assert.deepEqual(httpResults(buildReport(value)).map(({ status }) => status), ['pass', 'fail', 'fail']);
});

test('HTTP URL evidence preserves literal raw pathname and ordered decoded pairs', () => {
  for (const [pathname, query] of [
    ['/conformance/%6dcp', [['value', '$APC_HTTP_VALUE']]],
    ['/other/mcp', [['value', '$APC_HTTP_VALUE']]],
    ['/conformance/mcp', [['value', 'expanded']]],
    ['/conformance/mcp', [['value', '$APC_HTTP_VALUE'], ['value', '$APC_HTTP_VALUE']]],
    ['/conformance/mcp', []],
  ]) {
    const observation = httpObservation();
    Object.assign(observation.evidence, { pathname, query });
    const report = buildReport({ schemaVersion: 1, observations: [observation] });
    assert.deepEqual(httpResults(report).map(({ status }) => status), ['pass', 'fail', 'pass']);
  }
});

test('HTTP availability combines native evidence with saved server health deterministically', (t) => {
  t.mock.method(globalThis, 'fetch', () => assert.fail('saved evidence must not trigger a health request'));
  const empty = buildReport({ schemaVersion: 1, observations: [] });
  assert.deepEqual(httpResults(empty).map(({ status }) => status), ['not_verified', 'not_verified', 'not_verified']);
  for (const serverHealthCheck of ['passed', 'failed']) {
    for (const evidence of [httpObservation().evidence, null]) {
      const observation = { kind: 'mcp-streamable-http', server: 'http', evidence, serverHealthCheck };
      const value = { schemaVersion: 1, observations: [observation] };
      const report = buildReport(value);
      assert.deepEqual(httpResults(report).map(({ status }) => status), evidence
        ? ['pass', 'pass', 'pass']
        : [serverHealthCheck === 'passed' ? 'fail' : 'not_verified', 'not_verified', 'not_verified']);
      assert.deepEqual(report.observations, [observation]);
      assert.deepEqual(buildReport({ schemaVersion: report.schemaVersion, observations: report.observations }), report);
    }
  }
});

test('saved HTTP observations require evidence and a valid server health check', () => {
  for (const evidence of [httpObservation().evidence, null]) {
    for (const serverHealthCheck of [undefined, null, true, 'unknown']) {
      const observation = { ...httpObservation(), evidence, serverHealthCheck };
      assert.throws(() => buildReport({ schemaVersion: 1, observations: [observation] }), /serverHealthCheck/);
    }
    const observation = { ...httpObservation(), evidence };
    delete observation.serverHealthCheck;
    assert.throws(() => buildReport({ schemaVersion: 1, observations: [observation] }), /serverHealthCheck/);
  }
  const observation = httpObservation();
  delete observation.evidence;
  assert.throws(() => buildReport({ schemaVersion: 1, observations: [observation] }), /evidence/);
  const missing = { ...httpObservation(), evidence: null };
  assert.throws(() => buildReport({ schemaVersion: 1, observations: [missing, httpObservation()] }), /duplicate/);
});

test('HTTP evidence rejects malformed schemas and duplicates', () => {
  for (const modify of [
    (e) => { e.query = [['name']]; },
    (e) => { e.query = [[1, 'value']]; },
    (e) => { e.pathname = null; },
    (e) => { e.headers = {}; },
    (e) => { e.headers.authorization = 'unrelated'; },
    (e) => { e.headers['x-apc-fixture'] = false; },
  ]) {
    const observation = httpObservation();
    modify(observation.evidence);
    assert.throws(() => buildReport({ schemaVersion: 1, observations: [observation] }));
  }
  assert.throws(() => buildReport({ schemaVersion: 1, observations: [httpObservation(), httpObservation()] }), /duplicate/);
});
