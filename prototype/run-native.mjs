import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, constants, openSync, writeSync } from 'node:fs';
import {
  cp, lstat, mkdir, readFile, readdir, readlink, realpath, rm, symlink, unlink, writeFile,
} from 'node:fs/promises';
import { delimiter, dirname, join, relative } from 'node:path';
import { createInterface } from 'node:readline';

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!['--repository', '--codex', '--evidence-root', '--scenario'].includes(key) || !value) {
      throw new Error('Usage: node run-native.mjs --repository <path> --codex <binary> --evidence-root <path> [--scenario <name>]');
    }
    values[key.slice(2)] = value;
  }
  for (const key of ['repository', 'codex', 'evidence-root']) {
    if (!values[key]) throw new Error(`Missing --${key}`);
  }
  return values;
}

const args = parseArgs(process.argv.slice(2));
const repository = args.repository;
const codex = args.codex;
const evidenceRoot = args['evidence-root'];
const resultsRoot = join(evidenceRoot, 'results');
const pluginName = 'agent-plugins-conformance-recovery';
const target = 'recovery-cwd-symlink-escape';
const linkName = 'escape-link';
const scenarios = [
  { name: 'escaping-symlink', shape: 'symlink', target: '..' },
  { name: 'safe-symlink', shape: 'symlink', target: '.' },
  { name: 'regular-file', shape: 'file', content: '..' },
  { name: 'directory-control', shape: 'directory' },
];
const selectedScenarios = args.scenario
  ? scenarios.filter(({ name }) => name === args.scenario) : scenarios;
if (selectedScenarios.length === 0) throw new Error(`Unknown scenario: ${args.scenario}`);

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

function cleanEnvironment(home) {
  const searchPath = Object.entries(process.env).find(([key]) => key.toUpperCase() === 'PATH')?.[1] ?? '';
  const env = Object.fromEntries(Object.entries(process.env)
    .filter(([key]) => !/OPENAI|CODEX|CHATGPT|^APC_|^PLUGIN_|^PATH$/i.test(key)));
  env.CODEX_HOME = home;
  env.PATH = `${dirname(process.execPath)}${delimiter}${searchPath}`;
  return env;
}

async function optional(operation) {
  try { return { value: await operation(), error: null }; }
  catch (error) { return { value: null, error: { code: error.code ?? null, message: error.message } }; }
}

function entryType(stats) {
  if (stats.isSymbolicLink()) return 'symlink';
  if (stats.isFile()) return 'file';
  if (stats.isDirectory()) return 'directory';
  return 'other';
}

async function pathState(path) {
  const statResult = await optional(() => lstat(path));
  if (statResult.error) return { path, exists: false, lstatError: statResult.error };
  const stats = statResult.value;
  const type = entryType(stats);
  const link = type === 'symlink' ? await optional(() => readlink(path)) : null;
  const resolved = await optional(() => realpath(path));
  const file = type === 'file' ? await optional(() => readFile(path)) : null;
  const content = file?.value ? file.value.toString('utf8') : null;
  return {
    path, exists: true, type, mode: stats.mode & 0o777, size: stats.size,
    readlink: link,
    realpath: resolved,
    content,
    contentSha256: file?.value ? sha256(file.value)
      : link?.value !== null && link?.value !== undefined ? sha256(Buffer.from(link.value)) : null,
  };
}

async function inventoryTree(directory, current = directory, output = []) {
  const entries = await readdir(current, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const path = join(current, entry.name);
    const name = relative(directory, path);
    const stats = await lstat(path);
    const type = entryType(stats);
    const item = { path: name, type, mode: stats.mode & 0o777, size: stats.size };
    if (type === 'symlink') {
      item.linkTarget = await readlink(path);
      item.contentSha256 = sha256(Buffer.from(item.linkTarget));
      item.realpath = await optional(() => realpath(path));
    } else if (type === 'file') {
      item.contentSha256 = sha256(await readFile(path));
    }
    output.push(item);
    if (type === 'directory') await inventoryTree(directory, path, output);
  }
  return output;
}

async function snapshot(directory) {
  const inventory = await inventoryTree(directory);
  return {
    directory,
    targetPath: await pathState(join(directory, linkName)),
    inventory,
    inventorySha256: sha256(Buffer.from(JSON.stringify(inventory))),
  };
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

function nativeCommand(binary, commandArgs, { cwd, env, commandLog, allowFailure = false }) {
  const result = spawnSync(binary, commandArgs, { cwd, env, encoding: 'utf8', timeout: 90_000 });
  const record = {
    command: binary, args: commandArgs, cwd, status: result.status, signal: result.signal,
    stdout: result.stdout, stderr: result.stderr, error: result.error ? String(result.error) : null,
  };
  commandLog.push(record);
  if (result.error) throw result.error;
  if (!allowFailure) assert.equal(result.status, 0,
    `${binary} ${commandArgs.join(' ')} failed (${result.status}):\n${result.stderr}\n${result.stdout}`);
  return record;
}

async function applyShape(pluginSource, scenario) {
  const targetPath = join(pluginSource, linkName);
  const before = await pathState(targetPath);
  if (before.type === 'file' && before.content === '..') {
    if (scenario.shape === 'file') {
      return {
        fixtureAvailable: true, before, after: before, change: null,
        originalBytesPreserved: true,
        fixtureNote: 'Source checkout materialized the committed symlink as a regular file.',
      };
    }
    return {
      fixtureAvailable: false, before, after: before, change: null,
      originalBytesPreserved: true,
      fixtureNote: 'Source checkout did not materialize a symlink; this scenario is unavailable and is not a client outcome.',
    };
  }
  if (before.type !== 'symlink' || before.readlink.value !== '..') {
    return {
      fixtureAvailable: false, before, after: before, change: null,
      originalBytesPreserved: true,
      fixtureNote: 'Source escape-link did not have the required symlink-to-parent shape; this scenario is unavailable and is not a client outcome.',
    };
  }
  if (scenario.shape === 'symlink' && scenario.target === '..') {
    return { fixtureAvailable: true, before, after: before, change: null, originalBytesPreserved: true };
  }
  await unlink(targetPath);
  if (scenario.shape === 'symlink') await symlink(scenario.target, targetPath, 'dir');
  else if (scenario.shape === 'file') await writeFile(targetPath, scenario.content, { mode: 0o644, flag: 'wx' });
  else await mkdir(targetPath);
  const after = await pathState(targetPath);
  if (scenario.shape === 'symlink') {
    assert.equal(after.type, 'symlink');
    assert.equal(after.readlink.value, scenario.target);
  } else if (scenario.shape === 'file') {
    assert.equal(after.type, 'file');
    assert.equal(after.content, scenario.content);
  } else {
    assert.equal(after.type, 'directory');
  }
  return {
    fixtureAvailable: true, before, after,
    change: scenario.shape === 'symlink'
      ? { operation: 'replace-symlink-target', from: '..', to: scenario.target }
      : scenario.shape === 'file'
        ? { operation: 'replace-symlink-with-regular-file', symlinkTarget: '..', fileContent: scenario.content }
        : { operation: 'replace-symlink-with-directory', symlinkTarget: '..' },
    originalBytesPreserved: false,
  };
}

function killTree(child, signal) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (globalThis.process.platform === 'win32') {
      const taskkillArgs = ['/PID', String(child.pid), '/T', ...(signal === 'SIGKILL' ? ['/F'] : [])];
      spawnSync('taskkill', taskkillArgs, { stdio: 'ignore' });
    }
    else globalThis.process.kill(-child.pid, signal);
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
}

async function runScenario(scenario) {
  const output = join(resultsRoot, scenario.name);
  const home = join(output, 'codex-home');
  const workspace = join(output, 'workspace');
  const marketplace = join(output, 'marketplace');
  const pluginSource = join(marketplace, 'plugins', pluginName);
  const env = cleanEnvironment(home);
  const commandLog = [];
  let installedPath = null;
  let appServer;
  let appStdout;
  let appStderr;
  let pending;
  let protocolError;
  let sequence = 0;

  await rm(output, { recursive: true, force: true });
  await Promise.all([
    mkdir(home, { recursive: true }), mkdir(workspace, { recursive: true }),
    mkdir(join(marketplace, '.agents/plugins'), { recursive: true }),
    mkdir(join(marketplace, 'plugins'), { recursive: true }),
  ]);
  await cp(join(repository, 'plugins', pluginName), pluginSource,
    { recursive: true, verbatimSymlinks: true });
  const shape = await applyShape(pluginSource, scenario);
  const sourceBefore = await snapshot(pluginSource);
  await writeJson(join(output, 'scenario-source.json'), { scenario, shape, sourceBefore });
  if (!shape.fixtureAvailable) {
    await writeJson(join(output, 'run-result.json'), {
      scenario, fixtureAvailable: false, installationSucceeded: false, statusComplete: false,
      advertisedTarget: null, calledServers: [], observationServers: [],
      authenticationUsed: false, externalModelUsed: false,
      limitation: shape.fixtureNote,
    });
    await writeJson(join(output, 'commands.json'), commandLog);
    return;
  }
  const marketplaceName = `apc-symlink-cwd-${scenario.name}`;
  await writeJson(join(marketplace, '.agents/plugins/marketplace.json'), {
    name: marketplaceName,
    plugins: [{
      name: pluginName,
      source: { source: 'local', path: `./plugins/${pluginName}` },
      policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
    }],
  });
  nativeCommand(codex, ['plugin', 'marketplace', 'add', marketplace, '--json'],
    { cwd: workspace, env, commandLog });
  const install = nativeCommand(codex,
    ['plugin', 'add', `${pluginName}@${marketplaceName}`, '--json'],
    { cwd: workspace, env, commandLog, allowFailure: true });
  let installation = null;
  if (install.status === 0) {
    installation = JSON.parse(install.stdout);
    installedPath = installation.installedPath;
  }
  const sourceAfterInstall = await snapshot(pluginSource);
  const installedBefore = installedPath ? await optional(() => snapshot(installedPath)) : null;
  await writeJson(join(output, 'installation.json'), {
    scenario, install, installation,
    sourceBefore, sourceAfterInstall, sourceUnchangedByInstaller:
      sourceBefore.inventorySha256 === sourceAfterInstall.inventorySha256,
    installedBefore,
    authentication: 'No authentication was copied or configured.',
  });
  if (!installedPath) {
    await writeJson(join(output, 'run-result.json'), {
      scenario, installationSucceeded: false, statusComplete: false,
      advertisedTarget: null, calledServers: [], observationServers: [],
      authenticationUsed: false, externalModelUsed: false,
      limitation: 'Native plugin installation failed; no installed plugin could be loaded.',
    });
    await writeJson(join(output, 'commands.json'), commandLog);
    return;
  }

  function failProtocol(error) {
    protocolError = error;
    pending?.reject(error);
  }
  function rpcMessage(method, params) {
    if (protocolError) return Promise.reject(protocolError);
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => failProtocol(new Error(`${method} timed out`)), 90_000);
      const finish = (callback, value) => {
        clearTimeout(timeout);
        pending = undefined;
        callback(value);
      };
      pending = { id, resolve: (value) => finish(resolve, value), reject: (error) => finish(reject, error) };
      appServer.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }
  async function rpcResult(method, params) {
    const response = await rpcMessage(method, params);
    if (response.error) throw new Error(`${method}: ${JSON.stringify(response.error)}`);
    return response.result;
  }
  async function stableStatus(threadId) {
    const polls = [];
    let previous;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const status = await rpcResult('mcpServerStatus/list', { threadId, detail: 'toolsAndAuthOnly' });
      polls.push(status);
      assert.equal(status.nextCursor, null, 'expected complete native MCP status page');
      const signature = JSON.stringify(status.data);
      const valid = status.data.find(({ name }) => name === 'recovery-valid');
      const transitional = status.data.some(({ runtimeStatus }) =>
        ['starting', 'connecting', 'initializing', 'loading', 'pending'].includes(runtimeStatus));
      if (valid?.tools && Object.hasOwn(valid.tools, 'observe') && !transitional && signature === previous) {
        await writeJson(join(output, 'mcp-status-polls.json'), polls);
        return status;
      }
      previous = signature;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    await writeJson(join(output, 'mcp-status-polls.json'), polls);
    throw new Error('MCP inventory did not reach a stable terminal state with recovery-valid available');
  }

  try {
    appStdout = openSync(join(output, 'app-server.stdout.jsonl'), 'w');
    appStderr = openSync(join(output, 'app-server.stderr.log'), 'w');
    appServer = spawn(codex, ['app-server', '--stdio'], {
      cwd: workspace, env, stdio: ['pipe', 'pipe', appStderr], detached: true,
    });
    appServer.once('error', failProtocol);
    appServer.once('exit', (code, signal) => failProtocol(new Error(`app-server exited (${code ?? signal})`)));
    appServer.stdin.on('error', failProtocol);
    createInterface({ input: appServer.stdout }).on('line', (line) => {
      writeSync(appStdout, `${line}\n`);
      try {
        const message = JSON.parse(line);
        if (pending && message.id === pending.id) pending.resolve(message);
        else if (message.method && message.id !== undefined) {
          failProtocol(new Error(`unexpected app-server request: ${message.method}`));
        }
      } catch (error) { failProtocol(error); }
    });
    await rpcResult('initialize', {
      clientInfo: { name: 'apc_symlink_cwd_probe', version: '1.0.0' },
      capabilities: { experimentalApi: true },
    });
    appServer.stdin.write(`${JSON.stringify({ method: 'initialized' })}\n`);
    const { thread } = await rpcResult('thread/start', {
      cwd: workspace, ephemeral: true, approvalPolicy: 'never', sandbox: 'danger-full-access',
    });
    const status = await stableStatus(thread.id);
    await writeJson(join(output, 'mcp-status.json'), status);
    await writeJson(join(output, 'inventory.json'), status.data.map((entry) => ({
      name: entry.name, runtimeStatus: entry.runtimeStatus,
      tools: entry.tools ? Object.keys(entry.tools) : [], toolsError: entry.toolsError,
      authStatus: entry.authStatus, raw: entry,
    })));
    const targetEntry = status.data.find(({ name }) => name === target);
    const advertisedTarget = Boolean(targetEntry?.tools && Object.hasOwn(targetEntry.tools, 'observe'));
    const callServers = ['recovery-valid', ...(advertisedTarget ? [target] : [])];
    const calls = [];
    const observations = [];
    for (const server of callServers) {
      const response = await rpcMessage('mcpServer/tool/call', {
        threadId: thread.id, server, tool: 'observe', arguments: {},
      });
      calls.push({ server, response });
      if (response.result?.structuredContent) observations.push(response.result.structuredContent);
    }
    const valid = observations.find(({ server }) => server === 'recovery-valid');
    assert.equal(valid?.kind, 'mcp-stdio');
    assert.equal(valid?.evidence?.version, 1);
    if (advertisedTarget) {
      const targetObservation = observations.find(({ server }) => server === target);
      assert.equal(targetObservation?.kind, 'mcp-stdio');
      assert.equal(targetObservation?.evidence?.version, 1);
      assert.equal(targetObservation?.evidence?.server, target);
      assert.equal(typeof targetObservation?.evidence?.root, 'string');
      assert.equal(typeof targetObservation?.evidence?.cwd, 'string');
    }
    await writeJson(join(output, 'tool-calls.json'), calls);
    await writeJson(join(output, 'observations.json'), observations);
    await writeJson(join(output, 'raw-errors.json'), {
      statusEntries: status.data.filter((entry) =>
        entry.toolsError != null || entry.runtimeStatus !== 'connected'),
      callErrors: calls.filter(({ response }) =>
        response.error != null || response.result?.isError || response.result?.error),
    });
    await writeJson(join(output, 'run-result.json'), {
      scenario, installationSucceeded: true, threadId: thread.id,
      statusComplete: status.nextCursor === null, advertisedTarget,
      calledServers: callServers, observationServers: observations.map(({ server }) => server),
      authenticationUsed: false, externalModelUsed: false,
    });
  } finally {
    if (appServer?.pid) {
      killTree(appServer, 'SIGTERM');
      if (appServer.exitCode === null && appServer.signalCode === null) {
        await new Promise((resolve) => {
          const timeout = setTimeout(() => { killTree(appServer, 'SIGKILL'); resolve(); }, 5_000);
          appServer.once('exit', () => { clearTimeout(timeout); resolve(); });
        });
      }
    }
    if (appStdout !== undefined) closeSync(appStdout);
    if (appStderr !== undefined) closeSync(appStderr);
    const stderr = await readFile(join(output, 'app-server.stderr.log'), 'utf8');
    const diagnostics = stderr.split('\n').filter(Boolean).flatMap((line) => {
      try { return [JSON.parse(line)]; } catch { return []; }
    }).filter((entry) => entry.fields?.server === target || entry.fields?.server_name === target);
    await writeJson(join(output, 'target-diagnostics.json'), diagnostics);
    const sourceAfter = await snapshot(pluginSource);
    const installedAfter = await optional(() => snapshot(installedPath));
    await writeJson(join(output, 'post-run.json'), {
      sourceBefore, sourceAfter,
      sourceUnchanged: sourceBefore.inventorySha256 === sourceAfter.inventorySha256,
      installedBefore, installedAfter,
      installedUnchanged: installedBefore?.value?.inventorySha256 === installedAfter?.value?.inventorySha256,
      appServerStopped: !appServer || appServer.exitCode !== null || appServer.signalCode !== null,
      authenticationUsed: false, externalModelUsed: false,
    });
    await writeJson(join(output, 'commands.json'), commandLog);
  }
}

await mkdir(resultsRoot, { recursive: true });
const repositorySource = await snapshot(join(repository, 'plugins', pluginName));
await writeJson(join(resultsRoot, 'repository-source.json'), repositorySource);
const versionHome = join(resultsRoot, 'version-home');
const versionWorkspace = join(resultsRoot, 'version-workspace');
await Promise.all([mkdir(versionHome, { recursive: true }), mkdir(versionWorkspace, { recursive: true })]);
const versionCommands = [];
const versionResult = nativeCommand(codex, ['--version'], {
  cwd: versionWorkspace, env: cleanEnvironment(versionHome), commandLog: versionCommands,
});
const version = versionResult.stdout.trim();
await writeJson(join(resultsRoot, 'version.json'), { version, command: versionCommands[0] });
for (const scenario of selectedScenarios) await runScenario(scenario);
const scenarioResults = [];
for (const { name } of scenarios) {
  const result = await optional(() => readFile(join(resultsRoot, name, 'run-result.json'), 'utf8'));
  if (result.value) scenarioResults.push(JSON.parse(result.value));
}
await writeJson(join(resultsRoot, 'summary.json'), {
  version, repository, codex, evidenceRoot, scenarios: scenarioResults,
  authenticationUsed: false, externalModelUsed: false,
});
console.log(JSON.stringify({ version, summary: join(resultsRoot, 'summary.json') }));
