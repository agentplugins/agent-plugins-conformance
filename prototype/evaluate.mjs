import { posix, win32 } from 'node:path';

// Prototype decision function, not part of the installed reporter contract.
export function evaluate({ platform, input, installed, inventory, control, target }) {
  const paths = platform === 'win32' ? win32 : posix;
  const outside = (root, path) => {
    if (!paths.isAbsolute(root ?? '') || !paths.isAbsolute(path ?? '')) return false;
    const relative = paths.relative(root, path);
    return relative === '..' || relative.startsWith(`..${paths.sep}`) || paths.isAbsolute(relative);
  };
  const result = (status, reason) => ({ status, reason });
  if (target?.kind === 'mcp-stdio' && target.server === 'recovery-cwd-symlink-escape'
      && outside(target.evidence?.root, target.evidence?.cwd)) {
    return result('fail', 'The target ran with a working directory outside its plugin root.');
  }
  const escaping = (facts) => facts?.kind === 'symlink' && facts.resolvedKind === 'directory'
    && outside(facts.root, facts.resolvedPath);
  if (!escaping(input) && !escaping(installed)) {
    return result('not_verified', 'No evidence establishes that the client received or loaded an escaping symlink.');
  }
  if (inventory?.advertised === true || target?.server === 'recovery-cwd-symlink-escape') {
    return result('fail', 'The client exposed or ran the server from the supplied invalid configuration.');
  }
  if (inventory?.complete !== true || inventory.advertised !== false) {
    return result('not_verified', 'Complete target discovery evidence is missing.');
  }
  if (control?.kind !== 'mcp-stdio' || control.server !== 'recovery-valid') {
    return result('not_verified', 'The working Recovery control is missing.');
  }
  return result('pass', 'The escaping input was established, the target was excluded, and the Recovery control worked.');
}
