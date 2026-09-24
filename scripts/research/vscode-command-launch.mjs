import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { transform } from 'esbuild';

// Execute the released functions unchanged, with Node filesystem/path adapters.
// This exercises the launcher boundary, not the complete VS Code application.
const revision = '2242ebbb54efeeb0129e08e919e7e8d43033cd83';
async function source(file) {
  const response = await fetch(`https://raw.githubusercontent.com/microsoft/vscode/${revision}/${file}`);
  assert.equal(response.status, 200);
  return response.text();
}
const processSource = await source('src/vs/base/node/processes.ts');
const mcpSource = await source('src/vs/workbench/api/node/extHostMcpNode.ts');
const start = processSource.indexOf('async function fileExistsDefault(');
const end = processSource.indexOf('/**\n * Kills a process', start);
const helperStart = mcpSource.indexOf('const windowsShellScriptRe =');
assert.ok(start > 0 && end > start && helperStart > 0);
const extracted = processSource.slice(start, end) + '\n' + mcpSource.slice(helperStart);
const adapters = `
import * as path from 'node:path';
import { promises } from 'node:fs';
const processCommon = process;
const Platform = { isWindows: process.platform === 'win32' };
const Types = { isString: value => typeof value === 'string' };
const getCaseInsensitive = (obj, key) => obj[Object.keys(obj).find(k => k.toLowerCase() === key.toLowerCase())];
const pfs = { Promises: { exists: async p => { try { await promises.access(p); return true; } catch { return false; } } } };
`;
const { code } = await transform(adapters + extracted, { loader: 'ts', format: 'esm', target: 'node22' });
const { formatSubprocessArguments } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
const configuredArgs = ['arg with spaces', '', 'literal-value'];
const messages = [
  { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'vscode-launch-evidence', version: '1' } } },
  { jsonrpc: '2.0', method: 'notifications/initialized' },
  { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'observe', arguments: {} } },
];
async function attempt(root, filename) {
  const command = path.join(root, 'bin', filename);
  assert.ok(path.isAbsolute(command));
  const launch = await formatSubprocessArguments(command, configuredArgs, root, process.env);
  const result = { client: 'VS Code extracted production launcher', revision, command, launch };
  await new Promise(resolve => {
    const child = spawn(launch.executable, launch.args, { stdio: 'pipe', cwd: root, env: process.env, shell: launch.shell });
    let stdout = '', stderr = '', pending = '';
    const timeout = setTimeout(() => { result.status = 'timeout'; child.kill(); }, 15_000);
    child.stdout.on('data', data => {
      stdout += data;
      pending += data;
      const lines = pending.split('\n');
      pending = lines.pop();
      for (const line of lines) {
        try {
          const message = JSON.parse(line);
          if (message.id === 1) child.stdin.write(messages.slice(1).map(value => JSON.stringify(value)).join('\n') + '\n');
          if (message.id === 2) child.stdin.end();
        } catch { /* Preserve malformed stdout for validation below. */ }
      }
    });
    child.stderr.on('data', data => { stderr += data; });
    child.stdin.on('error', () => {});
    child.on('error', error => { result.status = 'spawn-error'; result.error = { code: error.code, message: error.message }; });
    child.on('close', exitCode => {
      clearTimeout(timeout);
      Object.assign(result, { exitCode, stdout, stderr });
      if (!result.status) {
        try {
          const output = stdout.trim().split(/\r?\n/).map(line => JSON.parse(line));
          const response = output.find(message => message.id === 2);
          const observation = JSON.parse(response.result.content[0].text);
          assert.deepEqual(observation.evidence.argv, ['command-token', 'exact', ...configuredArgs]);
          assert.equal(exitCode, 0);
          result.status = 'pass';
          result.argv = observation.evidence.argv;
        } catch (error) { result.status = 'protocol-error'; result.error = error.message; }
      }
      resolve();
    });
    child.stdin.write(JSON.stringify(messages[0]) + '\n');
  }).catch(error => { result.status = 'spawn-error'; result.error = { code: error.code, message: error.message }; });
  console.log(JSON.stringify(result));
  return result;
}
assert.equal(process.platform, 'win32');
const parent = await fs.mkdtemp(path.join(tmpdir(), 'apc vscode evidence '));
try {
  const root = path.join(parent, 'installed plugin with spaces');
  await fs.cp(new URL('../../plugins/agent-plugins-conformance-core/', import.meta.url), root, { recursive: true });
  const direct = await attempt(root, 'probe token.cmd');
  await attempt(root, 'probe token');
  assert.equal(direct.status, 'pass', 'The explicit .cmd control must work');
} finally { await fs.rm(parent, { recursive: true, force: true }); }
