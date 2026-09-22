import assert from 'node:assert/strict';
import { lstat, mkdir, readFile, readlink, symlink, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const path = 'plugins/agent-plugins-conformance-recovery/escape-link';
const entry = await lstat(path);
const original = entry.isSymbolicLink()
  ? { kind: 'symlink', target: await readlink(path) }
  : { kind: entry.isFile() ? 'file' : 'other', content: await readFile(path, 'utf8') };
if (!entry.isSymbolicLink()) {
  assert.equal(original.kind, 'file');
  assert.equal(original.content, '..');
  // Provision the canonical fixture for this experiment, recording checkout conversion separately.
  // This is CI preparation, not evidence of what an ordinary client installation preserves.
  await unlink(path);
  await symlink('..', path, 'dir');
}
assert.equal(await readlink(path), '..');
await mkdir('prototype/ci-artifact', { recursive: true });
await writeFile(join('prototype/ci-artifact', 'input-preparation.json'), JSON.stringify({
  platform: process.platform, originalCheckout: original,
  canonicalSymlinkProvisionedByHarness: !entry.isSymbolicLink(),
}, null, 2) + '\n');
