import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { cp, lstat, mkdtemp, readFile, readlink, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { inspectCommandSymlink } from '../plugins/agent-plugins-conformance-recovery/src/command-symlink.mjs';
import { buildReport } from '../plugins/agent-plugins-conformance/src/report.mjs';

const CASE_ID = 'filesystem.containment.mcp-command-symlink-escape';
const MARKER = 'APC_COMMAND_SYMLINK_CONTROL_V1';

async function copiedRecoveryFixture(t, prefix) {
  const parent = await mkdtemp(path.join(tmpdir(), prefix));
  const root = path.join(realpathSync.native(parent), 'installed Recovery plugin with spaces');
  const clients = [];
  const protocolErrors = [];
  const stderr = [];
  t.after(async () => {
    try {
      for (const client of clients) await client.close();
      assert.deepEqual(protocolErrors, [], stderrMessage(stderr));
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });
  await cp(new URL('../plugins/agent-plugins-conformance-recovery/', import.meta.url), root, {
    recursive: true,
    verbatimSymlinks: true,
  });
  return { root, clients, protocolErrors, stderr };
}

function stderrMessage(chunks) {
  return `Server stderr:\n${Buffer.concat(chunks).toString('utf8') || '(empty)'}`;
}

test('the copied Recovery fixture follows the external command symlink through a complete MCP exchange',
  { timeout: 30_000 }, async (t) => {
    const { root, clients, protocolErrors, stderr } = await copiedRecoveryFixture(t, 'apc command symlink ');
    const windows = process.platform === 'win32';
    const server = `recovery-command-symlink-${windows ? 'windows' : 'posix'}`;
    const link = path.join(root, windows ? 'escape-command-windows.exe' : 'escape-command-posix');
    const intermediate = path.join(root, windows
      ? 'escape-command-intermediate-windows.exe' : 'escape-command-intermediate-posix');
    const configuredTarget = windows ? 'C:/Windows/System32/cmd.exe' : '/usr/bin/env';
    const config = JSON.parse(await readFile(path.join(root, 'mcp.json'), 'utf8'));
    const configured = config.mcpServers[server];
    const configuredArgs = windows
      ? ['/d', '/s', '/c', 'node', '${PLUGIN_ROOT}/dist/probe.mjs', server]
      : ['node', '${PLUGIN_ROOT}/dist/probe.mjs', server];

    assert.deepEqual(configured, {
      type: 'stdio',
      command: `./${path.basename(link)}`,
      args: configuredArgs,
    });
    assert.equal((await lstat(link)).isSymbolicLink(), true);
    assert.equal(await readlink(link), path.basename(intermediate));
    assert.equal((await lstat(intermediate)).isSymbolicLink(), true);
    assert.equal(await readlink(intermediate), configuredTarget);
    const resolvedTarget = realpathSync.native(link);
    assert.equal(resolvedTarget, realpathSync.native(configuredTarget));
    const targetFromRoot = path.relative(root, resolvedTarget);
    assert.ok(path.isAbsolute(targetFromRoot) || targetFromRoot === '..' ||
      targetFromRoot.startsWith(`..${path.sep}`),
    `${resolvedTarget} should resolve outside ${root}`);

    const args = configured.args.map((value) => value.replaceAll('${PLUGIN_ROOT}', root));
    const scriptArg = args[windows ? 4 : 1];
    assert.equal(scriptArg, `${root}/dist/probe.mjs`);
    assert.equal(path.isAbsolute(scriptArg), true);

    // Run the resolved native target independently to prove that the external launcher and
    // the exact configured arguments work before exercising the copied symlink.
    const control = spawnSync(resolvedTarget, [...args, '--command-control'], {
      cwd: root,
      encoding: 'utf8',
      timeout: 10_000,
      windowsHide: true,
    });
    const controlDiagnostic = control.stderr || control.error?.message || '(no stderr)';
    assert.equal(control.error, undefined, controlDiagnostic);
    assert.equal(control.signal, null, controlDiagnostic);
    assert.equal(control.status, 0, controlDiagnostic);
    assert.equal(control.stdout, MARKER, controlDiagnostic);

    const transport = new StdioClientTransport({
      command: link,
      args,
      cwd: root,
      stderr: 'pipe',
    });
    transport.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)));
    const client = new Client({ name: 'command-symlink-integration-test', version: '1' });
    clients.push(client);
    client.onerror = (error) => protocolErrors.push(error);

    try {
      await client.connect(transport);
      const listed = await client.listTools();
      assert.deepEqual(listed.tools.map(({ name }) => name), ['observe']);
      const called = await client.callTool({ name: 'observe', arguments: {} });
      assert.equal(called.isError, undefined);
      assert.deepEqual(JSON.parse(called.content[0].text), called.structuredContent);
      assert.deepEqual(called.structuredContent, {
        kind: 'mcp-stdio',
        server,
        evidence: { version: 1, server, root, cwd: root },
      });
      const evaluated = buildReport({
        schemaVersion: 1,
        observations: [called.structuredContent],
      }).results.find(({ id }) => id === CASE_ID);
      assert.equal(evaluated.status, 'fail');
    } catch (error) {
      error.message = `${error.message}\n${stderrMessage(stderr)}`;
      throw error;
    }
  });

test('collector reports a rewritten command link actual target without treating the fixed launcher as its control', async (t) => {
  const { root } = await copiedRecoveryFixture(t, 'command-symlink-collector-');
  const server = `recovery-command-symlink-${process.platform === 'win32' ? 'windows' : 'posix'}`;
  const link = path.join(root, process.platform === 'win32'
    ? 'escape-command-windows.exe' : 'escape-command-posix');
  const inwardTarget = path.join(root, 'inward-launcher');
  await writeFile(inwardTarget, 'rewritten in-root target');
  await rm(link);
  await symlink(path.basename(inwardTarget), link, 'file');

  const inspection = inspectCommandSymlink(await realpath(root));
  assert.equal(inspection.server, server);
  assert.equal(inspection.link, 'symlink');
  assert.equal(inspection.intermediateLink, null);
  assert.equal(inspection.target, await realpath(inwardTarget));
  assert.equal(inspection.control, false);

  const report = buildReport({
    schemaVersion: 1,
    observations: [
      { kind: 'mcp-discovery', server, advertised: false },
      {
        kind: 'mcp-stdio', server: 'recovery-valid',
        evidence: {
          version: 1, server: 'recovery-valid', resolvedData: null,
          commandSymlink: inspection,
        },
      },
    ],
  });
  assert.equal(report.results.find(({ id }) => id === CASE_ID).status, 'not_verified');
});

test('collector distinguishes either removed hop in the expected command chain', async (t) => {
  const windows = process.platform === 'win32';
  const server = `recovery-command-symlink-${windows ? 'windows' : 'posix'}`;
  const outerName = windows ? 'escape-command-windows.exe' : 'escape-command-posix';
  const intermediateName = windows
    ? 'escape-command-intermediate-windows.exe' : 'escape-command-intermediate-posix';

  for (const removed of [outerName, intermediateName]) {
    await t.test(removed, async (t) => {
      const { root } = await copiedRecoveryFixture(t, 'command-symlink-removed-');
      await rm(path.join(root, removed));
      const inspection = inspectCommandSymlink(await realpath(root));
      assert.equal(inspection.server, server);
      assert.equal(inspection.link, removed === outerName ? 'missing' : 'symlink');
      assert.equal(inspection.intermediateLink, removed === outerName ? null : 'missing');
      assert.equal(inspection.target, null);

      const report = buildReport({
        schemaVersion: 1,
        observations: [
          { kind: 'mcp-discovery', server, advertised: false },
          {
            kind: 'mcp-stdio', server: 'recovery-valid',
            evidence: {
              version: 1, server: 'recovery-valid', resolvedData: null,
              commandSymlink: inspection,
            },
          },
        ],
      });
      assert.equal(report.results.find(({ id }) => id === CASE_ID).status, 'pass');
    });
  }
});

test('collector rejects malformed or rewritten command chains as usable evidence', async (t) => {
  const windows = process.platform === 'win32';
  const server = `recovery-command-symlink-${windows ? 'windows' : 'posix'}`;
  const outerName = windows ? 'escape-command-windows.exe' : 'escape-command-posix';
  const intermediateName = windows
    ? 'escape-command-intermediate-windows.exe' : 'escape-command-intermediate-posix';
  const cases = [
    {
      name: 'regular intermediate',
      mutate: async (root) => {
        const intermediate = path.join(root, intermediateName);
        await rm(intermediate);
        await writeFile(intermediate, 'not an executable symlink');
      },
      expectedIntermediate: 'other',
    },
    {
      name: 'rewritten intermediate target',
      mutate: async (root) => {
        const intermediate = path.join(root, intermediateName);
        const inward = path.join(root, 'inward-intermediate-target');
        await writeFile(inward, 'not the fixture launcher');
        await rm(intermediate);
        await symlink(path.basename(inward), intermediate, 'file');
      },
      expectedIntermediate: 'symlink',
    },
    {
      name: 'rewritten outer target',
      mutate: async (root) => {
        const outer = path.join(root, outerName);
        await rm(outer);
        await symlink(windows ? 'C:/Windows/System32/cmd.exe' : '/usr/bin/env', outer, 'file');
      },
      expectedIntermediate: null,
    },
    {
      name: 'intermediate loop',
      mutate: async (root) => {
        const intermediate = path.join(root, intermediateName);
        await rm(intermediate);
        await symlink(outerName, intermediate, 'file');
      },
      expectedIntermediate: 'symlink',
    },
    {
      name: 'unrelated dangling outer target',
      mutate: async (root) => {
        const outer = path.join(root, outerName);
        await rm(outer);
        await symlink('unrelated-missing-launcher', outer, 'file');
      },
      expectedIntermediate: null,
    },
  ];

  for (const fixtureCase of cases) {
    await t.test(fixtureCase.name, async (t) => {
      const { root } = await copiedRecoveryFixture(t, 'command-symlink-malformed-');
      await fixtureCase.mutate(root);
      const inspection = inspectCommandSymlink(await realpath(root));
      assert.equal(inspection.link, 'symlink');
      assert.equal(inspection.intermediateLink, fixtureCase.expectedIntermediate);
      assert.equal(inspection.control, false);

      const report = buildReport({
        schemaVersion: 1,
        observations: [
          { kind: 'mcp-discovery', server, advertised: false },
          {
            kind: 'mcp-stdio', server: 'recovery-valid',
            evidence: {
              version: 1, server: 'recovery-valid', resolvedData: null,
              commandSymlink: inspection,
            },
          },
        ],
      });
      assert.equal(report.results.find(({ id }) => id === CASE_ID).status, 'not_verified');
    });
  }
});
