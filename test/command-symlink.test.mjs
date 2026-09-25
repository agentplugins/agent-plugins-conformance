import assert from 'node:assert/strict';
import { cp, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { inspectCommandSymlink } from '../plugins/agent-plugins-conformance-recovery/src/command-symlink.mjs';
import { buildReport } from '../plugins/agent-plugins-conformance/src/report.mjs';

const CASE_ID = 'filesystem.containment.command-symlink-escape';

test('collector reports a rewritten command link actual target without treating the fixed launcher as its control', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'command-symlink-collector-'));
  t.after(() => rm(directory, { recursive: true, force: true }));

  const root = path.join(directory, 'copied recovery plugin');
  await cp(new URL('../plugins/agent-plugins-conformance-recovery/', import.meta.url), root, {
    recursive: true,
    verbatimSymlinks: true,
  });
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
