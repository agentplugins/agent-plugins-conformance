import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { evaluate } from './evaluate.mjs';

const root = await realpath(fileURLToPath(new URL('../plugins/agent-plugins-conformance-recovery/', import.meta.url)));
const data = await mkdtemp(join(tmpdir(), 'apc-symlink-reference-'));
const output = fileURLToPath(new URL('./results/', import.meta.url));
const config = JSON.parse(await readFile(join(root, 'mcp.json'), 'utf8')).mcpServers;
const observations = {};
try {
  for (const name of ['recovery-valid', 'recovery-cwd-symlink-escape']) {
    const entry = config[name];
    const client = new Client({ name: 'symlink-reference-prototype', version: '1' });
    try {
      // Deliberately bypass Agent Plugins validation to prove the failure witness is runnable.
      await client.connect(new StdioClientTransport({
        command: process.execPath,
        args: entry.args.map((argument) => argument.replaceAll('${PLUGIN_ROOT}', root)),
        cwd: entry.cwd === undefined ? root : resolve(root, entry.cwd),
        env: { PLUGIN_ROOT: root, PLUGIN_DATA: data },
        stderr: 'pipe',
      }));
      const result = await client.callTool({ name: 'observe', arguments: {} });
      assert.notEqual(result.isError, true);
      observations[name] = result.structuredContent;
    } finally {
      await client.close();
    }
  }
  const control = observations['recovery-valid'];
  const target = observations['recovery-cwd-symlink-escape'];
  const installed = control.evidence.cwdSymlink;
  assert.equal(installed.kind, 'symlink');
  assert.equal(installed.linkText, '..');
  assert.equal(target.evidence.cwd, installed.resolvedPath);
  const result = evaluate({ platform: process.platform, installed, control, target });
  assert.equal(result.status, 'fail');
  await mkdir(output, { recursive: true });
  await writeFile(join(output, 'reference.json'), JSON.stringify({
    evidenceType: 'Direct MCP SDK reference harness; Agent Plugins validation intentionally bypassed',
    platform: process.platform, observations, result,
  }, null, 2) + '\n');
  console.log(JSON.stringify({ result, root, cwd: target.evidence.cwd, output }));
} finally {
  await rm(data, { recursive: true, force: true });
}
