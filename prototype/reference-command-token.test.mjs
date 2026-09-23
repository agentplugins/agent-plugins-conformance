import assert from 'node:assert/strict';
import { cp, lstat, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { COMMAND_TOKEN_ARGS, evaluateCommandToken } from './command-token.mjs';

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
      args = configured.args;
    } else {
      command = '/bin/sh';
      args = ['-c', `${configured.command} "$@"`, 'apc-command-token', ...configured.args];
    }
  }
  const client = new Client({ name: 'command-token-reference-test', version: '1' });
  files.clients.push(client);
  await client.connect(new StdioClientTransport({ command, args, cwd: files.root, stderr: 'pipe' }));
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

function coreObservation(root) {
  return { kind: 'mcp-stdio', server: 'default', evidence: { version: 1, server: 'default', root } };
}

test('direct execution preserves the complete platform command token and configured argument boundaries',
  { timeout: 30_000 }, async (t) => {
    const files = await fixture(t);
    const windows = process.platform === 'win32';
    const pathFlavor = windows ? 'windows' : 'posix';
    const server = `command-token-${pathFlavor}`;
    const observation = await observe(await connect(files, server));
    assert.deepEqual(observation, {
      kind: 'mcp-command-token-prototype',
      server,
      evidence: {
        version: 1,
        platform: process.platform,
        pathFlavor,
        wrapperOrigin: `${pathFlavor}-exact`,
        marker: 'intact',
        argv: COMMAND_TOKEN_ARGS,
      },
    });
    assert.deepEqual(evaluateCommandToken({ coreObservation: coreObservation(files.root), observations: [observation] }), {
      status: 'pass', pathFlavor,
      detail: `The ${pathFlavor} exact-name wrapper was selected.`,
    });
  });

test('deliberate unquoted platform-shell parsing reaches only the split-name decoy',
  { timeout: 30_000 }, async (t) => {
    const files = await fixture(t);
    const pathFlavor = process.platform === 'win32' ? 'windows' : 'posix';
    const tail = process.platform === 'win32' ? 'token.cmd' : 'token.sh';
    const observation = await observe(await connect(files, `command-token-${pathFlavor}`, { split: true }));
    assert.equal(observation.evidence.wrapperOrigin, `${pathFlavor}-decoy`);
    assert.equal(observation.evidence.marker, 'split');
    assert.deepEqual(observation.evidence.argv, [tail, ...COMMAND_TOKEN_ARGS]);
    assert.equal(evaluateCommandToken({ coreObservation: coreObservation(files.root), observations: [observation] }).status, 'fail');
  });

test('evaluator requires an independent Core path flavor and ignores wrong-platform or unattributable observations', () => {
  const posixCore = coreObservation('/installed/core');
  const windowsIntact = {
    kind: 'mcp-command-token-prototype', server: 'command-token-windows',
    evidence: { version: 1, platform: 'win32', pathFlavor: 'windows', wrapperOrigin: 'windows-exact', marker: 'intact', argv: COMMAND_TOKEN_ARGS },
  };
  const forgedPosix = {
    kind: 'mcp-command-token-prototype', server: 'command-token-posix',
    evidence: { version: 1, platform: 'linux', pathFlavor: 'posix', wrapperOrigin: 'posix-decoy', marker: 'split', argv: COMMAND_TOKEN_ARGS },
  };
  assert.equal(evaluateCommandToken({ coreObservation: null, observations: [windowsIntact] }).status, 'not_verified');
  assert.equal(evaluateCommandToken({ coreObservation: posixCore, observations: [windowsIntact] }).status, 'not_verified');
  assert.equal(evaluateCommandToken({ coreObservation: posixCore, observations: [forgedPosix] }).status, 'not_verified');
});

test('evaluator recognizes attributable splitting even when the shell mangles later configured arguments', () => {
  const split = {
    kind: 'mcp-command-token-prototype', server: 'command-token-posix',
    evidence: { version: 1, platform: 'linux', pathFlavor: 'posix', wrapperOrigin: 'posix-decoy', marker: 'split', argv: ['token.sh', 'arg', 'with', 'spaces', 'literal-value'] },
  };
  assert.equal(evaluateCommandToken({ coreObservation: coreObservation('/installed/core'), observations: [split] }).status, 'fail');
});

test('evaluator gives attributable split evidence precedence over intact evidence', () => {
  const make = (wrapperOrigin, marker, argv) => ({
    kind: 'mcp-command-token-prototype', server: 'command-token-posix',
    evidence: { version: 1, platform: 'linux', pathFlavor: 'posix', wrapperOrigin, marker, argv },
  });
  const intact = make('posix-exact', 'intact', COMMAND_TOKEN_ARGS);
  const split = make('posix-decoy', 'split', ['token.sh', ...COMMAND_TOKEN_ARGS]);
  assert.equal(evaluateCommandToken({ coreObservation: coreObservation('/installed/core'), observations: [intact, split] }).status, 'fail');
});

test('evaluator selects Windows evidence from an independent Windows Core path', () => {
  const exact = {
    kind: 'mcp-command-token-prototype', server: 'command-token-windows',
    evidence: { version: 1, platform: 'win32', pathFlavor: 'windows', wrapperOrigin: 'windows-exact', marker: 'intact', argv: [] },
  };
  const split = {
    kind: 'mcp-command-token-prototype', server: 'command-token-windows',
    evidence: { version: 1, platform: 'win32', pathFlavor: 'windows', wrapperOrigin: 'windows-decoy', marker: 'split', argv: ['token.cmd', 'mangled'] },
  };
  const core = coreObservation('C:\\installed plugin\\core');
  assert.equal(evaluateCommandToken({ coreObservation: core, observations: [exact] }).status, 'pass');
  assert.equal(evaluateCommandToken({ coreObservation: core, observations: [exact, split] }).status, 'fail');
});

test('an unquoted absolute command under a spaced install root can miss the decoy and remains not verified',
  { skip: process.platform === 'win32' }, async (t) => {
    const files = await fixture(t);
    const configured = files.config.mcpServers['command-token-posix'];
    const absoluteCommand = resolve(files.root, configured.command.slice(2));
    const result = spawnSync('/bin/sh', ['-c', `${absoluteCommand} "$@"`, 'apc-command-token', ...configured.args], {
      cwd: files.root, encoding: 'utf8', timeout: 5_000,
    });
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, '');
    assert.equal(evaluateCommandToken({ coreObservation: coreObservation(files.root), observations: [] }).status, 'not_verified');
  });

test('packaged POSIX wrappers are executable and Windows command files are not executable on POSIX',
  { skip: process.platform === 'win32' }, async () => {
    const root = new URL('../plugins/agent-plugins-conformance-core/bin/', import.meta.url);
    assert.notEqual((await lstat(new URL('posix/probe token.sh', root))).mode & 0o111, 0);
    assert.notEqual((await lstat(new URL('posix/probe', root))).mode & 0o111, 0);
    assert.equal((await lstat(new URL('windows/probe token.cmd', root))).mode & 0o111, 0);
    assert.equal((await lstat(new URL('windows/probe.cmd', root))).mode & 0o111, 0);
  });
