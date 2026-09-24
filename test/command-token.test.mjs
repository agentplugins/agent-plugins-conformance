import assert from 'node:assert/strict';
import { cp, lstat, mkdtemp, readFile, realpath, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const configuredArgs = ['arg with spaces', '', 'literal-value'];

async function fixture(t) {
  const parent = await mkdtemp(join(tmpdir(), 'apc command token '));
  const root = join(await realpath(parent), 'installed plugin with spaces');
  const clients = [];
  await cp(new URL('../plugins/agent-plugins-conformance-core/', import.meta.url), root, { recursive: true });
  t.after(async () => {
    try {
      const results = await Promise.allSettled(clients.map((client) => client.close()));
      const failures = results.filter(({ status }) => status === 'rejected').map(({ reason }) => reason);
      if (failures.length) throw new AggregateError(failures, 'MCP clients failed to close');
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });
  const config = JSON.parse(await readFile(join(root, 'mcp.json'), 'utf8'));
  return { parent, root, clients, config };
}

async function connect(files, server, { split = false } = {}) {
  const configured = files.config.mcpServers[server];
  let command = resolve(files.root, configured.command.slice(2));
  let args = configured.args;
  if (split) {
    if (process.platform === 'win32') {
      command = join(files.parent, 'bad command token launcher.cmd');
      await writeFile(command, '@echo off\r\n.\\bin\\windows\\probe token.cmd %*\r\n');
    } else {
      command = '/bin/sh';
      args = ['-c', `${configured.command} "$@"`, 'apc-command-token', ...configured.args];
    }
  }
  const env = Object.fromEntries(Object.entries(process.env));
  for (const name of ['PLUGIN_ROOT', 'PLUGIN_DATA', 'APC_VALUE', 'APC_EXPANSION', 'APC_LITERAL']) delete env[name];
  const client = new Client({ name: 'command-token-reference-test', version: '1' });
  files.clients.push(client);
  await client.connect(new StdioClientTransport({ command, args, cwd: files.root, env, stderr: 'pipe' }));
  return client;
}

async function observe(client) {
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map(({ name }) => name), ['observe']);
  const result = await client.callTool({ name: 'observe', arguments: {} });
  assert.equal(result.isError, undefined);
  assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
  return result.structuredContent;
}

test('the copied Core fixture preserves the platform command token and configured arguments',
  { timeout: 30_000 }, async (t) => {
    const files = await fixture(t);
    assert.equal((await readdir(files.root)).includes('node_modules'), false);
    const platform = process.platform === 'win32' ? 'windows' : 'posix';
    const server = `command-token-${platform}`;
    const observation = await observe(await connect(files, server));
    assert.equal(observation.kind, 'mcp-stdio');
    assert.equal(observation.server, server);
    assert.equal(observation.evidence.server, server);
    assert.equal(observation.evidence.root, await realpath(files.root));
    assert.equal(observation.evidence.cwd, await realpath(files.root));
    assert.equal(observation.evidence.resolvedData, null);
    assert.deepEqual(observation.evidence.env, {});
    assert.deepEqual(observation.evidence.argv,
      [server, `${platform}-exact`, 'intact', ...configuredArgs]);
  });

test('deliberate unquoted platform-shell parsing reaches the split-name decoy',
  { timeout: 30_000 }, async (t) => {
    const files = await fixture(t);
    const platform = process.platform === 'win32' ? 'windows' : 'posix';
    const tail = process.platform === 'win32' ? 'token.cmd' : 'token.sh';
    const server = `command-token-${platform}`;
    const observation = await observe(await connect(files, server, { split: true }));
    assert.equal(observation.kind, 'mcp-stdio');
    assert.equal(observation.server, server);
    assert.deepEqual(observation.evidence.argv,
      [server, `${platform}-decoy`, 'split', tail, ...configuredArgs]);
  });

test('Core packages paired native wrappers with the intended executable modes',
  { skip: process.platform === 'win32' }, async () => {
    const root = new URL('../plugins/agent-plugins-conformance-core/bin/', import.meta.url);
    assert.notEqual((await lstat(new URL('posix/probe token.sh', root))).mode & 0o111, 0);
    assert.notEqual((await lstat(new URL('posix/probe', root))).mode & 0o111, 0);
    assert.equal((await lstat(new URL('windows/probe token.cmd', root))).mode & 0o111, 0);
    assert.equal((await lstat(new URL('windows/probe.cmd', root))).mode & 0o111, 0);
  });
