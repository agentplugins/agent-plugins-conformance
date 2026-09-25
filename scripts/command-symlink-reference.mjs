import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cp, lstat, mkdir, mkdtemp, readFile, readlink, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { buildReport } from '../plugins/agent-plugins-conformance/src/report.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const sourceRoot = join(root, 'plugins/agent-plugins-conformance-recovery');
const output = join(root, 'reports/command-symlink-reference');
const summaryPath = join(output, 'summary.json');
const marker = 'APC_COMMAND_SYMLINK_CONTROL_V1';
const caseId = 'filesystem.containment.command-symlink-escape';
const candidates = {
  posix: {
    server: 'recovery-command-symlink-posix',
    link: 'escape-command-posix',
    target: '/usr/bin/env',
  },
  win32: {
    server: 'recovery-command-symlink-windows',
    link: 'escape-command-windows.exe',
    target: 'C:/Windows/System32/cmd.exe',
  },
};
const platform = process.platform === 'win32' ? 'win32' : 'posix';
const candidate = candidates[platform];
const temporary = await mkdtemp(join(tmpdir(), 'apc command symlink reference '));
const copiedRoot = join(temporary, 'installed Recovery plugin with spaces');

class CapturingStdioClientTransport extends StdioClientTransport {
  constructor(parameters, stdin, stdout) {
    super(parameters);
    this.stdin = stdin;
    this.stdout = stdout;
  }

  async start() {
    await super.start();
    // This research runner records the exact server bytes alongside the parsed SDK result.
    // The SDK's compiled transport uses an ordinary property for its child process.
    this._process?.stdout?.on('data', (chunk) => this.stdout.push(Buffer.from(chunk)));
  }

  async send(message) {
    this.stdin.push(Buffer.from(`${JSON.stringify(message)}\n`));
    await super.send(message);
  }
}

function errorRecord(error) {
  return {
    name: error?.name ?? 'Error',
    message: error?.message ?? String(error),
    ...(error?.code === undefined ? {} : { code: error.code }),
    ...(error?.stack === undefined ? {} : { stack: error.stack }),
  };
}

async function pathRecord(path) {
  try {
    const info = await lstat(path);
    if (!info.isSymbolicLink()) return { kind: info.isFile() ? 'file' : 'other', path };
    let resolvedTarget = null;
    try { resolvedTarget = await realpath(path); } catch {}
    return { kind: 'symlink', path, linkText: await readlink(path), resolvedTarget };
  } catch (error) {
    if (error.code === 'ENOENT') return { kind: 'missing', path };
    throw error;
  }
}

function run(binary, args, options = {}) {
  return new Promise((resolveRun) => {
    const child = spawn(binary, args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      windowsHide: process.platform === 'win32',
    });
    const stdout = [];
    const stderr = [];
    let spawnError = null;
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, 30_000);
    child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)));
    child.on('error', (error) => { spawnError = error; });
    child.on('close', (code, signal) => {
      clearTimeout(timeout);
      resolveRun({
        code,
        signal,
        timedOut,
        error: spawnError && errorRecord(spawnError),
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
      });
    });
  });
}

function expand(value) {
  return value.replaceAll('${PLUGIN_ROOT}', copiedRoot);
}

async function runMcp(executable, args, name) {
  const stdin = [];
  const stdout = [];
  const stderr = [];
  const protocolErrors = [];
  const transport = new CapturingStdioClientTransport({
    command: executable,
    args,
    cwd: copiedRoot,
    stderr: 'pipe',
  }, stdin, stdout);
  transport.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)));
  const client = new Client({ name: 'command-symlink-reference', version: '1' });
  client.onerror = (error) => protocolErrors.push(errorRecord(error));
  let result;
  try {
    await client.connect(transport);
    const initialized = {
      serverVersion: client.getServerVersion(),
      serverCapabilities: client.getServerCapabilities(),
      instructions: client.getInstructions(),
    };
    const listed = await client.listTools();
    assert.deepEqual(listed.tools.map(({ name: toolName }) => toolName), ['observe']);
    const called = await client.callTool({ name: 'observe', arguments: {} });
    assert.equal(called.isError, undefined);
    assert.deepEqual(JSON.parse(called.content[0].text), called.structuredContent);
    assert.equal(called.structuredContent?.kind, 'mcp-stdio');
    assert.equal(called.structuredContent?.server, name);
    assert.equal(called.structuredContent?.evidence?.server, name);
    const evaluated = buildReport({ schemaVersion: 1, observations: [called.structuredContent] }).results
      .find(({ id }) => id === caseId);
    assert.equal(evaluated.status, 'fail');
    result = { initialized, listed, called, evaluated, protocolErrors };
  } finally {
    let closeError;
    try { await client.close(); } catch (error) { closeError = error; }
    await Promise.all([
      writeFile(join(output, `${name}.mcp.stdin.jsonl`), Buffer.concat(stdin)),
      writeFile(join(output, `${name}.mcp.stdout.jsonl`), Buffer.concat(stdout)),
      writeFile(join(output, `${name}.mcp.stderr.log`), Buffer.concat(stderr)),
    ]);
    if (closeError) throw closeError;
  }
  assert.deepEqual(protocolErrors, [], 'The symlink-launched server produced MCP protocol errors');
  return result;
}

const summary = {
  version: 1,
  platform: process.platform,
  architecture: process.arch,
  node: process.version,
  candidate: {
    server: candidate.server,
    configuredCommand: `./${candidate.link}`,
    expectedTarget: candidate.target,
  },
  artifacts: {
    summary: 'summary.json',
    controlStdout: `${candidate.server}.control.stdout.log`,
    controlStderr: `${candidate.server}.control.stderr.log`,
    mcpStdin: `${candidate.server}.mcp.stdin.jsonl`,
    mcpStdout: `${candidate.server}.mcp.stdout.jsonl`,
    mcpStderr: `${candidate.server}.mcp.stderr.log`,
  },
  status: 'not_verified',
};

try {
  assert.ok(Number.parseInt(process.versions.node, 10) >= 22, 'The reference runner requires Node.js 22 or newer');
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  await cp(sourceRoot, copiedRoot, { recursive: true, verbatimSymlinks: true });

  const config = JSON.parse(await readFile(join(copiedRoot, 'mcp.json'), 'utf8'));
  const configured = config.mcpServers?.[candidate.server];
  assert.deepEqual(configured?.type, 'stdio', `${candidate.server}: expected a stdio fixture`);
  assert.equal(configured.command, `./${candidate.link}`, `${candidate.server}: unexpected command`);
  const executable = resolve(copiedRoot, configured.command.slice(2));
  const args = configured.args.map(expand);
  const target = candidate.target;
  assert.ok(isAbsolute(executable), 'The resolved fixture command must be absolute');
  summary.candidate.executable = executable;
  summary.candidate.args = args;
  summary.candidate.cwd = copiedRoot;
  summary.candidate.source = await pathRecord(join(sourceRoot, candidate.link));
  summary.candidate.copied = await pathRecord(executable);

  const targetRecord = await pathRecord(target);
  summary.control = {
    executable: target,
    args: [...args, '--command-control'],
    cwd: copiedRoot,
    target: targetRecord,
  };
  if (!['file', 'symlink'].includes(targetRecord.kind)) {
    summary.reason = 'The platform launcher target is unavailable.';
  } else {
    const control = await run(target, summary.control.args, { cwd: copiedRoot });
    await Promise.all([
      writeFile(join(output, `${candidate.server}.control.stdout.log`), control.stdout),
      writeFile(join(output, `${candidate.server}.control.stderr.log`), control.stderr),
    ]);
    summary.control.result = {
      code: control.code,
      signal: control.signal,
      timedOut: control.timedOut,
      error: control.error,
      marker: control.stdout.toString('utf8').trim() === marker,
    };
    if (control.error || control.timedOut || control.code !== 0 || !summary.control.result.marker) {
      summary.reason = 'The independent platform launcher control did not run the probe exactly.';
    } else if (summary.candidate.copied.kind !== 'symlink') {
      summary.reason = `The copied fixture entry is ${summary.candidate.copied.kind}, so symlink behavior is not verified.`;
    } else {
      const expectedResolvedTarget = await realpath(target);
      assert.equal(summary.candidate.copied.resolvedTarget, expectedResolvedTarget,
        `${candidate.server}: copied symlink resolves to an unexpected target`);
      const targetRelativeToRoot = relative(copiedRoot, expectedResolvedTarget);
      const outsideRoot = isAbsolute(targetRelativeToRoot) || targetRelativeToRoot === '..' ||
        targetRelativeToRoot.startsWith(`..${sep}`);
      assert.ok(outsideRoot,
        `${candidate.server}: expected an external symlink target`);
      summary.mcp = await runMcp(executable, args, candidate.server);
      summary.status = 'observed_external_target_followed';
      summary.reason = 'The controlled reference client followed the external command symlink and completed initialize, tools/list, and tools/call.';
    }
  }
} catch (error) {
  summary.status = 'error';
  summary.error = errorRecord(error);
  process.exitCode = 1;
} finally {
  await mkdir(output, { recursive: true });
  await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  await rm(temporary, { recursive: true, force: true });
}

console.log(`${summary.status}: ${summary.reason ?? summary.error?.message}`);
console.log(relative(root, summaryPath));
