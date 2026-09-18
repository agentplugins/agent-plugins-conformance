import assert from 'node:assert/strict';
import { access, cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { buildReport } from '../plugins/agent-plugins-conformance/src/report.mjs';

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
  await cp(new URL('../plugins/agent-plugins-conformance-core', import.meta.url), root, { recursive: true });
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
const input = (observations) => ({ schemaVersion: 1, observations });

test('copied plugin runs only MCP observation tools without node_modules', { timeout: 30_000 }, async (t) => {
  const files = await fixture(t);
  const observations = [];
  for (const mode of ['default', 'relative', 'root', 'data']) {
    const client = await connect(files, mode);
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map(({ name }) => name), ['observe']);
    assert.equal(tools[0].annotations.readOnlyHint, mode !== 'default');
    assert.equal(tools[0].annotations.idempotentHint, mode !== 'default');
    const result = await client.callTool({ name: 'observe', arguments: {} });
    assert.ok(!result.isError);
    const observation = JSON.parse(result.content[0].text);
    assert.deepEqual(result.structuredContent, observation);
    assert.equal(observation.evidence.root, files.root);
    assert.equal(observation.evidence.env.APC_SHOULD_NOT_LEAK, undefined);
    if (mode === 'default') {
      assert.equal(dirname(observation.evidence.dataWrite.path), files.data);
      assert.equal(observation.evidence.dataWrite.error, null);
      assert.equal(observation.evidence.dataWrite.cleanupError, null);
      await assert.rejects(access(observation.evidence.dataWrite.path), { code: 'ENOENT' });
      assert.equal(await readFile(join(files.data, 'README.md'), 'utf8'),
        'This bundled directory is the expected working directory for the `relative` and `root` MCP probes.\n');

      await rm(files.data, { recursive: true });
      const unavailable = (await client.callTool({ name: 'observe', arguments: {} })).structuredContent;
      assert.equal(unavailable.evidence.dataWrite.error.operation, 'create');
      assert.equal(unavailable.evidence.dataWrite.error.code, 'ENOENT');
      assert.equal(unavailable.evidence.dataWrite.cleanupError, null);

      await mkdir(files.data);
      await writeFile(join(files.data, 'README.md'),
        'This bundled directory is the expected working directory for the `relative` and `root` MCP probes.\n');
      const restored = (await client.callTool({ name: 'observe', arguments: {} })).structuredContent;
      assert.notEqual(restored.evidence.dataWrite.path, observation.evidence.dataWrite.path);
      assert.equal(restored.evidence.dataWrite.error, null);
      assert.equal(restored.evidence.dataWrite.cleanupError, null);
      await assert.rejects(access(restored.evidence.dataWrite.path), { code: 'ENOENT' });
    } else {
      assert.equal(Object.hasOwn(observation.evidence, 'dataWrite'), false);
    }
    observations.push(observation);
  }
  assert.equal(await readFile(join(files.data, 'README.md'), 'utf8'),
    'This bundled directory is the expected working directory for the `relative` and `root` MCP probes.\n');
  const reportInput = input(observations);
  const direct = buildReport(reportInput);
  assert.equal(direct.summary.fail, 0);
  assert.equal(direct.summary.pass, 14);
  assert.equal(direct.summary.not_verified, 1);
});

test('actual process deviations are evaluated as failures, not missing evidence', { timeout: 30_000 }, async (t) => {
  const files = await fixture(t);
  const client = await connect(files, 'default', { cwd: files.data, env: { PLUGIN_ROOT: files.data } });
  const result = await client.callTool({ name: 'observe', arguments: {} });
  const report = buildReport(input([result.structuredContent]));
  for (const id of ['mcp.stdio.cwd.omitted', 'mcp.stdio.env.plugin-root', 'mcp.stdio.env.plugin-data-absolute', 'mcp.stdio.env.configured-value']) {
    assert.equal(report.results.find((result) => result.id === id).status, 'fail', id);
  }
  assert.equal(report.results.find((result) => result.id === 'mcp.stdio.tool-availability.cwd-omitted').status, 'pass');
});

test('packaged default probe reports skipped and failed PLUGIN_DATA writes as evidence', { timeout: 30_000 }, async (t) => {
  const files = await fixture(t);
  const existing = join(files.data, 'README.md');
  const existingContents = await readFile(existing, 'utf8');

  const relativeClient = await connect(files, 'default', {
    env: { PLUGIN_ROOT: files.root, PLUGIN_DATA: 'relative/data' },
  });
  const relative = await relativeClient.callTool({ name: 'observe', arguments: {} });
  assert.ok(!relative.isError);
  assert.equal(relative.structuredContent.evidence.dataWrite, null);
  assert.equal(buildReport(input([relative.structuredContent])).results
    .find(({ id }) => id === 'mcp.stdio.data.writable').status, 'not_verified');

  for (const data of [join(files.data, 'missing'), existing]) {
    const client = await connect(files, 'default', {
      env: { PLUGIN_ROOT: files.root, PLUGIN_DATA: data },
    });
    const result = await client.callTool({ name: 'observe', arguments: {} });
    assert.ok(!result.isError);
    assert.equal(result.structuredContent.evidence.dataWrite.error.operation, 'create');
    assert.match(result.structuredContent.evidence.dataWrite.error.code, /^(ENOENT|ENOTDIR)$/);
    assert.equal(result.structuredContent.evidence.dataWrite.cleanupError, null);
    assert.equal(buildReport(input([result.structuredContent])).results
      .find(({ id }) => id === 'mcp.stdio.data.writable').status, 'fail');
  }
  assert.equal(await readFile(existing, 'utf8'), existingContents);
});

test('MCP tool errors remain errors and do not create success observations', { timeout: 30_000 }, async (t) => {
  const files = await fixture(t);
  const client = await connect(files, 'default');
  const invalid = await client.callTool({ name: 'observe', arguments: { extra: true } });
  assert.equal(invalid.isError, true);
  assert.equal(invalid.structuredContent, undefined);
  const unknown = await client.callTool({ name: 'unknown', arguments: {} });
  assert.equal(unknown.isError, true);
  assert.match(unknown.content[0].text, /Unknown tool: unknown/);
});

test('data cwd accepts a client-selected directory alias', { timeout: 30_000 }, async (t) => {
  const files = await fixture(t);
  const alias = `${files.data}-alias`;
  await symlink(files.data, alias, 'junction');
  const client = await connect({ ...files, data: alias }, 'data');
  const result = await client.callTool({ name: 'observe', arguments: {} });
  assert.equal(result.structuredContent.evidence.env.PLUGIN_DATA, alias);
  assert.equal(result.structuredContent.evidence.resolvedData, files.data);
  assert.equal(result.structuredContent.evidence.cwd, files.data);
  const report = buildReport(input([result.structuredContent]));
  assert.equal(report.results.find(({ id }) => id === 'mcp.stdio.cwd.plugin-data').status, 'pass');
});
