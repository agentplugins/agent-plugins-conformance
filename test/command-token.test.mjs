import assert from 'node:assert/strict';
import { cp, lstat, mkdir, mkdtemp, readFile, realpath, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { buildReport } from '../plugins/agent-plugins-conformance/src/report.mjs';

const configuredArgs = ['arg with spaces', '', 'literal-value'];

async function fixture(t) {
  const parent = await mkdtemp(join(tmpdir(), 'apc command token '));
  const root = join(await realpath(parent), 'installed plugin with spaces');
  const data = join(await realpath(parent), 'plugin data with spaces');
  const clients = [];
  const protocolErrors = [];
  await cp(new URL('../plugins/agent-plugins-conformance-core/', import.meta.url), root, { recursive: true });
  await mkdir(data);
  t.after(async () => {
    try {
      const results = await Promise.allSettled(clients.map((client) => client.close()));
      const failures = results.filter(({ status }) => status === 'rejected').map(({ reason }) => reason);
      if (failures.length) throw new AggregateError(failures, 'MCP clients failed to close');
      assert.deepEqual(protocolErrors, [], 'The server wrote invalid MCP output');
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });
  const config = JSON.parse(await readFile(join(root, 'mcp.json'), 'utf8'));
  return { parent, root, data, clients, config, protocolErrors };
}

async function connectTransport(files, options) {
  const client = new Client({ name: 'command-token-reference-test', version: '1' });
  client.onerror = (error) => files.protocolErrors.push(error);
  files.clients.push(client);
  await client.connect(new StdioClientTransport({ ...options, stderr: 'pipe' }));
  return client;
}

function baseEnvironment() {
  const env = Object.fromEntries(Object.entries(process.env));
  for (const name of ['PLUGIN_ROOT', 'PLUGIN_DATA', 'APC_VALUE', 'APC_EXPANSION', 'APC_LITERAL']) delete env[name];
  return env;
}

async function connectDefault(files) {
  return connectTransport(files, {
    command: process.execPath,
    args: [join(files.root, 'dist/probe.mjs'), 'default'],
    cwd: files.root,
    env: { ...baseEnvironment(), PLUGIN_ROOT: files.root, PLUGIN_DATA: files.data },
  });
}

async function connect(files, server, { base = 'root', split = false, batch = false } = {}) {
  const configured = files.config.mcpServers[server];
  const tail = process.platform === 'win32' ? 'token.cmd' : 'token.sh';
  const cwd = resolve(files.root, configured.cwd.slice(2));
  let command = resolve(base === 'cwd' ? cwd : files.root, configured.command.slice(2));
  let args = configured.args;
  if (split === 'root-harness') {
    // Simulate the attributable result of splitting the command while resolving
    // its first token from the plugin root. Native clients choose the resolution
    // base before the fixture can observe it, so this is intentionally a harness.
    command = resolve(files.root, configured.command.slice(2).replace(` ${tail}`, '')) +
      (process.platform === 'win32' ? '.cmd' : '');
    args = [tail, ...configured.args];
  } else if (split === 'cwd-shell') {
    if (process.platform === 'win32') {
      command = join(files.parent, 'bad command token launcher.cmd');
      await writeFile(command, '@echo off\r\n.\\bin\\windows\\probe token.cmd %*\r\n');
    } else {
      command = '/bin/sh';
      args = ['-c', `${configured.command} "$@"`, 'apc-command-token', ...configured.args];
    }
  }
  if (batch) {
    // Preserve ordinary batch echo settings; the fixture must keep stdout protocol-clean.
    command = join(files.parent, 'ordinary batch launcher.cmd');
    await writeFile(command,
      `@call "${resolve(files.root, configured.command.slice(2))}" %*\r\n`);
  }
  const env = baseEnvironment();
  return connectTransport(files, { command, args, cwd, env });
}

async function observe(client) {
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map(({ name }) => name), ['observe']);
  const result = await client.callTool({ name: 'observe', arguments: {} });
  assert.equal(result.isError, undefined);
  assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
  return result.structuredContent;
}

test('the copied Core fixture completes MCP exchanges from all four attributable command origins',
  { timeout: 30_000 }, async (t) => {
    const files = await fixture(t);
    assert.equal((await readdir(files.root)).includes('node_modules'), false);
    const platform = process.platform === 'win32' ? 'windows' : 'posix';
    const tail = process.platform === 'win32' ? 'token.cmd' : 'token.sh';
    const server = `command-token-${platform}`;
    const expectedCwd = await realpath(join(files.root, 'probe-workdir'));
    const defaultObservation = await observe(await connectDefault(files));
    for (const [variant, origin, marker, prefix, tokenStatus, resolutionStatus] of [
      [undefined, `${platform}-exact`, 'intact', [], 'pass', 'pass'],
      ['root-harness', `${platform}-decoy`, 'split', [tail], 'fail', 'not_verified'],
      ['cwd-exact', `${platform}-cwd-exact`, 'intact', [], 'pass', 'fail'],
      ['cwd-shell', `${platform}-cwd-decoy`, 'split', [tail], 'fail', 'not_verified'],
    ]) {
      const options = variant === 'cwd-exact' ? { base: 'cwd' } : { split: variant };
      const observation = await observe(await connect(files, server, options));
      assert.equal(observation.kind, 'mcp-stdio', variant);
      assert.equal(observation.server, server, variant);
      assert.equal(observation.evidence.server, server, variant);
      assert.equal(observation.evidence.root, await realpath(files.root), variant);
      assert.equal(observation.evidence.cwd, expectedCwd, variant);
      assert.equal(observation.evidence.resolvedData, null, variant);
      assert.deepEqual(observation.evidence.env, {}, variant);
      assert.deepEqual(observation.evidence.argv,
        [server, origin, marker, ...prefix, ...configuredArgs], variant);
      const report = buildReport({
        schemaVersion: 1,
        observations: [defaultObservation, observation],
      });
      assert.equal(report.results.find(({ id }) =>
        id === 'mcp.stdio.command.single-token').status, tokenStatus, variant);
      assert.equal(report.results.find(({ id }) =>
        id === 'mcp.stdio.command.plugin-relative-resolution').status, resolutionStatus, variant);
    }
  });

test('deliberate unquoted platform-shell parsing reaches the split-name decoy',
  { timeout: 30_000 }, async (t) => {
    const files = await fixture(t);
    const platform = process.platform === 'win32' ? 'windows' : 'posix';
    const tail = process.platform === 'win32' ? 'token.cmd' : 'token.sh';
    const server = `command-token-${platform}`;
    const observation = await observe(await connect(files, server, { split: 'cwd-shell' }));
    assert.equal(observation.kind, 'mcp-stdio');
    assert.equal(observation.server, server);
    assert.deepEqual(observation.evidence.argv,
      [server, `${platform}-cwd-decoy`, 'split', tail, ...configuredArgs]);
  });

test('explicit Windows batch execution preserves the command and arguments without non-MCP stdout',
  { skip: process.platform !== 'win32', timeout: 30_000 }, async (t) => {
    const files = await fixture(t);
    const server = 'command-token-windows';
    const observation = await observe(await connect(files, server, { batch: true }));
    assert.deepEqual(observation.evidence.argv,
      [server, 'windows-exact', 'intact', ...configuredArgs]);
    assert.equal(observation.evidence.cwd, await realpath(join(files.root, 'probe-workdir')));
  });

test('Core packages paired native wrappers with the intended executable modes',
  { skip: process.platform === 'win32' }, async () => {
    const root = new URL('../plugins/agent-plugins-conformance-core/bin/', import.meta.url);
    const cwd = new URL('../plugins/agent-plugins-conformance-core/probe-workdir/bin/', import.meta.url);
    assert.notEqual((await lstat(new URL('posix/probe token.sh', root))).mode & 0o111, 0);
    assert.notEqual((await lstat(new URL('posix/probe', root))).mode & 0o111, 0);
    assert.equal((await lstat(new URL('windows/probe token.cmd', root))).mode & 0o111, 0);
    assert.equal((await lstat(new URL('windows/probe.cmd', root))).mode & 0o111, 0);
    assert.notEqual((await lstat(new URL('posix/probe token.sh', cwd))).mode & 0o111, 0);
    assert.notEqual((await lstat(new URL('posix/probe', cwd))).mode & 0o111, 0);
    assert.equal((await lstat(new URL('windows/probe token.cmd', cwd))).mode & 0o111, 0);
    assert.equal((await lstat(new URL('windows/probe.cmd', cwd))).mode & 0o111, 0);
  });
