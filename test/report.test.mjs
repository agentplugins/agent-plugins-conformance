import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { buildReport, CASE_IDS } from '../plugins/agent-plugins-conformance/src/report.mjs';

function input(root = '/fixture/plugin', data = '/state/plugin') {
  const flavor = root.startsWith('/') ? path.posix : path.win32;
  const platform = flavor === path.win32 ? 'windows' : 'posix';
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
      commandTokenObservation(platform, root, data),
    ],
  };
}
const commandTokenObservation = (platform, root = '/fixture/plugin', data = '/state/plugin', {
  origin = `${platform}-exact`, marker = 'intact', args = ['arg with spaces', '', 'literal-value'],
} = {}) => {
  const server = `command-token-${platform}`;
  return {
    kind: 'mcp-stdio', server,
    evidence: {
      version: 1, server, root, cwd: root, resolvedData: data,
      argv: [server, origin, marker, ...args], env: {},
    },
  };
};
const runtime = (value, server = 'default') => value.observations.find((observation) => observation.server === server).evidence;
const result = (report, id) => report.results.find((item) => item.id === id);
const recoveryObservations = () => [
  { kind: 'skill', skill: 'conformance-recovery-valid', marker: 'APC_RECOVERY_VALID_V1' },
  {
    kind: 'mcp-stdio', server: 'recovery-valid',
    evidence: { version: 1, server: 'recovery-valid', resolvedData: '/state/recovery', symlinkCwd: 'symlink' },
  },
];
const invalidServerRuntime = (server = 'recovery-cwd-escape', root = '/plugins/recovery', cwd = '/plugins') => ({
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
  ['recovery-http-type', 'mcp.config.legacy-http-type'],
  ['recovery-http-relative-url', 'mcp.streamable-http.url.relative'],
  ['recovery-http-fragment', 'mcp.streamable-http.url.fragment'],
  ['recovery-http-duplicate-headers', 'mcp.streamable-http.headers.duplicate-names'],
  ['recovery-http-userinfo', 'mcp.streamable-http.url.userinfo'],
  ['recovery-http-header-name', 'mcp.streamable-http.headers.invalid-name'],
  ['recovery-http-header-value', 'mcp.streamable-http.headers.invalid-value'],
];
const invalidSseServerCases = [
  ['recovery-sse-relative-url', 'mcp.sse.url.relative'],
  ['recovery-sse-fragment', 'mcp.sse.url.fragment'],
  ['recovery-sse-userinfo', 'mcp.sse.url.userinfo'],
  ['recovery-sse-duplicate-headers', 'mcp.sse.headers.duplicate-names'],
  ['recovery-sse-header-name', 'mcp.sse.headers.invalid-name'],
  ['recovery-sse-header-value', 'mcp.sse.headers.invalid-value'],
];

test('complete stdio and skill core evidence passes its cases and preserves canonical evidence', () => {
  const value = input();
  const report = buildReport(value);
  assert.deepEqual(report.summary, { pass: 17, fail: 0, not_verified: 36, total: 53 });
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
  assert.deepEqual(coreOnly.summary, { pass: 17, fail: 0, not_verified: 36, total: 53 });
  assert.equal(result(coreOnly, 'skills.recovery.valid-skill-available').status, 'not_verified');
  assert.equal(result(coreOnly, 'mcp.stdio.recovery.valid-server-available').status, 'not_verified');

  const recoveryOnly = buildReport({ schemaVersion: 1, observations: recoveryObservations() });
  assert.deepEqual(recoveryOnly.summary, { pass: 2, fail: 0, not_verified: 51, total: 53 });
  assert.equal(result(recoveryOnly, 'skills.recovery.valid-skill-available').status, 'pass');
  assert.equal(result(recoveryOnly, 'mcp.stdio.recovery.valid-server-available').status, 'pass');

  const combinedInput = input();
  combinedInput.observations.push(...recoveryObservations());
  const combined = buildReport(combinedInput);
  assert.deepEqual(combined.summary, { pass: 20, fail: 0, not_verified: 33, total: 53 });
  assert.deepEqual(combined.results.map(({ id }) => id), CASE_IDS);
  const recoveryIds = new Set([
    'skills.recovery.valid-skill-available',
    'mcp.stdio.recovery.valid-server-available',
  ]);
  assert.deepEqual(combined.results.filter(({ id }) => !recoveryIds.has(id) && id !== 'filesystem.data.distinct-across-plugins'),
    coreOnly.results.filter(({ id }) => !recoveryIds.has(id) && id !== 'filesystem.data.distinct-across-plugins'));
  assert.deepEqual(combined.observations, [
    ...combinedInput.observations.filter(({ kind }) => kind === 'skill'),
    ...combinedInput.observations.filter(({ kind }) => kind === 'skill-discovery'),
    ...combinedInput.observations.filter(({ kind }) => kind === 'mcp-stdio'),
  ]);
  const reordered = structuredClone(combinedInput);
  reordered.observations.reverse();
  const recoveryMcp = reordered.observations.find(({ server }) => server === 'recovery-valid');
  recoveryMcp.evidence = {
    symlinkCwd: recoveryMcp.evidence.symlinkCwd, server: recoveryMcp.evidence.server,
    version: recoveryMcp.evidence.version, resolvedData: recoveryMcp.evidence.resolvedData,
  };
  assert.equal(JSON.stringify(buildReport(reordered)), JSON.stringify(combined));

  const missing = buildReport({ schemaVersion: 1, observations: [] });
  assert.deepEqual(missing.summary, { pass: 0, fail: 0, not_verified: 53, total: 53 });
});

test('an incorrect recovery skill marker fails its availability check independently', () => {
  const observations = recoveryObservations();
  observations[0].marker = 'wrong recovery marker';
  const report = buildReport({ schemaVersion: 1, observations });
  const availability = result(report, 'skills.recovery.valid-skill-available');
  assert.equal(availability.status, 'fail');
  assert.match(availability.detail, /expected "APC_RECOVERY_VALID_V1"; observed "wrong recovery marker"/);
  assert.equal(result(report, 'mcp.stdio.recovery.valid-server-available').status, 'pass');
  assert.deepEqual(report.summary, { pass: 1, fail: 1, not_verified: 51, total: 53 });
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
  assert.deepEqual(report.summary, { pass: 0, fail: 0, not_verified: 53, total: 53 });
  const skills = report.results.filter(({ id }) => id.startsWith('skills.'));
  const mcp = report.results.filter(({ id }) => id.startsWith('mcp.'));
  assert.deepEqual(skills.map(({ id }) => id), ['skills.discovery.immediate-children', 'skills.recovery.valid-skill-available', 'skills.recovery.invalid-mcp-document']);
  assert.equal(mcp.length, 46);
  assert.equal(report.results.filter(({ id }) => id.startsWith('filesystem.')).length, 4);
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
  assert.equal(result(report, 'filesystem.data.writable').status, 'not_verified');
  assert.equal(result(report, 'mcp.stdio.tool-availability.cwd-omitted').status, 'pass');
  assert.equal(result(report, 'mcp.stdio.cwd.plugin-data').status, 'pass');
});

test('plugin data writability distinguishes missing evidence, failed writes, successful writes, and cleanup warnings', () => {
  const value = input();
  const id = 'filesystem.data.writable';
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
  assert.equal(report.summary.pass, 17);
  assert.equal(runtime(report, 'data').resolvedData, '/private/tmp/data');
  assert.equal(runtime(report).env.PLUGIN_DATA, '/tmp/data');
  runtime(value, 'data').resolvedData = null;
  assert.equal(result(buildReport(value), 'mcp.stdio.cwd.plugin-data').status, 'not_verified');
  assert.equal(result(buildReport(value), 'mcp.stdio.env.plugin-data-absolute').status, 'pass');
});

test('data paths must remain distinct across the recovery and complete core evidence', () => {
  const id = 'filesystem.data.distinct-across-plugins';
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
  const id = 'filesystem.data.consistent-within-plugin';
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

test('the platform command fixture establishes exact execution and attributable splitting', () => {
  const id = 'mcp.stdio.command.single-token';
  for (const [root, data, platform, tail] of [
    ['/fixture/plugin', '/state/plugin', 'posix', 'token.sh'],
    ['C:\\fixture\\plugin', 'D:\\state\\plugin', 'windows', 'token.cmd'],
  ]) {
    const value = input(root, data);
    const exact = result(buildReport(value), id);
    assert.equal(exact.status, 'pass');
    assert.deepEqual(exact.specSections, ['7.2.1']);
    assert.match(exact.detail, new RegExp(`${platform} exact-name wrapper`));

    const observation = value.observations.find(({ server }) => server === `command-token-${platform}`);
    observation.evidence.argv = [observation.server, `${platform}-exact`, 'intact', 'mangled', 'later', 'arguments'];
    assert.equal(result(buildReport(value), id).status, 'pass');
    observation.evidence.argv = [observation.server, `${platform}-decoy`, 'split', tail, 'mangled', 'later', 'arguments'];
    const split = result(buildReport(value), id);
    assert.equal(split.status, 'fail');
    assert.match(split.detail, new RegExp(`${platform} decoy wrapper`));
    assert.match(split.detail, new RegExp(tail.replace('.', '\\.')));
  }
});

test('command-token attribution requires independent matching Core root evidence', () => {
  const id = 'mcp.stdio.command.single-token';
  const core = input();
  const defaultObservation = core.observations.find(({ server }) => server === 'default');
  const posixObservation = core.observations.find(({ server }) => server === 'command-token-posix');
  const windowsObservation = commandTokenObservation('windows', 'C:\\fixture\\plugin', 'D:\\state\\plugin');

  for (const observations of [
    [posixObservation],
    [defaultObservation],
    [defaultObservation, windowsObservation],
  ]) {
    assert.equal(result(buildReport({ schemaVersion: 1, observations }), id).status, 'not_verified');
  }

  const mismatched = structuredClone(posixObservation);
  mismatched.evidence.root = '/different/plugin';
  assert.match(result(buildReport({ schemaVersion: 1, observations: [defaultObservation, mismatched] }), id).detail,
    /same installed plugin root/);

  const unattributable = structuredClone(posixObservation);
  unattributable.evidence.argv = [unattributable.server, 'posix-decoy', 'split', 'not-the-command-tail'];
  assert.match(result(buildReport({ schemaVersion: 1, observations: [defaultObservation, unattributable] }), id).detail,
    /did not identify either/);

  assert.throws(() => buildReport({ schemaVersion: 1, observations: [posixObservation, structuredClone(posixObservation)] }),
    /duplicate mcp-stdio observation: command-token-posix/);
});

test('applicable split evidence fails despite a wrong-platform exact observation', () => {
  const value = input();
  const posix = value.observations.find(({ server }) => server === 'command-token-posix');
  posix.evidence.argv = [posix.server, 'posix-decoy', 'split', 'token.sh'];
  value.observations.push(commandTokenObservation('windows', 'C:\\fixture\\plugin', 'D:\\state\\plugin'));
  assert.equal(result(buildReport(value), 'mcp.stdio.command.single-token').status, 'fail');
});

test('command-token observations stay outside cwd and plugin-data aggregate checks', () => {
  const observation = commandTokenObservation('posix');
  const report = buildReport({ schemaVersion: 1, observations: [observation] });
  assert.equal(result(report, 'mcp.stdio.command.single-token').status, 'not_verified');
  assert.ok(report.results.filter(({ id }) => id !== 'mcp.stdio.command.single-token')
    .every(({ status }) => status === 'not_verified'));
});

test('path comparisons follow producing OS and normalize path components', () => {
  for (const [root, data] of [['/plugin with spaces', '/data with spaces'], ['C:\\plugin', 'D:\\data'], ['\\\\host\\share\\plugin', '\\\\host\\share\\data']]) {
    const value = input(root, data);
    assert.equal(buildReport(value).summary.pass, 17);
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
    assert.equal(result(report, 'filesystem.data.writable').status, writable);
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
    [(v) => { v.observations[3].kind = 'unknown'; }, /expected one of: mcp-stdio, mcp-streamable-http, mcp-sse, mcp-discovery, skill/],
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

test('recovery symlink inspection evidence is optional for old reports and otherwise a strict enum', () => {
  const old = recoveryObservations();
  delete old[1].evidence.symlinkCwd;
  assert.doesNotThrow(() => buildReport({ schemaVersion: 1, observations: old }));
  for (const symlinkCwd of [null, 'symlink', 'missing', 'other']) {
    const observations = recoveryObservations();
    observations[1].evidence.symlinkCwd = symlinkCwd;
    assert.doesNotThrow(() => buildReport({ schemaVersion: 1, observations }));
  }
  for (const symlinkCwd of [false, '', 'unknown']) {
    const observations = recoveryObservations();
    observations[1].evidence.symlinkCwd = symlinkCwd;
    assert.throws(() => buildReport({ schemaVersion: 1, observations }), /symlinkCwd/);
  }
});

test('invalid servers combine discovery with a loaded recovery witness and runtime always fails', () => {
  const recoveryRuntime = recoveryObservations()[1];
  for (const [server, id] of invalidServerCases) {
    for (const [observations, status] of [
      [[], 'not_verified'],
      [[invalidServerDiscovery(server, false)], 'not_verified'],
      [[recoveryRuntime], 'not_verified'],
      [[invalidServerDiscovery(server, false), recoveryRuntime], 'pass'],
      [[invalidServerDiscovery(server, true)], 'fail'],
      [[invalidServerDiscovery(server, true), recoveryRuntime], 'fail'],
      [[invalidServerRuntime(server, '/plugins/recovery', '/plugins')], 'fail'],
      [[invalidServerRuntime(server, '/plugins/recovery', '/plugins/recovery')], 'fail'],
      [[invalidServerDiscovery(server, false), recoveryRuntime, invalidServerRuntime(server)], 'fail'],
    ]) {
      const report = buildReport({ schemaVersion: 1, observations });
      assert.equal(result(report, id).status, status, `${server}: ${JSON.stringify(observations)}`);
    }
    assert.equal(result(buildReport({ schemaVersion: 1, observations: [invalidServerDiscovery(server, false)] }), id).detail,
      `Agent reported the ${server} tool absent, but recovery-valid runtime evidence is missing.`);
    assert.equal(result(buildReport({ schemaVersion: 1, observations: [recoveryRuntime] }), id).detail,
      `Missing MCP discovery observation for ${server}.`);
    assert.equal(result(buildReport({ schemaVersion: 1, observations: [invalidServerRuntime(server)] }), id).detail,
      `${server} ran with working directory "/plugins" and plugin root "/plugins/recovery".`);
    assert.equal(result(buildReport({ schemaVersion: 1, observations: [invalidServerDiscovery(server, true)] }), id).detail,
      `Agent reported the ${server} observe tool advertised by the client.`);
    assert.equal(result(buildReport({ schemaVersion: 1, observations: [invalidServerDiscovery(server, false), recoveryRuntime] }), id).detail,
      `Agent reported the ${server} tool absent from the client inventory while recovery-valid runtime evidence was available.`);
  }
});

test('symlink cwd exclusion accepts only an intact or removed fixture with valid recovery runtime', () => {
  const server = 'recovery-cwd-symlink-escape';
  const id = 'filesystem.containment.cwd-symlink-escape';
  for (const [symlinkCwd, expected] of [
    ['symlink', 'pass'], ['missing', 'pass'], ['other', 'not_verified'], [null, 'not_verified'],
  ]) {
    const recoveryRuntime = recoveryObservations()[1];
    recoveryRuntime.evidence.symlinkCwd = symlinkCwd;
    const report = buildReport({
      schemaVersion: 1,
      observations: [invalidServerDiscovery(server, false), recoveryRuntime],
    });
    assert.equal(result(report, id).status, expected, String(symlinkCwd));
  }
  const oldRecoveryRuntime = recoveryObservations()[1];
  delete oldRecoveryRuntime.evidence.symlinkCwd;
  assert.equal(result(buildReport({
    schemaVersion: 1,
    observations: [invalidServerDiscovery(server, false), oldRecoveryRuntime],
  }), id).status, 'not_verified');
});

test('invalid server identities canonicalize separately and preserve existing results', () => {
  const invalidIds = new Set(invalidServerCases.map(([, id]) => id));
  const recoveryRuntime = recoveryObservations()[1];
  const discoveries = invalidServerCases.map(([server]) => invalidServerDiscovery(server, false));
  const invalidRuntimes = invalidServerCases.map(([server]) => invalidServerRuntime(
    server, '/plugins/recovery', server === 'recovery-cwd-escape' ? '/plugins' : '/state',
  ));
  const observations = [
    ...invalidRuntimes.toReversed(), discoveries[0], recoveryRuntime, ...discoveries.slice(1).toReversed(),
  ];
  const report = buildReport({ schemaVersion: 1, observations });
  assert.deepEqual(report.observations, [...discoveries, recoveryRuntime, ...invalidRuntimes]);
  for (const [, id] of invalidServerCases) assert.equal(result(report, id).status, 'fail');
  assert.deepEqual(buildReport({ schemaVersion: 1, observations: report.observations }), report);
  assert.deepEqual(buildReport({ schemaVersion: 1, observations: [...observations].reverse() }), report);

  invalidRuntimes[0].evidence.cwd = '/changed-after-report';
  discoveries[0].advertised = true;
  assert.equal(report.observations[0].advertised, false);
  assert.equal(report.observations.find(({ kind, server }) =>
    kind === 'mcp-stdio' && server === 'recovery-cwd-escape').evidence.cwd, '/plugins');

  const before = buildReport({ schemaVersion: 1, observations: [recoveryRuntime] });
  const after = buildReport({ schemaVersion: 1, observations: [recoveryRuntime, ...invalidServerCases.map(([server]) => invalidServerDiscovery(server, false))] });
  assert.deepEqual(after.results.filter(({ id }) => !invalidIds.has(id)),
    before.results.filter(({ id }) => !invalidIds.has(id)));
  for (const [, id] of invalidServerCases) assert.equal(result(after, id).status, 'pass');
});

test('invalid server discovery and runtime schemas are strict and independently unique', () => {
  const discovery = invalidServerDiscovery('recovery-cwd-escape', false);
  for (const value of [
    { ...discovery, advertised: null },
    { ...discovery, advertised: 'false' },
    { ...discovery, server: 'recovery-valid' },
    { ...discovery, evidence: null },
    { kind: 'mcp-discovery', server: 'recovery-cwd-escape' },
  ]) assert.throws(() => buildReport({ schemaVersion: 1, observations: [value] }), TypeError);
  assert.throws(() => buildReport({ schemaVersion: 1, observations: [discovery, invalidServerDiscovery('recovery-cwd-escape', true)] }), /duplicate/);
  assert.doesNotThrow(() => buildReport({ schemaVersion: 1, observations: invalidServerCases.map(([server]) => invalidServerDiscovery(server)) }));

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
  for (const [server] of invalidServerCases) {
    for (const change of invalidRuntime) {
      const value = invalidServerRuntime(server);
      change(value);
      assert.throws(() => buildReport({ schemaVersion: 1, observations: [value] }), TypeError);
    }
  }
  assert.throws(() => buildReport({ schemaVersion: 1, observations: [invalidServerRuntime(), invalidServerRuntime()] }), /duplicate/);
  assert.doesNotThrow(() => buildReport({ schemaVersion: 1, observations: invalidServerCases.map(([server]) => invalidServerRuntime(server)) }));
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
    assert.deepEqual(report.summary, { pass: status === 'pass' ? 21 : 20, fail: status === 'fail' ? 1 : 0, not_verified: 32, total: 53 });
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
const invalidHttpRuntime = (server, evidence = {
  type: 'request', version: 1, pathname: `/conformance/${server}`, query: [],
  headers: { 'x-apc-fixture': null },
}) => ({ kind: 'mcp-streamable-http', server, serverHealthCheck: 'passed', evidence });
const httpError = (server, message = 'native HTTP attempt failed') => invalidHttpRuntime(server, {
  type: 'error', message, classification: null,
});
const httpResults = (report) => report.results.filter(({ id }) => [
  'mcp.streamable-http.tool-availability',
  'mcp.streamable-http.url.literal-route-and-query',
  'mcp.streamable-http.headers.literal-value',
].includes(id));

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

const sseObservation = () => ({
  kind: 'mcp-sse', server: 'sse', evidence: {
    type: 'request', version: 1, pathname: '/conformance/sse', query: [['value', '$APC_SSE_VALUE']],
    headers: { 'x-apc-fixture': '${PLUGIN_ROOT}|${PLUGIN_DATA}|fixture value with spaces' },
  },
});
const SSE_ORIGIN = 'http://127.0.0.1:43187';
const SSE_LITERAL_HEADER = '${PLUGIN_ROOT}|${PLUGIN_DATA}|fixture value with spaces';
const sseConnection = () => ({
  origin: SSE_ORIGIN,
  pathname: '/conformance/sse',
  query: [['value', '$APC_SSE_VALUE']],
  headers: { 'x-apc-fixture': SSE_LITERAL_HEADER, accept: 'text/event-stream' },
});
const sseSessionObservation = () => ({
  kind: 'mcp-sse', server: 'sse', evidence: {
    type: 'sse-session', version: 1,
    connection: sseConnection(),
    redirectSource: null,
    messages: [
      { origin: SSE_ORIGIN, headers: { 'x-apc-fixture': SSE_LITERAL_HEADER } },
      { origin: SSE_ORIGIN, headers: { 'x-apc-fixture': SSE_LITERAL_HEADER } },
    ],
  },
});
const invalidSseRuntime = (server, evidence = {
  type: 'request', version: 1, pathname: `/conformance/${server}`, query: [],
  headers: { 'x-apc-fixture': null },
}) => ({ kind: 'mcp-sse', server, evidence });
const sseResults = (report) => report.results.filter(({ id }) => [
  'mcp.sse.tool-availability',
  'mcp.sse.url.literal-route-and-query',
  'mcp.sse.headers.literal-value',
  'mcp.sse.headers.literal-post-value',
].includes(id));

test('native SSE request evidence passes availability and evaluates URL and initial header independently', () => {
  const observation = sseObservation();
  const report = buildReport({ schemaVersion: 1, observations: [observation] });
  assert.deepEqual(sseResults(report).map(({ status }) => status), ['pass', 'pass', 'pass', 'not_verified']);
  assert.deepEqual(report.observations, [observation]);
  assert.deepEqual(buildReport({ schemaVersion: report.schemaVersion, observations: report.observations }), report);

  observation.evidence.pathname = '/conformance/expanded';
  observation.evidence.query[0][1] = 'expanded';
  observation.evidence.headers['x-apc-fixture'] = 'expanded';
  assert.equal(report.observations[0].evidence.pathname, '/conformance/sse');
  assert.deepEqual(sseResults(buildReport({ schemaVersion: 1, observations: [observation] })).map(({ status }) => status),
    ['pass', 'fail', 'fail', 'not_verified']);
});

test('SSE URL evidence preserves the literal route and one ordered decoded query pair', () => {
  for (const [pathname, query] of [
    ['/conformance/%73se', [['value', '$APC_SSE_VALUE']]],
    ['/other/sse', [['value', '$APC_SSE_VALUE']]],
    ['/conformance/sse', [['value', 'expanded']]],
    ['/conformance/sse', [['value', '$APC_SSE_VALUE'], ['value', '$APC_SSE_VALUE']]],
    ['/conformance/sse', []],
  ]) {
    const observation = sseObservation();
    Object.assign(observation.evidence, { pathname, query });
    assert.deepEqual(sseResults(buildReport({ schemaVersion: 1, observations: [observation] })).map(({ status }) => status),
      ['pass', 'fail', 'pass', 'not_verified']);
  }
});

test('SSE path, query, and initial header mismatches fail only their specific literal checks', () => {
  for (const [modify, statuses] of [
    [(evidence) => { evidence.connection.pathname = '/other/sse'; }, ['pass', 'fail', 'pass', 'pass']],
    [(evidence) => { evidence.connection.query = [['value', 'expanded']]; }, ['pass', 'fail', 'pass', 'pass']],
    [(evidence) => { evidence.connection.headers['x-apc-fixture'] = 'expanded'; }, ['pass', 'pass', 'fail', 'pass']],
  ]) {
    const observation = sseSessionObservation();
    modify(observation.evidence);
    assert.deepEqual(sseResults(buildReport({ schemaVersion: 1, observations: [observation] })).map(({ status }) => status),
      statuses);
  }
});

test('missing, null, and error SSE evidence remain unverified and preserve exact diagnostics', () => {
  assert.deepEqual(sseResults(buildReport({ schemaVersion: 1, observations: [] })).map(({ status }) => status),
    ['not_verified', 'not_verified', 'not_verified', 'not_verified']);
  for (const evidence of [null, { type: 'error', message: 'native SSE failure\nwith detail', classification: null }]) {
    const observation = { kind: 'mcp-sse', server: 'sse', evidence };
    const report = buildReport({ schemaVersion: 1, observations: [observation] });
    assert.deepEqual(sseResults(report).map(({ status }) => status),
      ['not_verified', 'not_verified', 'not_verified', 'not_verified']);
    assert.deepEqual(report.observations, [observation]);
    assert.deepEqual(buildReport({ schemaVersion: report.schemaVersion, observations: report.observations }), report);
    const detail = sseResults(report)[0].detail;
    if (evidence === null) assert.match(detail, /no usable evidence/);
    else assert.match(detail, /exact diagnostic is preserved in the observation/);
  }
});

test('SSE session evidence evaluates the initial connection and every POST, then round trips canonically', () => {
  const observation = sseSessionObservation();
  observation.evidence.redirectSource = {
    origin: 'http://127.0.0.1:43188',
    pathname: '/conformance/sse-redirect',
    query: [['source', 'redirect']],
    headers: { 'x-apc-fixture': null, accept: 'text/event-stream' },
  };
  const report = buildReport({ schemaVersion: 1, observations: [observation] });
  assert.deepEqual(sseResults(report).map(({ status }) => status), ['pass', 'pass', 'pass', 'pass']);
  assert.deepEqual(report.observations, [observation]);
  assert.deepEqual(buildReport({ schemaVersion: report.schemaVersion, observations: report.observations }), report);

  observation.evidence.connection.query[0][1] = 'changed-after-report';
  observation.evidence.redirectSource.headers.accept = 'changed-after-report';
  observation.evidence.messages[0].headers['x-apc-fixture'] = 'changed-after-report';
  assert.equal(report.observations[0].evidence.connection.query[0][1], '$APC_SSE_VALUE');
  assert.equal(report.observations[0].evidence.redirectSource.headers.accept, 'text/event-stream');
  assert.equal(report.observations[0].evidence.messages[0].headers['x-apc-fixture'], SSE_LITERAL_HEADER);
});

test('SSE literal POST evidence requires same-origin messages and retains an earlier wrong header', () => {
  const empty = sseSessionObservation();
  empty.evidence.messages = [];
  assert.equal(sseResults(buildReport({ schemaVersion: 1, observations: [empty] }))[3].status, 'not_verified');

  const unexpectedOrigin = sseSessionObservation();
  unexpectedOrigin.evidence.messages[0].origin = 'http://127.0.0.1:43188';
  assert.equal(sseResults(buildReport({ schemaVersion: 1, observations: [unexpectedOrigin] }))[3].status, 'not_verified');

  const wrongThenCorrect = sseSessionObservation();
  wrongThenCorrect.evidence.messages[0].headers['x-apc-fixture'] = 'expanded';
  const result = sseResults(buildReport({ schemaVersion: 1, observations: [wrongThenCorrect] }))[3];
  assert.equal(result.status, 'fail');
  assert.match(result.detail, /POST message 0/);
  assert.match(result.detail, /expected .*; observed "expanded"/);
});

const precedenceResult = (report) => result(report, 'mcp.sse.headers.generated-precedence');
const precedenceObservation = (accept = 'text/event-stream') => {
  const observation = sseSessionObservation();
  observation.server = 'sse-header-precedence';
  observation.evidence.connection.headers.accept = accept;
  return observation;
};

test('SSE generated Accept precedence passes only when the conflict preserves the exact baseline', () => {
  const baseline = sseSessionObservation();
  baseline.evidence.connection.headers.accept = 'text/event-stream, application/json;q=0.1';
  const conflict = precedenceObservation(baseline.evidence.connection.headers.accept);
  const report = buildReport({ schemaVersion: 1, observations: [conflict, baseline] });
  assert.equal(precedenceResult(report).status, 'pass');
  assert.deepEqual(report.observations.filter(({ kind }) => kind === 'mcp-sse'), [baseline, conflict]);
  assert.deepEqual(buildReport({ schemaVersion: report.schemaVersion, observations: report.observations }), report);
});

test('SSE configured Accept sentinel fails with case-insensitive media-type parsing', () => {
  for (const accept of [
    'application/x-apc-configured',
    'Application/X-APC-Configured; q=0.5',
    'text/event-stream, APPLICATION/X-APC-CONFIGURED ; charset=utf-8',
  ]) {
    const report = buildReport({
      schemaVersion: 1,
      observations: [sseSessionObservation(), precedenceObservation(accept)],
    });
    assert.equal(precedenceResult(report).status, 'fail', accept);
  }
});

test('SSE generated Accept precedence leaves missing or ambiguous comparisons unverified', () => {
  const baseline = sseSessionObservation();
  const conflict = precedenceObservation();
  const oldRequest = sseObservation();
  const cases = [
    [],
    [baseline],
    [conflict],
    [oldRequest, conflict],
    [baseline, { ...oldRequest, server: 'sse-header-precedence' }],
    [{ ...baseline, evidence: { ...baseline.evidence, connection: { ...baseline.evidence.connection, origin: 'http://127.0.0.1:43188' } } }, conflict],
    [baseline, { ...conflict, evidence: { ...conflict.evidence, connection: { ...conflict.evidence.connection, origin: 'http://127.0.0.1:43188' } } }],
  ];
  for (const observations of cases) {
    assert.equal(precedenceResult(buildReport({ schemaVersion: 1, observations })).status, 'not_verified');
  }

  for (const [baselineAccept, conflictAccept] of [
    [null, 'text/event-stream'],
    ['application/x-apc-configured', 'application/x-apc-configured'],
    ['Application/X-APC-Configured; q=0', 'text/event-stream'],
    ['text/event-stream', null],
    ['text/event-stream', 'text/event-stream '],
    ['text/event-stream', 'application/x-apc-configured-other'],
  ]) {
    const generated = sseSessionObservation();
    generated.evidence.connection.headers.accept = baselineAccept;
    const configured = precedenceObservation(conflictAccept);
    assert.equal(precedenceResult(buildReport({
      schemaVersion: 1, observations: [generated, configured],
    })).status, 'not_verified', JSON.stringify({ baselineAccept, conflictAccept }));
  }
});

const redirectResult = (report) => result(report, 'mcp.sse.headers.cross-origin-redirect');
const sseRedirectObservation = (destinationHeader = null) => {
  const observation = sseSessionObservation();
  observation.server = 'sse-redirect';
  observation.evidence.connection = {
    origin: 'http://127.0.0.1:43189',
    pathname: '/conformance/sse-redirect',
    query: [['correlation', 'destination-id']],
    headers: { 'x-apc-fixture': destinationHeader, accept: 'text/event-stream' },
  };
  observation.evidence.redirectSource = {
    origin: SSE_ORIGIN,
    pathname: '/conformance/sse-redirect',
    query: [['correlation', 'source-id']],
    headers: { 'x-apc-fixture': 'public SSE redirect fixture value', accept: 'text/event-stream' },
  };
  return observation;
};

test('SSE cross-origin redirect passes only when the destination GET omits the configured header', () => {
  const observation = sseRedirectObservation();
  observation.evidence.messages[0].headers['x-apc-fixture'] = 'irrelevant POST header';
  const report = buildReport({ schemaVersion: 1, observations: [observation] });
  assert.equal(redirectResult(report).status, 'pass');
  assert.deepEqual(report.observations, [observation]);
  assert.deepEqual(buildReport({ schemaVersion: report.schemaVersion, observations: report.observations }), report);

  for (const destinationHeader of ['public SSE redirect fixture value', SSE_LITERAL_HEADER, 'other']) {
    assert.equal(redirectResult(buildReport({
      schemaVersion: 1, observations: [sseRedirectObservation(destinationHeader)],
    })).status, 'fail');
  }
});

test('SSE cross-origin redirect requires the expected source and destination route witnesses', () => {
  const changes = [
    (evidence) => { evidence.redirectSource = null; },
    (evidence) => { evidence.redirectSource.origin = 'http://127.0.0.1:43188'; },
    (evidence) => { evidence.redirectSource.pathname = '/other'; },
    (evidence) => { evidence.redirectSource.headers['x-apc-fixture'] = null; },
    (evidence) => { evidence.redirectSource.headers['x-apc-fixture'] = 'wrong'; },
    (evidence) => { evidence.connection.origin = SSE_ORIGIN; },
    (evidence) => { evidence.connection.pathname = '/other'; },
  ];
  for (const change of changes) {
    const observation = sseRedirectObservation();
    change(observation.evidence);
    assert.equal(redirectResult(buildReport({ schemaVersion: 1, observations: [observation] })).status,
      'not_verified');
  }
});

test('SSE cross-origin redirect accepts only a scoped redirect-refused classification', () => {
  for (const evidence of [
    null,
    sseObservation().evidence,
    { type: 'error', message: 'native redirect failed', classification: null },
  ]) {
    const observation = { kind: 'mcp-sse', server: 'sse-redirect', evidence };
    assert.equal(redirectResult(buildReport({ schemaVersion: 1, observations: [observation] })).status,
      'not_verified');
  }
  const refused = {
    kind: 'mcp-sse', server: 'sse-redirect',
    evidence: { type: 'error', message: 'client refused cross-origin redirect', classification: 'redirect-refused' },
  };
  const report = buildReport({ schemaVersion: 1, observations: [refused] });
  assert.equal(redirectResult(report).status, 'pass');
  assert.deepEqual(report.observations, [refused]);

  for (const server of ['sse', 'sse-header-precedence']) {
    assert.throws(() => buildReport({
      schemaVersion: 1, observations: [{ ...refused, server }],
    }), /classification: expected null/);
  }
});

const endpointResult = (report) => result(report, 'mcp.sse.headers.cross-origin-endpoint');
const sseEndpointObservation = () => {
  const observation = sseSessionObservation();
  observation.server = 'sse-endpoint-origin';
  observation.evidence.connection = {
    origin: SSE_ORIGIN,
    pathname: '/conformance/sse-endpoint-origin',
    query: [['value', '$APC_SSE_ENDPOINT_VALUE']],
    headers: { 'x-apc-fixture': 'public SSE endpoint fixture value', accept: 'text/event-stream' },
  };
  observation.evidence.redirectSource = null;
  observation.evidence.messages = [
    { origin: 'http://127.0.0.1:43189', headers: { 'x-apc-fixture': null } },
    { origin: 'http://127.0.0.1:43189', headers: { 'x-apc-fixture': null } },
  ];
  return observation;
};

test('SSE cross-origin endpoint passes only when every known endpoint message omits the configured header', () => {
  const observation = sseEndpointObservation();
  const report = buildReport({ schemaVersion: 1, observations: [observation] });
  assert.equal(endpointResult(report).status, 'pass');
  assert.deepEqual(report.observations, [observation]);
  assert.deepEqual(buildReport({ schemaVersion: report.schemaVersion, observations: report.observations }), report);

  const earlyLeak = sseEndpointObservation();
  earlyLeak.evidence.messages[0].headers['x-apc-fixture'] = 'public SSE endpoint fixture value';
  assert.equal(endpointResult(buildReport({ schemaVersion: 1, observations: [earlyLeak] })).status, 'fail');

  const leakAndUnknown = sseEndpointObservation();
  leakAndUnknown.evidence.messages[0].headers['x-apc-fixture'] = 'public SSE endpoint fixture value';
  leakAndUnknown.evidence.messages[1].origin = 'http://127.0.0.1:43190';
  assert.equal(endpointResult(buildReport({ schemaVersion: 1, observations: [leakAndUnknown] })).status, 'fail');
});

test('SSE cross-origin endpoint requires a direct connection witness and known endpoint origins', () => {
  const changes = [
    (evidence) => { evidence.redirectSource = sseConnection(); },
    (evidence) => { evidence.connection.origin = 'http://127.0.0.1:43188'; },
    (evidence) => { evidence.connection.pathname = '/other'; },
    (evidence) => { evidence.connection.headers['x-apc-fixture'] = null; },
    (evidence) => { evidence.connection.headers['x-apc-fixture'] = 'wrong'; },
    (evidence) => { evidence.messages = []; },
    (evidence) => { evidence.messages[0].origin = 'http://127.0.0.1:43190'; },
  ];
  for (const change of changes) {
    const observation = sseEndpointObservation();
    change(observation.evidence);
    assert.equal(endpointResult(buildReport({ schemaVersion: 1, observations: [observation] })).status,
      'not_verified');
  }
});

test('SSE cross-origin endpoint accepts only a scoped endpoint-refused classification', () => {
  for (const evidence of [
    null,
    sseObservation().evidence,
    { type: 'error', message: 'native endpoint failed', classification: null },
  ]) {
    const observation = { kind: 'mcp-sse', server: 'sse-endpoint-origin', evidence };
    assert.equal(endpointResult(buildReport({ schemaVersion: 1, observations: [observation] })).status,
      'not_verified');
  }
  const refused = {
    kind: 'mcp-sse', server: 'sse-endpoint-origin',
    evidence: { type: 'error', message: 'client refused cross-origin endpoint', classification: 'endpoint-refused' },
  };
  const report = buildReport({ schemaVersion: 1, observations: [refused] });
  assert.equal(endpointResult(report).status, 'pass');
  assert.deepEqual(report.observations, [refused]);

  for (const [server, classification, pattern] of [
    ['sse', 'endpoint-refused', /classification: expected null/],
    ['sse-header-precedence', 'endpoint-refused', /classification: expected null/],
    ['sse-redirect', 'endpoint-refused', /classification: expected redirect-refused or null/],
    ['sse-endpoint-origin', 'redirect-refused', /classification: expected endpoint-refused or null/],
  ]) {
    assert.throws(() => buildReport({
      schemaVersion: 1,
      observations: [{ ...refused, server, evidence: { ...refused.evidence, classification } }],
    }), pattern);
  }
  const http = httpObservation();
  http.evidence = { type: 'error', message: 'endpoint refused', classification: 'endpoint-refused' };
  assert.throws(() => buildReport({ schemaVersion: 1, observations: [http] }), /classification/);
});

test('SSE session evidence rejects malformed nested fields and is not accepted for Streamable HTTP', () => {
  const malformed = [
    (evidence) => { evidence.extra = true; },
    (evidence) => { evidence.version = 2; },
    (evidence) => { delete evidence.connection; },
    (evidence) => { evidence.connection.extra = true; },
    (evidence) => { evidence.connection.origin = null; },
    (evidence) => { evidence.connection.query = [['value']]; },
    (evidence) => { delete evidence.connection.headers.accept; },
    (evidence) => { evidence.connection.headers.accept = false; },
    (evidence) => { evidence.redirectSource = {}; },
    (evidence) => { evidence.messages = {}; },
    (evidence) => { delete evidence.messages[0].origin; },
    (evidence) => { evidence.messages[0].origin = null; },
    (evidence) => { evidence.messages[0].headers.extra = true; },
    (evidence) => { delete evidence.messages[0].headers['x-apc-fixture']; },
    (evidence) => { evidence.messages[0].headers['x-apc-fixture'] = false; },
  ];
  for (const modify of malformed) {
    const observation = sseSessionObservation();
    modify(observation.evidence);
    assert.throws(() => buildReport({ schemaVersion: 1, observations: [observation] }), TypeError);
  }
  const http = httpObservation();
  http.evidence = sseSessionObservation().evidence;
  assert.throws(() => buildReport({ schemaVersion: 1, observations: [http] }), /expected one of: request, error/);
});

test('SSE observations reject malformed schemas, noncanonical identities, health fields, and duplicates', () => {
  const malformed = [
    (value) => { value.server = 'http'; },
    (value) => { delete value.evidence; },
    (value) => { value.serverHealthCheck = 'passed'; },
    (value) => { value.evidence.version = 2; },
    (value) => { value.evidence.pathname = null; },
    (value) => { value.evidence.query = [['value']]; },
    (value) => { value.evidence.query = [[1, '$APC_SSE_VALUE']]; },
    (value) => { value.evidence.headers = {}; },
    (value) => { value.evidence.headers.authorization = 'unrelated'; },
    (value) => { value.evidence.headers['x-apc-fixture'] = false; },
  ];
  for (const modify of malformed) {
    const observation = sseObservation();
    modify(observation);
    assert.throws(() => buildReport({ schemaVersion: 1, observations: [observation] }), TypeError);
  }
  const classifiedError = {
    kind: 'mcp-sse', server: 'sse',
    evidence: { type: 'error', message: 'refused', classification: 'redirect-refused' },
  };
  assert.throws(() => buildReport({ schemaVersion: 1, observations: [classifiedError] }), /classification: expected null/);
  assert.throws(() => buildReport({
    schemaVersion: 1, observations: [sseObservation(), sseObservation()],
  }), /duplicate mcp-sse observation: sse/);
});

test('invalid HTTP servers require exclusion discovery and both successful recovery controls', () => {
  const recoveryRuntime = recoveryObservations()[1];
  for (const [server, id] of invalidHttpServerCases) {
    const absent = invalidServerDiscovery(server, false);
    const advertised = invalidServerDiscovery(server, true);
    for (const [observations, status] of [
      [[], 'not_verified'],
      [[absent], 'not_verified'],
      [[recoveryRuntime, httpObservation()], 'not_verified'],
      [[absent, recoveryRuntime], 'not_verified'],
      [[absent, httpObservation()], 'not_verified'],
      [[absent, recoveryRuntime, httpError('http')], 'not_verified'],
      [[absent, recoveryRuntime, invalidHttpRuntime('http', null)], 'not_verified'],
      [[absent, recoveryRuntime, httpObservation()], 'pass'],
      [[absent, recoveryRuntime, { ...httpObservation(), serverHealthCheck: 'failed' }], 'pass'],
      [[advertised], 'fail'],
      [[advertised, recoveryRuntime, httpObservation()], 'fail'],
      [[invalidHttpRuntime(server)], 'fail'],
      [[absent, invalidHttpRuntime(server)], 'fail'],
      [[absent, recoveryRuntime, httpObservation(), invalidHttpRuntime(server)], 'fail'],
      [[absent, recoveryRuntime, httpObservation(), httpError(server)], 'not_verified'],
      [[absent, recoveryRuntime, httpObservation(), {
        ...invalidHttpRuntime(server, null), serverHealthCheck: 'failed',
      }], 'not_verified'],
      [[advertised, recoveryRuntime, httpObservation(), httpError(server)], 'fail'],
      [[advertised, recoveryRuntime, httpObservation(), invalidHttpRuntime(server, null)], 'fail'],
    ]) {
      const report = buildReport({ schemaVersion: 1, observations });
      assert.equal(result(report, id).status, status, `${server}: ${JSON.stringify(observations)}`);
    }
  }
});

test('invalid HTTP server evidence is evaluated independently across server identities', () => {
  const recoveryRuntime = recoveryObservations()[1];
  const controls = [recoveryRuntime, { ...httpObservation(), serverHealthCheck: 'failed' }];
  const discoveries = invalidHttpServerCases.map(([server]) => invalidServerDiscovery(server, false));
  const baseline = buildReport({ schemaVersion: 1, observations: [...discoveries, ...controls] });
  for (const [, id] of invalidHttpServerCases) assert.equal(result(baseline, id).status, 'pass');

  for (const [failedServer, failedId] of invalidHttpServerCases) {
    const report = buildReport({
      schemaVersion: 1,
      observations: [...discoveries, ...controls, invalidHttpRuntime(failedServer)],
    });
    assert.equal(result(report, failedId).status, 'fail');
    for (const [server, id] of invalidHttpServerCases) {
      if (server !== failedServer) assert.equal(result(report, id).status, 'pass');
    }
    assert.deepEqual(buildReport({ schemaVersion: 1, observations: report.observations }), report);
  }
});

test('invalid HTTP discovery and runtime schemas are strict and independently unique', () => {
  for (const [server] of invalidHttpServerCases) {
    const discovery = invalidServerDiscovery(server, false);
    assert.doesNotThrow(() => buildReport({ schemaVersion: 1, observations: [discovery] }));
    assert.throws(() => buildReport({
      schemaVersion: 1, observations: [discovery, invalidServerDiscovery(server, true)],
    }), /duplicate/);

    const valid = invalidHttpRuntime(server);
    for (const modify of [
      (value) => { value.evidence.version = 2; },
      (value) => { value.serverHealthCheck = 'unknown'; },
    ]) {
      const malformed = structuredClone(valid);
      modify(malformed);
      assert.throws(() => buildReport({ schemaVersion: 1, observations: [malformed] }), TypeError);
    }
    assert.throws(() => buildReport({ schemaVersion: 1, observations: [valid, structuredClone(valid)] }), /duplicate/);
  }
  assert.doesNotThrow(() => buildReport({
    schemaVersion: 1,
    observations: invalidHttpServerCases.map(([server]) => invalidHttpRuntime(server)),
  }));
});

test('invalid SSE servers require exclusion discovery and successful stdio and SSE controls', () => {
  const recoveryRuntime = recoveryObservations()[1];
  for (const [server, id] of invalidSseServerCases) {
    const absent = invalidServerDiscovery(server, false);
    const advertised = invalidServerDiscovery(server, true);
    for (const [observations, status] of [
      [[], 'not_verified'],
      [[absent], 'not_verified'],
      [[recoveryRuntime, sseObservation()], 'not_verified'],
      [[absent, recoveryRuntime], 'not_verified'],
      [[absent, sseObservation()], 'not_verified'],
      [[absent, recoveryRuntime, { kind: 'mcp-sse', server: 'sse', evidence: null }], 'not_verified'],
      [[absent, recoveryRuntime, { kind: 'mcp-sse', server: 'sse', evidence: {
        type: 'error', message: 'unsupported transport', classification: null,
      } }], 'not_verified'],
      [[absent, recoveryRuntime, sseObservation()], 'pass'],
      [[absent, recoveryRuntime, sseSessionObservation()], 'pass'],
      [[advertised], 'fail'],
      [[advertised, recoveryRuntime, sseObservation()], 'fail'],
      [[invalidSseRuntime(server)], 'fail'],
      [[{ ...sseSessionObservation(), server }], 'fail'],
      [[absent, invalidSseRuntime(server)], 'fail'],
      [[absent, recoveryRuntime, sseObservation(), invalidSseRuntime(server)], 'fail'],
      [[absent, recoveryRuntime, sseSessionObservation(), { ...sseSessionObservation(), server }], 'fail'],
      [[absent, recoveryRuntime, sseObservation(), {
        kind: 'mcp-sse', server, evidence: { type: 'error', message: 'native error', classification: null },
      }], 'not_verified'],
      [[advertised, recoveryRuntime, sseObservation(), { kind: 'mcp-sse', server, evidence: null }], 'fail'],
    ]) {
      const report = buildReport({ schemaVersion: 1, observations });
      assert.equal(result(report, id).status, status, `${server}: ${JSON.stringify(observations)}`);
    }
  }
});

test('invalid SSE server evidence is evaluated independently across server identities', () => {
  const controls = [recoveryObservations()[1], sseObservation()];
  const discoveries = invalidSseServerCases.map(([server]) => invalidServerDiscovery(server, false));
  const baseline = buildReport({ schemaVersion: 1, observations: [...discoveries, ...controls] });
  for (const [, id] of invalidSseServerCases) assert.equal(result(baseline, id).status, 'pass');

  for (const [failedServer, failedId] of invalidSseServerCases) {
    const report = buildReport({
      schemaVersion: 1,
      observations: [...discoveries, ...controls, invalidSseRuntime(failedServer)],
    });
    assert.equal(result(report, failedId).status, 'fail');
    for (const [server, id] of invalidSseServerCases) {
      if (server !== failedServer) assert.equal(result(report, id).status, 'pass');
    }
    assert.deepEqual(buildReport({ schemaVersion: 1, observations: report.observations }), report);
  }
});

test('invalid SSE discovery and runtime schemas are strict and independently unique', () => {
  for (const [server] of invalidSseServerCases) {
    const discovery = invalidServerDiscovery(server, false);
    assert.doesNotThrow(() => buildReport({ schemaVersion: 1, observations: [discovery] }));
    assert.throws(() => buildReport({
      schemaVersion: 1, observations: [discovery, invalidServerDiscovery(server, true)],
    }), /duplicate/);

    const valid = invalidSseRuntime(server);
    const malformed = structuredClone(valid);
    malformed.evidence.version = 2;
    assert.throws(() => buildReport({ schemaVersion: 1, observations: [malformed] }), TypeError);
    assert.throws(() => buildReport({ schemaVersion: 1, observations: [valid, structuredClone(valid)] }), /duplicate/);
  }
  assert.doesNotThrow(() => buildReport({
    schemaVersion: 1,
    observations: invalidSseServerCases.map(([server]) => invalidSseRuntime(server)),
  }));
});
