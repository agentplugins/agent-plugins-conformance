import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReport } from '../plugins/agent-plugins-conformance/src/report.mjs';
import { formatReport } from '../plugins/agent-plugins-conformance/src/report-format.mjs';

function input() {
  const root = '/fixture/plugin';
  const data = '/state/plugin';
  return {
    schemaVersion: 1,
    observations: [
      ...['alpha', 'beta'].map((name) => ({ kind: 'skill', skill: `conformance-${name}`, marker: `APC_${name.toUpperCase()}_V1` })),
      ...['default', 'relative', 'root', 'data'].map((server) => ({
        kind: 'mcp-stdio', server,
        evidence: {
          version: 1, server, root, resolvedData: data,
          ...(server === 'default' ? { dataWrite: { path: `${data}/.agent-plugins-conformance-write-test`, error: null, cleanupError: null } } : {}),
          cwd: server === 'default' ? root : server === 'data' ? data : `${root}/probe-workdir`,
          argv: ['default', 'arg with spaces', '', root, data, '${APC_UNKNOWN}', '$APC_VALUE', '${PLUGIN_ROOT_SUFFIX}'],
          env: { PLUGIN_ROOT: root, PLUGIN_DATA: data, APC_VALUE: 'fixture value with spaces',
            APC_EXPANSION: `${root}|${data}|${root}`, APC_LITERAL: '${APC_UNKNOWN}|$APC_VALUE|${PLUGIN_ROOT_SUFFIX}' },
        },
      })),
      {
        kind: 'mcp-stdio', server: 'command-token-posix',
        evidence: {
          version: 1, server: 'command-token-posix', root, cwd: root, resolvedData: data,
          argv: ['command-token-posix', 'posix-exact', 'intact', 'arg with spaces', '', 'literal-value'], env: {},
        },
      },
      { kind: 'skill-discovery', skill: 'conformance-nested', advertised: false },
    ],
  };
}

function addRecovery(value) {
  value.observations.push(
    { kind: 'skill', skill: 'conformance-recovery-valid', marker: 'APC_RECOVERY_VALID_V1' },
    { kind: 'skill', skill: 'conformance-invalid-mcp-valid', marker: 'APC_INVALID_MCP_VALID_V1' },
    { kind: 'mcp-stdio', server: 'recovery-valid', evidence: {
      version: 1, server: 'recovery-valid', resolvedData: '/state/recovery', symlinkCwd: 'symlink',
    } },
    { kind: 'mcp-discovery', server: 'recovery-cwd-escape', advertised: false },
    { kind: 'mcp-discovery', server: 'recovery-cwd-data-escape', advertised: false },
    { kind: 'mcp-discovery', server: 'recovery-unknown-field', advertised: false },
    { kind: 'mcp-discovery', server: 'recovery-env-plugin-root', advertised: false },
    { kind: 'mcp-discovery', server: 'recovery-env-plugin-data', advertised: false },
    { kind: 'mcp-discovery', server: 'recovery-cwd-symlink-escape', advertised: false },
    { kind: 'mcp-discovery', server: 'recovery-cwd-invalid-form', advertised: false },
    { kind: 'mcp-discovery', server: 'recovery-missing-type', advertised: false },
  );
  return value;
}

test('complete stdio and recovery evidence leaves optional HTTP and SSE checks unverified', () => {
  const human = formatReport(buildReport(addRecovery(input())));
  assert.equal(human.split('\n\nNot verified\n')[0], [
    'Agent Plugins conformance — spec 1.0.0',
    '',
    'Checks       Passed  Failed  Not verified',
    'Skills            3       0             0',
    'MCP              22       0            26',
    'Filesystem        4       0             0',
    'Total            29       0            26',
  ].join('\n'));
  const missing = human.split('\n\nNot verified\n')[1];
  for (const id of [
    'mcp.streamable-http.tool-availability',
    'mcp.streamable-http.url.literal-route-and-query',
    'mcp.streamable-http.headers.cross-origin-redirect',
    'mcp.streamable-http.headers.literal-value',
    'mcp.config.legacy-http-type',
    'mcp.streamable-http.url.non-loopback-http',
    'mcp.streamable-http.url.relative',
    'mcp.streamable-http.url.fragment',
    'mcp.streamable-http.headers.duplicate-names',
    'mcp.streamable-http.url.userinfo',
    'mcp.streamable-http.headers.invalid-name',
    'mcp.streamable-http.headers.invalid-value',
    'mcp.sse.tool-availability',
    'mcp.sse.url.literal-route-and-query',
    'mcp.sse.headers.literal-value',
    'mcp.sse.headers.literal-post-value',
    'mcp.sse.headers.generated-precedence',
    'mcp.sse.headers.cross-origin-redirect',
    'mcp.sse.headers.cross-origin-endpoint',
    'mcp.sse.url.non-loopback-http',
    'mcp.sse.url.relative',
    'mcp.sse.url.fragment',
    'mcp.sse.url.userinfo',
    'mcp.sse.headers.duplicate-names',
    'mcp.sse.headers.invalid-name',
    'mcp.sse.headers.invalid-value',
  ]) assert.ok(missing.includes(`(${id})`));
  assert.doesNotMatch(missing, /\(mcp\.stdio\.|\(skills\./);
});

test('all-unverified human report preserves every saved missing-evidence result', () => {
  const value = input();
  value.observations = [];
  const human = formatReport(buildReport(value));
  assert.match(human, /Skills\s+0\s+0\s+3/);
  assert.match(human, /MCP\s+0\s+0\s+48/);
  assert.match(human, /Filesystem\s+0\s+0\s+4/);
  assert.match(human, /Missing skill observations: conformance-alpha, conformance-beta\./);
  for (const result of buildReport(value).results) assert.ok(human.includes(`(${result.id})`));
  assert.doesNotMatch(human, /not_verified|\nFailed\n/);
});

test('mixed human report puts failures before missing-evidence details', () => {
  const value = input();
  value.observations = [value.observations[2]];
  value.observations[0].evidence.env.APC_VALUE = 'incorrect configured value';
  const human = formatReport(buildReport(value));
  assert.match(human, /MCP\s+6\s+1\s+41/);
  assert.match(human, /Filesystem\s+1\s+0\s+3/);
  assert.match(human, /Configured environment \(mcp.stdio.env.configured-value\)/);
  assert.match(human, /"fixture value with spaces"/);
  assert.match(human, /"incorrect configured value"/);
  assert.ok(human.indexOf('\nFailed\n') < human.indexOf('\nNot verified\n'));
  assert.match(human, /\(mcp.stdio.cwd.plugin-relative\)/);
});

test('unverified checks with supplied observations keep their individual reasons', () => {
  const value = input();
  delete value.observations[2].evidence.env.PLUGIN_DATA;
  value.observations[2].evidence.dataWrite = null;
  value.observations[5].evidence.resolvedData = null;
  const human = formatReport(buildReport(value));
  assert.match(human, /Argument preservation and expansion \(mcp.stdio.args.preservation-and-expansion\)/);
  assert.match(human, /Environment expansion \(mcp.stdio.env.expansion\)/);
  assert.match(human, /data working directory \(mcp.stdio.cwd.plugin-data\)/);
  assert.match(human, /Consistent data directory within a plugin \(filesystem.data.consistent-within-plugin\)/);
  assert.match(human, /PLUGIN_DATA is missing; expected expansion cannot be computed\./);
  assert.match(human, /PLUGIN_DATA could not be resolved/);
  assert.match(human, /Resolved PLUGIN_DATA unavailable for: data\./);
});

test('human diagnostic values cannot inject terminal controls or fake lines', () => {
  const value = input();
  value.observations[2].evidence.env.APC_VALUE = 'wrong\nFAKE PASS\x1b[2J\x85';
  const human = formatReport(buildReport(value));
  assert.match(human, /wrong\\nFAKE PASS\\u001b\[2J\\u0085/);
  assert.doesNotMatch(human, /[\x00-\x09\x0b-\x1f\x7f-\x9f]/);
  assert.doesNotMatch(human, /\nFAKE PASS/);
});

test('partial runtime coverage never hides reasons from servers with supplied observations', () => {
  const servers = ['default', 'relative', 'root', 'data'];
  for (let included = 0; included < 16; included += 1) {
    const value = input();
    delete value.observations[2].evidence.env.PLUGIN_DATA;
    value.observations[2].evidence.dataWrite = null;
    value.observations[5].evidence.resolvedData = null;
    value.observations = value.observations.filter(({ kind, server }) =>
      kind === 'skill' || (included & (1 << servers.indexOf(server))));
    const report = buildReport(value);
    const human = formatReport(report);
    for (const { id, status, detail } of report.results) {
      if (status !== 'not_verified') continue;
      assert.ok(human.includes(`(${id})`), id);
      assert.ok(human.includes(detail), id);
    }
  }
});

test('human report renders saved warnings independently of result status', () => {
  const value = buildReport(input());
  const writable = value.results.find(({ id }) => id === 'filesystem.data.writable');
  writable.status = 'not_verified';
  writable.warning = 'Saved cleanup warning for /state/plugin/leftover.';
  value.summary = { pass: 16, fail: 0, not_verified: 39, total: 55 };
  value.observations = [];

  const human = formatReport(value);
  assert.match(human, /\nWarnings\n/);
  assert.match(human, /Plugin data writability \(filesystem\.data\.writable\)/);
  assert.match(human, /Saved cleanup warning for \/state\/plugin\/leftover\./);
  assert.match(human, /\nNot verified\n/);
});


test('failed skill discovery shows incorrect and missing skills together regardless of MCP coverage', () => {
  for (const includeMcp of [false, true]) {
    const value = input();
    value.observations[0].marker = 'incorrect alpha';
    value.observations.splice(1, 1);
    if (!includeMcp) value.observations = value.observations.filter(({ kind }) => kind === 'skill');
    const human = formatReport(buildReport(value));
    const failed = human.split('\nFailed\n')[1].split('\nNot verified\n')[0];
    assert.match(failed, /Immediate child skill discovery \(skills.discovery.immediate-children\)/);
    assert.match(failed, /conformance-alpha: expected "APC_ALPHA_V1"; observed "incorrect alpha"/);
    assert.match(failed, /Missing skill observations: conformance-beta\./);
    assert.match(human, /\nNot verified\n/);
    assert.match(human, /\(skills\.recovery\.valid-skill-available\)/);
    assert.match(human, /\(mcp\.stdio\.recovery\.valid-server-available\)/);
  }
});
