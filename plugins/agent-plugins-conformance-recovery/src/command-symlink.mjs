import { lstatSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, relative } from 'node:path';

// Use the external launcher directly, independently of the
// installed link, to distinguish containment from an unavailable executable.
export function inspectCommandSymlink(root) {
  const windows = process.platform === 'win32';
  const server = `recovery-command-symlink-${windows ? 'windows' : 'posix'}`;
  const result = { server, link: null, root, target: null, control: false, error: null };
  const linkPath = join(root, windows ? 'escape-command-windows.exe' : 'escape-command-posix');
  try {
    result.link = lstatSync(linkPath).isSymbolicLink()
      ? 'symlink' : 'other';
  } catch (error) {
    if (error.code === 'ENOENT') result.link = 'missing';
  }
  try {
    if (result.link === 'symlink') result.target = realpathSync.native(linkPath);
    const launcher = realpathSync.native(windows ? 'C:/Windows/System32/cmd.exe' : '/usr/bin/env');
    if (result.link === 'symlink' && relative(launcher, result.target) !== '') {
      result.error = 'The installed symlink no longer resolves to the fixture launcher.';
      return result;
    }
    const args = [...(windows ? ['/d', '/s', '/c'] : []), 'node', `${root}/dist/probe.mjs`, server, '--command-control'];
    const child = spawnSync(launcher, args, { cwd: root, encoding: 'utf8', timeout: 10_000, windowsHide: true });
    result.control = child.status === 0 && child.stdout === 'APC_COMMAND_SYMLINK_CONTROL_V1';
    if (!result.control) result.error = child.error?.message ?? `Exit ${child.status ?? child.signal}: ${child.stderr ?? ''}`;
  } catch (error) {
    result.error = error.message;
  }
  return result;
}
