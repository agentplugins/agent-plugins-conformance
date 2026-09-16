import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { buildReport, formatReport } from '../plugins/core/src/report.mjs';

// Reference fixture launcher only. This explicitly implements the expansion
// under test; it is NOT evidence that a third-party client loaded the plugin.
async function fixture(t) {
  const parent = await mkdtemp(join(tmpdir(), 'agent-plugins-conformance-'));
  const clients = [];
  t.after(async () => {
    try {
      const closed = await Promise.allSettled(clients.map((client) => client.close()));
      const failures = closed.filter(({ status }) => status === 'rejected').map(({ reason }) => reason);
      if (failures.length) throw new AggregateError(failures, 'MCP clients failed to close');
    } finally {
      // Windows locks a running process's cwd; close every client before removal.
      await rm(parent, { recursive: true, force: true });
    }
  });
  const root = join(await realpath(parent), 'plugin with spaces ${PLUGIN_DATA}');
  const data = join(await realpath(parent), 'data with spaces');
  await cp(new URL('../plugins/core', import.meta.url), root, { recursive: true });
  await cp(join(root, 'probe-workdir'), data, { recursive: true });
  const config = JSON.parse(await readFile(join(root, 'mcp.json'), 'utf8'));
  return { root, data, config, clients };
}
async function connect(fixture, mode, override = {}) {
  const config = fixture.config.mcpServers[mode];
  const variables = { PLUGIN_ROOT: fixture.root, PLUGIN_DATA: fixture.data };
  const expand = (value) => value.replace(/\$\{(PLUGIN_ROOT|PLUGIN_DATA)\}/g, (_, name) => variables[name]);
  const cwd = config.cwd ? (config.cwd.startsWith('./') ? join(fixture.root, config.cwd) : expand(config.cwd)) : fixture.root;
  const client = new Client({ name: 'conformance-reference-test', version: '1' });
  const transport = new StdioClientTransport({
    command: process.execPath, args: config.args.map(expand), cwd,
    env: { ...variables, ...Object.fromEntries(Object.entries(config.env ?? {}).map(([key, value]) => [key, expand(value)])), APC_SHOULD_NOT_LEAK: 'unrelated ambient sentinel' },
    stderr: 'pipe', ...override,
  });
  fixture.clients.push(client);
  await client.connect(transport);
  return client;
}
const input = (observations) => ({ schemaVersion: 1, runId: 'reference-test', client: { name: 'SDK reference harness', version: '1.30.0' }, observations });

test('copied plugin runs MCP probes and CLI reporting without node_modules', { timeout: 30_000 }, async (t) => {
  const files = await fixture(t);
  const observations = [];
  let defaultClient;
  for (const mode of ['default', 'relative', 'root', 'data']) {
    const client = await connect(files, mode);
    if (mode === 'default') defaultClient = client;
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map(({ name }) => name), mode === 'default' ? ['observe', 'report'] : ['observe']);
    const result = await client.callTool({ name: 'observe', arguments: { runId: 'reference-test' } });
    assert.ok(!result.isError);
    const observation = JSON.parse(result.content[0].text);
    assert.deepEqual(result.structuredContent, observation);
    assert.equal(observation.evidence.root, files.root);
    assert.equal(observation.evidence.env.APC_SHOULD_NOT_LEAK, undefined);
    observations.push(observation);
  }
  const reportInput = input(observations);
  const direct = buildReport(reportInput);
  assert.equal(direct.summary.fail, 0);
  assert.equal(direct.summary.pass, 13);
  assert.equal(direct.summary.not_verified, 1);
  const result = await defaultClient.callTool({ name: 'report', arguments: { input: reportInput } });
  assert.deepEqual(result.structuredContent, direct);
  assert.deepEqual(JSON.parse(result.content[1].text), direct);
  const repeated = await defaultClient.callTool({ name: 'report', arguments: { input: reportInput } });
  assert.deepEqual(repeated, result);

  // Exercise the shell fallback from the installed copy, outside the checkout.
  const filename = join(files.root, 'observations.json');
  await writeFile(filename, JSON.stringify(reportInput));
  const run = (...args) => spawnSync(process.execPath, ['src/report-cli.mjs', 'observations.json', ...args], { cwd: files.root, encoding: 'utf8', timeout: 10_000 });
  const json = run('--json');
  assert.equal(json.status, 0, json.stderr);
  assert.deepEqual(JSON.parse(json.stdout), direct);
  const human = run();
  assert.equal(human.status, 0, human.stderr);
  assert.equal(human.stdout.trim(), formatReport(direct));
});

test('actual process deviations are evaluated as failures, not missing evidence', { timeout: 30_000 }, async (t) => {
  const files = await fixture(t);
  const client = await connect(files, 'default', { cwd: files.data, env: { PLUGIN_ROOT: files.data } });
  const result = await client.callTool({ name: 'observe', arguments: { runId: 'reference-test' } });
  const report = buildReport(input([result.structuredContent]));
  for (const id of ['mcp.stdio.cwd.omitted', 'mcp.stdio.env.plugin-root', 'mcp.stdio.env.plugin-data-absolute', 'mcp.stdio.env.configured-value']) {
    assert.equal(report.results.find((result) => result.id === id).status, 'fail', id);
  }
  assert.equal(report.results.find((result) => result.id === 'mcp.stdio.tool-availability.cwd-omitted').status, 'pass');
});

test('MCP tool errors remain errors and do not create success observations', { timeout: 30_000 }, async (t) => {
  const files = await fixture(t);
  const client = await connect(files, 'default');
  for (const arguments_ of [{}, { runId: '' }, { runId: 'x', extra: true }]) {
    const result = await client.callTool({ name: 'observe', arguments: arguments_ });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent, undefined);
  }
  const result = await client.callTool({ name: 'report', arguments: { input: { status: 'pass' } } });
  assert.equal(result.isError, true);
});


test('data cwd accepts a client-selected directory alias', { timeout: 30_000 }, async (t) => {
  const files = await fixture(t);
  const alias = `${files.data}-alias`;
  await symlink(files.data, alias, 'junction');
  const client = await connect({ ...files, data: alias }, 'data');
  const result = await client.callTool({ name: 'observe', arguments: { runId: 'reference-test' } });
  assert.equal(result.structuredContent.evidence.env.PLUGIN_DATA, alias);
  assert.equal(result.structuredContent.evidence.resolvedData, files.data);
  assert.equal(result.structuredContent.evidence.cwd, files.data);
  const report = buildReport(input([result.structuredContent]));
  assert.equal(report.results.find(({ id }) => id === 'mcp.stdio.cwd.plugin-data').status, 'pass');
});
