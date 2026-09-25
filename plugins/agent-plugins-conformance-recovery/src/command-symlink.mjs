import { lstatSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

// Prototype control: use the external launcher directly, independently of the
// installed link, to distinguish containment from an unavailable executable.
export function inspectCommandSymlink(root) {
  const windows = process.platform === 'win32';
  const server = `recovery-command-symlink-${windows ? 'windows' : 'posix'}`;
  const result = { server, link: null, root, target: null, control: false, error: null };
  try {
    result.link = lstatSync(join(root, windows ? 'escape-command-windows.exe' : 'escape-command-posix')).isSymbolicLink()
      ? 'symlink' : 'other';
  } catch (error) {
    if (error.code === 'ENOENT') result.link = 'missing';
  }
  try {
    result.target = realpathSync.native(windows ? 'C:/Windows/System32/cmd.exe' : '/usr/bin/env');
    const args = [...(windows ? ['/d', '/s', '/c'] : []), 'node', join(root, 'dist/probe.mjs'), server, '--command-control'];
    const child = spawnSync(result.target, args, { cwd: root, encoding: 'utf8', timeout: 10_000, windowsHide: true });
    result.control = child.status === 0 && child.stdout === 'APC_COMMAND_SYMLINK_CONTROL_V1';
    if (!result.control) result.error = child.error?.message ?? `Exit ${child.status ?? child.signal}: ${child.stderr ?? ''}`;
  } catch (error) {
    result.error = error.message;
  }
  return result;
}
