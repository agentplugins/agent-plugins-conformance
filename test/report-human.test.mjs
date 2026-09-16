import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReport, formatReport } from '../plugins/core/src/report.mjs';

function input() {
  const root = '/fixture/plugin';
  const data = '/state/plugin';
  return {
    schemaVersion: 1, runId: 'test-run', client: { name: 'Test client', version: '1.0' },
    observations: [
      ...['guide', 'alpha', 'beta'].map((name) => ({ kind: 'skill', skill: `conformance-${name}`, marker: `APC_${name.toUpperCase()}_V1` })),
      ...['default', 'relative', 'root', 'data'].map((server) => ({
        kind: 'runtime', server,
        evidence: {
          version: 1, runId: 'test-run', server, root, resolvedData: data,
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
    'Client: Test client, version 1.0',
    'Run: test-run',
    '',
    'Checks       Passed  Failed  Not verified',
    'Skills            3       0             0',
    'MCP              13       0             0',
  ].join('\n'));
});

test('all-unverified human report groups absent observations by component', () => {
  const value = input();
  value.observations = [];
  const human = formatReport(buildReport(value));
  assert.match(human, /Skills\s+0\s+0\s+3/);
  assert.match(human, /MCP\s+0\s+0\s+13/);
  assert.match(human, /Skills: conformance-guide, conformance-alpha, conformance-beta — no observations\./);
  assert.match(human, /MCP servers: default, relative, root, data — no runtime observations\./);
  assert.doesNotMatch(human, /not_verified|No observation supplied|\nFailed\n|\(mcp\.|\(skills\./);
});

test('mixed human report puts useful failures before grouped missing observations', () => {
  const value = input();
  value.observations = [value.observations[3]];
  value.observations[0].evidence.env.APC_VALUE = 'incorrect configured value';
  const human = formatReport(buildReport(value));
  assert.match(human, /MCP\s+6\s+1\s+6/);
  assert.match(human, /Configured environment \(mcp.stdio.env.configured-value\)/);
  assert.match(human, /"fixture value with spaces"/);
  assert.match(human, /"incorrect configured value"/);
  assert.ok(human.indexOf('\nFailed\n') < human.indexOf('\nNot verified\n'));
  assert.match(human, /MCP servers: relative, root, data — no runtime observations\./);
  assert.doesNotMatch(human, /MCP servers: default/);
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
  assert.doesNotMatch(human, /no observations|no runtime observations/);
});

test('human metadata and diagnostic values cannot inject terminal controls or fake lines', () => {
  const value = input();
  value.client.name = 'Client\nFAKE PASS';
  value.client.version = '1\r2';
  value.runId = 'run\tname\x1b[2J\x7f';
  for (const observation of value.observations.filter(({ kind }) => kind === 'runtime')) observation.evidence.runId = value.runId;
  value.observations[3].evidence.env.APC_VALUE = 'wrong\nFAKE PASS\x1b[2J\x85';
  const human = formatReport(buildReport(value));
  assert.match(human, /Client: Client\\nFAKE PASS, version 1\\r2/);
  assert.match(human, /Run: run\\tname\\u001b\[2J\\u007f/);
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
    const missing = servers.filter((_, index) => !(included & (1 << index)));
    if (missing.length) {
      assert.ok(human.includes(`MCP servers: ${missing.join(', ')} — no runtime observations.`));
    } else {
      assert.doesNotMatch(human, /no runtime observations/);
    }
    for (const { id, status, detail } of report.results) {
      if (status !== 'not_verified') continue;
      assert.equal(human.includes(`(${id})`), detail !== 'No observation supplied.', id);
    }
    assert.doesNotMatch(human, /No observation supplied/);
  }
});
