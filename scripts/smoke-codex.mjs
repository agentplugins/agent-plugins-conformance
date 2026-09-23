import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, openSync, writeSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, relative } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { CASE_IDS } from '../plugins/agent-plugins-conformance/src/cases.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const output = join(root, 'reports/codex');
const reportPath = join(output, 'report.json');
const [codex, ...extra] = process.argv.slice(2);
assert.ok(codex && isAbsolute(codex) && extra.length === 0,
  'Usage: node scripts/smoke-codex.mjs <absolute-codex-binary>');
const names = ['agent-plugins-conformance-core', 'agent-plugins-conformance', 'agent-plugins-conformance-recovery'];
const servers = ['default', 'relative', 'root', 'data', 'http', 'recovery-valid'];
// Redirect refusal requires the guiding agent to interpret and preserve the native error.
const coveredCases = CASE_IDS.filter((id) => (id.startsWith('mcp.') || id.startsWith('filesystem.')) &&
  id !== 'mcp.streamable-http.headers.cross-origin-redirect');
const temporary = await realpath(await mkdtemp(join(tmpdir(), 'apc-codex-smoke-')));
const home = join(temporary, 'codex-home');
const workspace = join(temporary, 'workspace');
const marketplace = join(temporary, 'marketplace');
const searchPath = Object.entries(process.env).find(([key]) => key.toUpperCase() === 'PATH')?.[1] ?? '';
const env = Object.fromEntries(Object.entries(process.env)
  .filter(([key]) => !/OPENAI|CODEX|CHATGPT|^APC_|^PLUGIN_|^PATH$/i.test(key)));
env.CODEX_HOME = home;
env.PATH = `${dirname(process.execPath)}${delimiter}${searchPath}`;
let appServer;
let stderr;
let httpServer;
let httpStdout;
let httpStderr;
let pending;
let protocolError;
let sequence = 0;

function run(binary, args, input) {
  const result = spawnSync(binary, args, {
    cwd: workspace, env, input, encoding: 'utf8', timeout: 90_000,
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0,
    `${binary} ${args.join(' ')} failed (${result.status}):\n${result.stderr}\n${result.stdout}`);
  return result.stdout;
}

async function hashes(directory) {
  const files = (await readdir(directory, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile() || entry.isSymbolicLink())
    .map((entry) => ({ path: join(entry.parentPath, entry.name), symlink: entry.isSymbolicLink() }))
    .sort((a, b) => a.path.localeCompare(b.path));
  return Promise.all(files.map(async ({ path, symlink }) => [relative(directory, path),
    symlink ? 'symlink' : 'file',
    symlink ? await readlink(path) : createHash('sha256').update(await readFile(path)).digest('hex')]));
}

function failProtocol(error) {
  protocolError = error;
  pending?.reject(error);
}

function rpc(method, params) {
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

function killTree(signal) {
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(appServer.pid), '/T', '/F'], { timeout: 10_000 });
  } else {
    try { process.kill(-appServer.pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
}

async function startHttp(script) {
  httpStdout = openSync(join(output, 'http.stdout.log'), 'w');
  httpStderr = openSync(join(output, 'http.stderr.log'), 'w');
  httpServer = spawn(process.execPath, [script], {
    cwd: workspace, env, stdio: ['ignore', 'pipe', httpStderr],
  });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => fail(new Error('HTTP fixture readiness timed out')), 10_000);
    const fail = (error) => {
      clearTimeout(timeout);
      failProtocol(error);
      reject(error);
    };
    httpServer.on('error', (error) => fail(new Error(`HTTP fixture could not start: ${error.message}`)));
    httpServer.on('exit', (code, signal) => fail(new Error(`HTTP fixture exited (${code ?? signal}); see http.stderr.log`)));
    createInterface({ input: httpServer.stdout }).on('line', (line) => {
      writeSync(httpStdout, `${line}\n`);
      try {
        const message = JSON.parse(line);
        if (message.ready === true && typeof message.url === 'string') {
          clearTimeout(timeout);
          resolve();
        }
      } catch {
        // Preserve non-JSON diagnostics while waiting for the readiness record.
      }
    });
  });
}

async function stopHttp() {
  if (!httpServer?.pid || httpServer.exitCode !== null || httpServer.signalCode !== null) return;
  await new Promise((resolve) => {
    const timeout = setTimeout(() => {
      httpServer.kill('SIGKILL');
      resolve();
    }, 5_000);
    httpServer.once('exit', () => { clearTimeout(timeout); resolve(); });
    httpServer.kill('SIGTERM');
  });
}

try {
  await rm(output, { recursive: true, force: true });
  await Promise.all([mkdir(output, { recursive: true }), mkdir(home), mkdir(workspace),
    mkdir(join(marketplace, '.agents/plugins'), { recursive: true })]);
  const version = run(codex, ['--version']).trim();
  console.log(version);
  await writeFile(join(output, 'codex-version.txt'), `${version}\n`);
  for (const name of names) {
    await cp(join(root, 'plugins', name), join(marketplace, 'plugins', name), { recursive: true, verbatimSymlinks: true });
  }
  await writeFile(join(marketplace, '.agents/plugins/marketplace.json'), JSON.stringify({
    name: 'apc-native-smoke',
    plugins: names.map((name) => ({ name, source: { source: 'local', path: `./plugins/${name}` },
      policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' } })),
  }));
  run(codex, ['plugin', 'marketplace', 'add', marketplace, '--json']);
  const installed = [];
  for (const name of names) {
    const { installedPath } = JSON.parse(run(codex, ['plugin', 'add', `${name}@apc-native-smoke`, '--json']));
    const original = await hashes(join(root, 'plugins', name));
    const actual = await hashes(installedPath);
    let expected = original;
    if (name === 'agent-plugins-conformance-recovery') {
      assert.deepEqual(original.find(([path]) => path === 'escape-link'), ['escape-link', 'symlink', '..'],
        'The source fixture must contain the escaping symlink');
      // Removing the escaping link during installation is an allowed containment outcome.
      if (!actual.some(([path]) => path === 'escape-link')) expected = original.filter(([path]) => path !== 'escape-link');
    }
    assert.deepEqual(actual, expected, `${name}: installed package differs from source`);
    installed.push(installedPath);
  }
  const reporter = join(installed[1], 'skills/run-conformance/scripts/report.mjs');
  const record = (message) => run(process.execPath, [reporter, reportPath], JSON.stringify(message));
  record({ action: 'start' });
  await startHttp(join(installed[0], 'dist/serve-http.mjs'));

  stderr = openSync(join(output, 'app-server.stderr.log'), 'w');
  appServer = spawn(codex, ['app-server', '--stdio'], {
    cwd: workspace, env, stdio: ['pipe', 'pipe', stderr], detached: true,
  });
  appServer.on('error', failProtocol);
  appServer.on('exit', (code, signal) => failProtocol(new Error(`app-server exited (${code ?? signal})`)));
  appServer.stdin.on('error', failProtocol);
  const lines = createInterface({ input: appServer.stdout });
  lines.on('line', (line) => {
    try {
      const message = JSON.parse(line);
      if (pending && message.id === pending.id) {
        if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
        else pending.resolve(message.result);
      } else if (message.method && message.id !== undefined) {
        failProtocol(new Error(`Unexpected app-server request: ${message.method}`));
      }
    } catch (error) {
      failProtocol(error);
    }
  });
  await rpc('initialize', {
    clientInfo: { name: 'apc_native_smoke', version: '1.0.0' },
    capabilities: { experimentalApi: true },
  });
  appServer.stdin.write(`${JSON.stringify({ method: 'initialized' })}\n`);
  const { thread } = await rpc('thread/start', {
    cwd: workspace, ephemeral: true, approvalPolicy: 'never', sandbox: 'danger-full-access',
  });
  const status = await rpc('mcpServerStatus/list', { threadId: thread.id, detail: 'toolsAndAuthOnly' });
  await writeFile(join(output, 'mcp-status.json'), `${JSON.stringify(status, null, 2)}\n`);
  assert.equal(status.nextCursor, null, 'Expected a complete native MCP inventory');
  const advertisedInvalidServers = [];
  for (const server of ['recovery-cwd-invalid-form', 'recovery-cwd-escape', 'recovery-cwd-data-escape', 'recovery-cwd-symlink-escape', 'recovery-unknown-field',
    'recovery-env-plugin-root', 'recovery-env-plugin-data',
    'recovery-http-fragment', 'recovery-http-userinfo', 'recovery-http-duplicate-headers',
    'recovery-http-header-name', 'recovery-http-header-value']) {
    const entry = status.data.find(({ name }) => name === server);
    const advertised = entry !== undefined && Object.hasOwn(entry.tools, 'observe');
    const symlinkStartupFailure = server === 'recovery-cwd-symlink-escape' &&
      entry?.runtimeStatus === 'failed' && Object.keys(entry.tools).length === 0;
    if (advertised) advertisedInvalidServers.push(server);
    if (advertised || !entry || symlinkStartupFailure || (entry.runtimeStatus === 'connected' && entry.toolsError === null)) {
      record({ action: 'record', observation: { kind: 'mcp-discovery', server, advertised } });
    }
  }
  for (const server of [...servers, ...advertisedInvalidServers]) {
    assert.equal(status.data.filter(({ name }) => name === server).length, 1,
      `${server}: expected one native MCP server`);
    const result = await rpc('mcpServer/tool/call', {
      threadId: thread.id, server, tool: 'observe', arguments: {},
    });
    assert.ok(!result.isError && !result.error, `${server}: observe failed: ${JSON.stringify(result)}`);
    const observation = result.structuredContent;
    assert.equal(observation?.kind, server === 'http' || server.startsWith('recovery-http-') ? 'mcp-streamable-http' : 'mcp-stdio',
      `${server}: missing observation`);
    assert.equal(observation.server, server, `${server}: unexpected observation server`);
    record({ action: 'record', observation });
  }
  const report = JSON.parse(await readFile(reportPath, 'utf8'));
  assert.equal(report.observations.find((observation) => observation.kind === 'mcp-streamable-http')?.serverHealthCheck,
    'passed', 'HTTP fixture health check did not pass');
  assert.equal(report.summary.fail, 0, `Report contains failed cases: ${JSON.stringify(report.summary)}`);
  for (const id of coveredCases) {
    assert.equal(report.results.find((result) => result.id === id)?.status, 'pass', `${id} did not pass`);
  }
  console.log(`Native Codex smoke passed: ${coveredCases.length} Core and Recovery cases; ${report.summary.not_verified} not verified.`);
  console.log(`Report: ${reportPath}`);
} catch (error) {
  console.error(`Native Codex smoke failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  await stopHttp();
  httpServer?.stdout?.destroy();
  if (httpStdout !== undefined) closeSync(httpStdout);
  if (httpStderr !== undefined) closeSync(httpStderr);
  if (appServer?.pid) {
    // Stop the native MCP children along with app-server.
    killTree('SIGTERM');
    if (appServer.exitCode === null && appServer.signalCode === null) {
      await new Promise((resolve) => {
        const timeout = setTimeout(() => {
          killTree('SIGKILL');
          resolve();
        }, 5_000);
        appServer.once('exit', () => { clearTimeout(timeout); resolve(); });
      });
    }
  }
  if (stderr !== undefined) closeSync(stderr);
  await rm(temporary, { recursive: true, force: true });
}
