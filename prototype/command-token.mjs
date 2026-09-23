export const COMMAND_TOKEN_ARGS = Object.freeze(['arg with spaces', '', 'literal-value']);

const variants = Object.freeze({
  posix: {
    server: 'command-token-posix',
    exactOrigin: 'posix-exact',
    decoyOrigin: 'posix-decoy',
    splitTail: 'token.sh',
  },
  windows: {
    server: 'command-token-windows',
    exactOrigin: 'windows-exact',
    decoyOrigin: 'windows-decoy',
    splitTail: 'token.cmd',
  },
});

function corePathFlavor(observation) {
  if (observation?.kind !== 'mcp-stdio' || observation.server !== 'default') return null;
  if (observation.evidence?.version !== 1 || observation.evidence.server !== 'default') return null;
  const { root } = observation.evidence;
  if (typeof root !== 'string') return null;
  if (/^[A-Za-z]:[\\/]/.test(root) || /^\\\\[^\\]+\\[^\\]+/.test(root)) return 'windows';
  return root.startsWith('/') ? 'posix' : null;
}

function matchesPlatform(evidence, pathFlavor) {
  return pathFlavor === 'windows' ? evidence.platform === 'win32' :
    typeof evidence.platform === 'string' && evidence.platform !== 'win32';
}

export function evaluateCommandToken({ coreObservation, observations }) {
  const pathFlavor = corePathFlavor(coreObservation);
  if (!pathFlavor) {
    return { status: 'not_verified', pathFlavor: null, detail: 'A valid Core default observation did not establish the host path flavor.' };
  }
  const variant = variants[pathFlavor];
  const candidates = Array.isArray(observations)
    ? observations.filter((observation) => observation?.kind === 'mcp-command-token-prototype' &&
      observation.server === variant.server && observation.evidence?.version === 1 &&
      observation.evidence.pathFlavor === pathFlavor && matchesPlatform(observation.evidence, pathFlavor))
    : [];
  const split = candidates.some(({ evidence }) => evidence.wrapperOrigin === variant.decoyOrigin &&
    evidence.marker === 'split' && Array.isArray(evidence.argv) && evidence.argv[0] === variant.splitTail);
  if (split) {
    return { status: 'fail', pathFlavor, detail: `The ${pathFlavor} decoy wrapper observed the command tail as an argument.` };
  }
  const intact = candidates.some(({ evidence }) => evidence.wrapperOrigin === variant.exactOrigin &&
    evidence.marker === 'intact');
  if (intact) {
    return { status: 'pass', pathFlavor, detail: `The ${pathFlavor} exact-name wrapper was selected.` };
  }
  return { status: 'not_verified', pathFlavor, detail: `No attributable ${pathFlavor} exact or split wrapper observation was recorded.` };
}
