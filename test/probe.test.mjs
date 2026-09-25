import assert from 'node:assert/strict';
import { access, cp, lstat, mkdir, mkdtemp, readFile, readlink, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
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
  assert.equal(direct.summary.pass, 15);
  assert.equal(direct.summary.not_verified, 41);
});

test('copied recovery plugin serves exact valid and invalid-server observations without runtime dependencies', { timeout: 30_000 }, async (t) => {
  const parent = await mkdtemp(join(tmpdir(), 'agent-plugins-conformance-recovery-'));
  const root = join(parent, 'copied recovery plugin');
  const data = join(parent, 'recovery data');
  const alias = join(parent, 'recovery data alias');
  const sourceRoot = new URL('../plugins/agent-plugins-conformance-recovery/', import.meta.url);
  const sourceLink = new URL('escape-link', sourceRoot);
  assert.equal((await lstat(sourceLink)).isSymbolicLink(), true);
  assert.equal(await readlink(sourceLink), '..');
  assert.equal(await realpath(sourceLink), await realpath(new URL('..', sourceRoot)));
  await cp(sourceRoot, root, { recursive: true, verbatimSymlinks: true });
  await mkdir(data);
  await symlink(data, alias, 'junction');
  const resolvedRoot = await realpath(root);
  const resolvedData = await realpath(data);
  const outsideCwd = await realpath(parent);
  const commandSymlinkServer = `recovery-command-symlink-${process.platform === 'win32' ? 'windows' : 'posix'}`;
  const commandSymlinkTarget = await realpath(process.platform === 'win32'
    ? 'C:/Windows/System32/cmd.exe' : '/usr/bin/env');
  assert.equal((await lstat(join(root, 'escape-link'))).isSymbolicLink(), true);
  assert.equal(await readlink(join(root, 'escape-link')), '..');
  assert.equal(await realpath(join(root, 'escape-link')), outsideCwd);
  const clients = [];
  t.after(async () => {
    try { await Promise.all(clients.map((client) => client.close())); } finally { await rm(parent, { recursive: true, force: true }); }
  });
  assert.equal((await readdir(root)).includes('node_modules'), false);
  const configPath = join(root, 'mcp.json');
  const configBefore = await readFile(configPath);
  const configs = JSON.parse(configBefore).mcpServers;
  const connectRecovery = async (serverName, {
    cwd, pluginData, pluginRoot = root, useConfiguredCwd = false, config = configs[serverName],
  } = {}) => {
    const variables = { PLUGIN_ROOT: pluginRoot, ...(pluginData === undefined ? {} : { PLUGIN_DATA: pluginData }) };
    const expand = (value) => value.replaceAll('${PLUGIN_ROOT}', pluginRoot)
      .replaceAll('${PLUGIN_DATA}', pluginData ?? '${PLUGIN_DATA}');
    const configuredEnv = Object.fromEntries(Object.entries(config.env ?? {}).map(([name, value]) => [
      name, expand(value),
    ]));
    const configuredCwd = config.cwd
      ? config.cwd.startsWith('./') ? join(pluginRoot, config.cwd) : expand(config.cwd)
      : pluginRoot;
    const client = new Client({ name: 'conformance-recovery-reference-test', version: '1' });
    clients.push(client);
    await client.connect(new StdioClientTransport({
      command: process.execPath,
      args: config.args.map(expand),
      cwd: cwd ?? (useConfiguredCwd ? configuredCwd : pluginRoot),
      env: { ...variables, ...configuredEnv },
      stderr: 'pipe',
    }));
    return client;
  };
  const observe = async (client) => {
    const response = await client.callTool({ name: 'observe', arguments: {} });
    assert.equal(response.isError, undefined);
    assert.deepEqual(JSON.parse(response.content[0].text), response.structuredContent);
    return response.structuredContent;
  };

  const client = await connectRecovery('recovery-valid', { pluginData: alias });
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map(({ name }) => name), ['observe']);
  const response = await observe(client);
  const observation = {
    kind: 'mcp-stdio', server: 'recovery-valid',
    evidence: {
      version: 1, server: 'recovery-valid', resolvedData, symlinkCwd: 'symlink',
      commandSymlink: {
        server: commandSymlinkServer, link: 'symlink', root: resolvedRoot,
        target: commandSymlinkTarget, control: true, error: null,
      },
    },
  };
  assert.deepEqual(response, observation);
  assert.equal(buildReport(input([observation])).results
    .find(({ id }) => id === 'mcp.stdio.recovery.valid-server-available').status, 'pass');

  const unavailable = await connectRecovery('recovery-valid', { pluginData: join(parent, 'missing data') });
  const unavailableObservation = await observe(unavailable);
  assert.equal(unavailableObservation.evidence.resolvedData, null);
  assert.equal(buildReport(input([unavailableObservation])).results
    .find(({ id }) => id === 'mcp.stdio.recovery.valid-server-available').status, 'pass');

  const symlinkServer = 'recovery-cwd-symlink-escape';
  const symlinkCase = 'filesystem.containment.cwd-symlink-escape';
  const removedRoot = join(parent, 'recovery with link removed');
  await cp(sourceRoot, removedRoot, { recursive: true, verbatimSymlinks: true });
  await rm(join(removedRoot, 'escape-link'));
  const removedClient = await connectRecovery('recovery-valid', { pluginRoot: removedRoot, pluginData: alias });
  const removedObservation = await observe(removedClient);
  assert.equal(removedObservation.evidence.symlinkCwd, 'missing');
  assert.equal(buildReport(input([
    { kind: 'mcp-discovery', server: symlinkServer, advertised: false }, removedObservation,
  ])).results.find(({ id }) => id === symlinkCase).status, 'pass');

  const plainFileRoot = join(parent, 'recovery with plain file');
  await cp(sourceRoot, plainFileRoot, { recursive: true, verbatimSymlinks: true });
  await rm(join(plainFileRoot, 'escape-link'));
  await writeFile(join(plainFileRoot, 'escape-link'), '..');
  const plainFileClient = await connectRecovery('recovery-valid', { pluginRoot: plainFileRoot, pluginData: alias });
  const plainFileObservation = await observe(plainFileClient);
  assert.equal(plainFileObservation.evidence.symlinkCwd, 'other');
  assert.equal(buildReport(input([
    { kind: 'mcp-discovery', server: symlinkServer, advertised: false }, plainFileObservation,
  ])).results.find(({ id }) => id === symlinkCase).status, 'not_verified');

  const expectedInvalid = (server, cwd) => ({
    kind: 'mcp-stdio', server,
    evidence: { version: 1, server, root: resolvedRoot, cwd },
  });
  const inspectInvalidTool = async (client, server) => {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map(({ name }) => name), ['observe']);
    assert.match(tools[0].description, new RegExp(`${server} fixture server`));
    assert.match(tools[0].description, /observation object.+unchanged/);
    assert.deepEqual(tools[0].annotations, {
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false,
    });
  };

  const outside = await connectRecovery('recovery-cwd-escape', { cwd: outsideCwd });
  await inspectInvalidTool(outside, 'recovery-cwd-escape');
  assert.deepEqual(await observe(outside), expectedInvalid('recovery-cwd-escape', outsideCwd));

  const clamped = await connectRecovery('recovery-cwd-escape');
  assert.deepEqual(await observe(clamped), expectedInvalid('recovery-cwd-escape', resolvedRoot));

  const outsideData = await connectRecovery('recovery-cwd-data-escape', { cwd: outsideCwd, pluginData: alias });
  await inspectInvalidTool(outsideData, 'recovery-cwd-data-escape');
  assert.deepEqual(await observe(outsideData), expectedInvalid('recovery-cwd-data-escape', outsideCwd));

  const clampedData = await connectRecovery('recovery-cwd-data-escape', { cwd: resolvedData, pluginData: alias });
  assert.deepEqual(await observe(clampedData), expectedInvalid('recovery-cwd-data-escape', resolvedData));

  const symlinkEscape = await connectRecovery(symlinkServer, { useConfiguredCwd: true });
  await inspectInvalidTool(symlinkEscape, symlinkServer);
  const symlinkEscapeObservation = await observe(symlinkEscape);
  assert.deepEqual(symlinkEscapeObservation, expectedInvalid(symlinkServer, outsideCwd));
  assert.equal(buildReport(input([symlinkEscapeObservation])).results
    .find(({ id }) => id === symlinkCase).status, 'fail');

  const invalidFormServer = 'recovery-cwd-invalid-form';
  const configuredInvalidForm = configs[invalidFormServer];
  assert.deepEqual(configuredInvalidForm, {
    type: 'stdio', command: 'node',
    args: ['${PLUGIN_ROOT}/dist/probe.mjs', invalidFormServer], cwd: '.',
  });
  const correctedInvalidForm = { ...structuredClone(configuredInvalidForm), cwd: './' };
  for (const [label, config] of [
    ['valid control', correctedInvalidForm],
    ['permissive loader', configuredInvalidForm],
  ]) {
    // The reference launcher deliberately resolves either relative form. The
    // second iteration models accepting the invalid dot form during loading.
    const invalidForm = await connectRecovery(invalidFormServer, { cwd: resolve(root, config.cwd) });
    await inspectInvalidTool(invalidForm, invalidFormServer);
    const invalidFormObservation = await observe(invalidForm);
    assert.deepEqual(invalidFormObservation, expectedInvalid(invalidFormServer, resolvedRoot), label);
    if (label === 'permissive loader') {
      assert.equal(buildReport(input([invalidFormObservation])).results
        .find(({ id }) => id === 'mcp.stdio.cwd.invalid-form').status, 'fail');
    }
  }
  assert.equal(configuredInvalidForm.cwd, '.');

  const missingTypeServer = 'recovery-missing-type';
  const configuredMissingType = configs[missingTypeServer];
  assert.deepEqual(configuredMissingType, {
    command: 'node', args: ['${PLUGIN_ROOT}/dist/probe.mjs', missingTypeServer],
  });
  const correctedMissingType = { type: 'stdio', ...structuredClone(configuredMissingType) };
  const { type, ...withoutType } = correctedMissingType;
  assert.equal(type, 'stdio');
  assert.deepEqual(withoutType, configuredMissingType);
  const missingTypeObservations = [];
  for (const [label, config] of [
    ['valid control', correctedMissingType],
    ['simulated legacy default', configuredMissingType],
  ]) {
    // The second iteration deliberately models a legacy loader defaulting an
    // omitted type to stdio; it does not exercise native plugin validation.
    const missingType = await connectRecovery(missingTypeServer, { config });
    await inspectInvalidTool(missingType, missingTypeServer);
    const missingTypeObservation = await observe(missingType);
    assert.deepEqual(missingTypeObservation, expectedInvalid(missingTypeServer, resolvedRoot), label);
    missingTypeObservations.push(missingTypeObservation);
  }
  assert.deepEqual(missingTypeObservations[1], missingTypeObservations[0]);
  assert.equal(buildReport(input([missingTypeObservations[1]])).results
    .find(({ id }) => id === 'mcp.config.missing-type').status, 'fail');
  assert.deepEqual(configuredMissingType, withoutType);
  assert.deepEqual(await readFile(configPath), configBefore);

  const unknownField = await connectRecovery('recovery-unknown-field');
  await inspectInvalidTool(unknownField, 'recovery-unknown-field');
  const unknownFieldObservation = await observe(unknownField);
  assert.deepEqual(unknownFieldObservation, expectedInvalid('recovery-unknown-field', resolvedRoot));
  assert.equal(buildReport(input([unknownFieldObservation])).results
    .find(({ id }) => id === 'mcp.stdio.config.unknown-field').status, 'fail');

  for (const [server, id] of [
    ['recovery-env-plugin-root', 'mcp.stdio.env.reserved-plugin-root'],
    ['recovery-env-plugin-data', 'mcp.stdio.env.reserved-plugin-data'],
  ]) {
    const reservedEnv = await connectRecovery(server, { pluginData: alias });
    await inspectInvalidTool(reservedEnv, server);
    const reservedEnvObservation = await observe(reservedEnv);
    assert.deepEqual(reservedEnvObservation, expectedInvalid(server, resolvedRoot));
    assert.equal(buildReport(input([reservedEnvObservation])).results.find((result) => result.id === id).status, 'fail');
  }
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
    .find(({ id }) => id === 'filesystem.data.writable').status, 'not_verified');

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
      .find(({ id }) => id === 'filesystem.data.writable').status, 'fail');
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
