import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReport } from '../plugins/agent-plugins-conformance-core/src/report.mjs';
import { formatReport } from '../plugins/agent-plugins-conformance-core/src/report-format.mjs';

function input() {
  const root = '/fixture/plugin';
  const data = '/state/plugin';
  return {
    schemaVersion: 1,
    observations: [
      ...['guide', 'alpha', 'beta'].map((name) => ({ kind: 'skill', skill: `conformance-${name}`, marker: `APC_${name.toUpperCase()}_V1` })),
      ...['default', 'relative', 'root', 'data'].map((server) => ({
        kind: 'mcp-stdio', server,
        evidence: {
          version: 1, server, root, resolvedData: data,
          cwd: server === 'default' ? root : server === 'data' ? data : `${root}/probe-workdir`,
          argv: ['default', 'arg with spaces', '', root, data, '${APC_UNKNOWN}', '$APC_VALUE', '${PLUGIN_ROOT_SUFFIX}'],
          env: { PLUGIN_ROOT: root, PLUGIN_DATA: data, APC_VALUE: 'fixture value with spaces',
            APC_EXPANSION: `${root}|${data}|${root}`, APC_LITERAL: '${APC_UNKNOWN}|$APC_VALUE|${PLUGIN_ROOT_SUFFIX}' },
        },
      })),
    ],
  };
}

test('all-pass human report contains a compact check table and no empty sections', () => {
  const human = formatReport(buildReport(input()));
  assert.equal(human, [
    'Agent Plugins conformance — spec 1.0.0',
    '',
    'Checks       Passed  Failed  Not verified',
    'Skills            1       0             0',
    'MCP              13       0             0',
    'Total            14       0             0',
  ].join('\n'));
});

test('all-unverified human report preserves every saved missing-evidence result', () => {
  const value = input();
  value.observations = [];
  const human = formatReport(buildReport(value));
  assert.match(human, /Skills\s+0\s+0\s+1/);
  assert.match(human, /MCP\s+0\s+0\s+13/);
  assert.match(human, /Missing skill observations: conformance-guide, conformance-alpha, conformance-beta\./);
  for (const result of buildReport(value).results) assert.ok(human.includes(`(${result.id})`));
  assert.doesNotMatch(human, /not_verified|\nFailed\n/);
});

test('mixed human report puts failures before missing-evidence details', () => {
  const value = input();
  value.observations = [value.observations[3]];
  value.observations[0].evidence.env.APC_VALUE = 'incorrect configured value';
  const human = formatReport(buildReport(value));
  assert.match(human, /MCP\s+6\s+1\s+6/);
  assert.match(human, /Configured environment \(mcp.stdio.env.configured-value\)/);
  assert.match(human, /"fixture value with spaces"/);
  assert.match(human, /"incorrect configured value"/);
  assert.ok(human.indexOf('\nFailed\n') < human.indexOf('\nNot verified\n'));
  assert.match(human, /\(mcp.stdio.cwd.plugin-relative\)/);
});

test('unverified checks with supplied observations keep their individual reasons', () => {
  const value = input();
  delete value.observations[3].evidence.env.PLUGIN_DATA;
  value.observations[6].evidence.resolvedData = null;
  const human = formatReport(buildReport(value));
  assert.match(human, /Argument preservation and expansion \(mcp.stdio.args.preservation-and-expansion\)/);
  assert.match(human, /Environment expansion \(mcp.stdio.env.expansion\)/);
  assert.match(human, /data working directory \(mcp.stdio.cwd.plugin-data\)/);
  assert.match(human, /PLUGIN_DATA is missing; expected expansion cannot be computed\./);
  assert.match(human, /PLUGIN_DATA could not be resolved/);
});

test('human diagnostic values cannot inject terminal controls or fake lines', () => {
  const value = input();
  value.observations[3].evidence.env.APC_VALUE = 'wrong\nFAKE PASS\x1b[2J\x85';
  const human = formatReport(buildReport(value));
  assert.match(human, /wrong\\nFAKE PASS\\u001b\[2J\\u0085/);
  assert.doesNotMatch(human, /[\x00-\x09\x0b-\x1f\x7f-\x9f]/);
  assert.doesNotMatch(human, /\nFAKE PASS/);
});


test('partial runtime coverage never hides reasons from servers with supplied observations', () => {
  const servers = ['default', 'relative', 'root', 'data'];
  for (let included = 0; included < 16; included += 1) {
    const value = input();
    delete value.observations[3].evidence.env.PLUGIN_DATA;
    value.observations[6].evidence.resolvedData = null;
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


test('failed skill discovery shows incorrect and missing skills together regardless of MCP coverage', () => {
  for (const includeMcp of [false, true]) {
    const value = input();
    value.observations[0].marker = 'incorrect guide';
    value.observations.splice(1, 1);
    if (!includeMcp) value.observations = value.observations.filter(({ kind }) => kind === 'skill');
    const human = formatReport(buildReport(value));
    const failed = human.split('\nFailed\n')[1].split('\nNot verified\n')[0];
    assert.match(failed, /Immediate child skill discovery \(skills.discovery.immediate-children\)/);
    assert.match(failed, /conformance-guide: expected "APC_GUIDE_V1"; observed "incorrect guide"/);
    assert.match(failed, /Missing skill observations: conformance-alpha\./);
    if (includeMcp) assert.doesNotMatch(human, /\nNot verified\n/);
  }
});
