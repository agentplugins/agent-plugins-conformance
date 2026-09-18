import path from 'node:path';
import { CASES, MCP_CWD_VARIANTS } from './cases.mjs';

export { CASES, CASE_IDS } from './cases.mjs';
const CORE_SERVERS = Object.keys(MCP_CWD_VARIANTS);
const SERVERS = [...CORE_SERVERS, 'recovery-valid'];
const CORE_SKILLS = {
  'conformance-alpha': 'APC_ALPHA_V1',
  'conformance-beta': 'APC_BETA_V1',
};
const SKILLS = { ...CORE_SKILLS, 'conformance-recovery-valid': 'APC_RECOVERY_VALID_V1' };
const ENV_KEYS = ['PLUGIN_ROOT', 'PLUGIN_DATA', 'APC_VALUE', 'APC_EXPANSION', 'APC_LITERAL'];

function invalid(at, reason) {
  throw new TypeError(`${at}: ${reason}`);
}

function object(value, keys, required, at) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    invalid(at, 'expected an object');
  }
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) invalid(`${at}.${key}`, 'unknown field');
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) invalid(`${at}.${key}`, 'required field is missing');
  }
}

function string(value, at, allowEmpty = false) {
  if (typeof value !== 'string' || (!allowEmpty && value.trim().length === 0) ||
      value.includes('\0')) {
    invalid(at, `expected ${allowEmpty ? 'a' : 'a nonempty'} string without NUL`);
  }
}

function member(value, values, at) {
  if (!values.includes(value)) invalid(at, `expected one of: ${values.join(', ')}`);
}

function array(value, at) {
  if (!Array.isArray(value)) invalid(at, 'expected an array');
}

// Select the producing operating system's path rules, even for reports read elsewhere.
function pathFlavor(value) {
  if (typeof value !== 'string') return null;
  if (/^[A-Za-z]:[\\/]/.test(value) || /^\\\\[^\\]+\\[^\\]+/.test(value)) return path.win32;
  return value.startsWith('/') ? path.posix : null;
}

function samePath(actual, expected, flavor) {
  return pathFlavor(actual) === flavor && pathFlavor(expected) === flavor &&
    flavor.resolve(actual) === flavor.resolve(expected);
}

function validate(input) {
  object(input, ['schemaVersion', 'observations'],
    ['schemaVersion', 'observations'], 'input');
  if (input.schemaVersion !== 1) invalid('input.schemaVersion', 'expected 1');
  array(input.observations, 'input.observations');
  const runtime = new Map();
  const skills = new Map();
  for (const [index, observation] of input.observations.entries()) {
    const at = `input.observations[${index}]`;
    object(observation, ['kind', 'server', 'evidence', 'skill', 'marker'], ['kind'], at);
    member(observation.kind, ['mcp-stdio', 'skill'], `${at}.kind`);
    if (observation.kind === 'mcp-stdio') {
      object(observation, ['kind', 'server', 'evidence'], ['kind', 'server', 'evidence'], at);
      member(observation.server, SERVERS, `${at}.server`);
      if (runtime.has(observation.server)) invalid(at, `duplicate mcp-stdio observation: ${observation.server}`);
      const evidenceAt = `${at}.evidence`;
      const evidence = observation.evidence;
      const keys = observation.server === 'recovery-valid'
        ? ['version', 'server'] : ['version', 'server', 'root', 'cwd', 'resolvedData', 'argv', 'env'];
      if (observation.server === 'default') keys.push('dataWrite');
      object(evidence, keys, keys, evidenceAt);
      if (evidence.version !== 1) invalid(`${evidenceAt}.version`, 'expected 1');
      if (evidence.server !== observation.server) invalid(`${evidenceAt}.server`, 'must match observation.server');
      if (observation.server === 'recovery-valid') {
        runtime.set(observation.server, evidence);
        continue;
      }
      for (const field of ['root', 'cwd']) {
        string(evidence[field], `${evidenceAt}.${field}`);
        if (!pathFlavor(evidence[field])) invalid(`${evidenceAt}.${field}`, 'expected an absolute POSIX or Windows path');
      }
      if (evidence.resolvedData !== null) {
        string(evidence.resolvedData, `${evidenceAt}.resolvedData`);
        if (!pathFlavor(evidence.resolvedData)) invalid(`${evidenceAt}.resolvedData`, 'expected null or an absolute POSIX or Windows path');
      }
      array(evidence.argv, `${evidenceAt}.argv`);
      evidence.argv.forEach((argument, i) => string(argument, `${evidenceAt}.argv[${i}]`, true));
      object(evidence.env, ENV_KEYS, [], `${evidenceAt}.env`);
      for (const [key, value] of Object.entries(evidence.env)) string(value, `${evidenceAt}.env.${key}`, true);
      if (observation.server === 'default' && evidence.dataWrite !== null) {
        const at = `${evidenceAt}.dataWrite`;
        const write = evidence.dataWrite;
        object(write, ['path', 'error', 'cleanupError'], ['path', 'error', 'cleanupError'], at);
        string(write.path, `${at}.path`);
        if (!pathFlavor(evidence.root).isAbsolute(write.path)) invalid(`${at}.path`, 'expected an absolute path for the producing operating system');
        for (const field of ['error', 'cleanupError']) {
          if (write[field] === null) continue;
          const keys = field === 'error' ? ['operation', 'code', 'message'] : ['code', 'message'];
          object(write[field], keys, keys, `${at}.${field}`);
          if (field === 'error') member(write.error.operation, ['create', 'write', 'close'], `${at}.error.operation`);
          if (write[field].code !== null) string(write[field].code, `${at}.${field}.code`);
          string(write[field].message, `${at}.${field}.message`);
        }
      }
      runtime.set(observation.server, evidence);
    } else {
      object(observation, ['kind', 'skill', 'marker'], ['kind', 'skill', 'marker'], at);
      member(observation.skill, Object.keys(SKILLS), `${at}.skill`);
      if (skills.has(observation.skill)) invalid(at, `duplicate skill observation: ${observation.skill}`);
      string(observation.marker, `${at}.marker`);
      skills.set(observation.skill, observation.marker);
    }
  }
  return { runtime, skills };
}

export function buildReport(input) {
  const { runtime, skills } = validate(input);
  const results = new Map(CASES.map(({ id }) => [id, { id, status: 'not_verified', detail: 'No observation supplied.' }]));
  const set = (id, status, detail) => results.set(id, { id, status, detail });
  const check = (id, condition, pass, fail) => set(id, condition ? 'pass' : 'fail', condition ? pass : fail);
  const mismatch = (field, expected, observed) =>
    `${field}: expected ${JSON.stringify(expected)}; observed ${observed === undefined ? 'missing' : JSON.stringify(observed)}.`;

  const missingSkills = Object.keys(CORE_SKILLS).filter((skill) => !skills.has(skill));
  const wrongSkills = Object.entries(CORE_SKILLS)
    .filter(([skill, marker]) => skills.has(skill) && skills.get(skill) !== marker)
    .map(([skill, marker]) => mismatch(`Skill marker for ${skill}`, marker, skills.get(skill)));
  const skillDetails = [...wrongSkills];
  if (missingSkills.length) skillDetails.push(`Missing skill observations: ${missingSkills.join(', ')}.`);
  set('skills.discovery.immediate-children', wrongSkills.length ? 'fail' : missingSkills.length ? 'not_verified' : 'pass',
    skillDetails.length ? skillDetails.join(' ') : 'Agent reported the expected client-loaded markers for both immediate child skills.');
  for (const server of CORE_SERVERS.filter((server) => runtime.has(server))) {
    const evidence = runtime.get(server);
    set(`mcp.stdio.tool-availability.cwd-${MCP_CWD_VARIANTS[server]}`, 'pass', 'Valid runtime evidence supplied for this server.');
    const flavor = pathFlavor(evidence.root);
    const target = server === 'default' ? evidence.root
      : server === 'data' ? evidence.resolvedData
      : flavor.join(evidence.root, 'probe-workdir');
    if (target === null) {
      set(`mcp.stdio.cwd.${MCP_CWD_VARIANTS[server]}`, 'not_verified', 'PLUGIN_DATA could not be resolved; the expected working directory is unavailable.');
    } else {
      check(`mcp.stdio.cwd.${MCP_CWD_VARIANTS[server]}`, samePath(evidence.cwd, target, flavor),
        'Working directory matches the resolved expected path.', mismatch('Working directory', target, evidence.cwd));
    }
  }
  if (skills.has('conformance-recovery-valid')) {
    check('skills.recovery.valid-skill-available', skills.get('conformance-recovery-valid') === SKILLS['conformance-recovery-valid'],
      'Agent reported the expected client-loaded marker for the valid recovery skill.',
      mismatch('Skill marker for conformance-recovery-valid', SKILLS['conformance-recovery-valid'], skills.get('conformance-recovery-valid')));
  }
  if (runtime.has('recovery-valid')) {
    set('mcp.stdio.recovery.valid-server-available', 'pass', 'Valid runtime evidence supplied for the recovery server.');
  }
  const evidence = runtime.get('default');
  if (evidence) {
    const { root, env, argv } = evidence;
    const flavor = pathFlavor(root);
    check('mcp.stdio.env.plugin-root', samePath(env.PLUGIN_ROOT, root, flavor),
      'PLUGIN_ROOT is absolute and matches the independently computed root.', mismatch('PLUGIN_ROOT', root, env.PLUGIN_ROOT));
    check('mcp.stdio.env.plugin-data-absolute', typeof env.PLUGIN_DATA === 'string' && flavor.isAbsolute(env.PLUGIN_DATA),
      'PLUGIN_DATA is an absolute path for the producing operating system.',
      `PLUGIN_DATA: expected an absolute ${flavor === path.win32 ? 'Windows' : 'POSIX'} path; observed ${env.PLUGIN_DATA === undefined ? 'missing' : JSON.stringify(env.PLUGIN_DATA)}.`);
    const write = evidence.dataWrite;
    const writeCase = 'mcp.stdio.data.writable';
    if (typeof env.PLUGIN_DATA !== 'string' || !flavor.isAbsolute(env.PLUGIN_DATA)) {
      set(writeCase, 'not_verified', 'No write attempted; an absolute PLUGIN_DATA path is required.');
    } else if (write === null) {
      set(writeCase, 'not_verified', 'No write observation supplied.');
    } else {
      const describeError = ({ code, message }) => `${code ? `${code}: ` : ''}${message}`;
      set(writeCase, write.error === null ? 'pass' : 'fail', write.error === null
        ? 'Created, wrote, and closed a temporary file in PLUGIN_DATA.'
        : `Temporary file ${write.error.operation} failed at ${JSON.stringify(write.path)}: ${describeError(write.error)}`);
      if (write.cleanupError !== null) {
        results.get(writeCase).warning = `Could not remove the probe file at ${JSON.stringify(write.path)}: ${describeError(write.cleanupError)}`;
      }
    }
    check('mcp.stdio.env.configured-value', env.APC_VALUE === 'fixture value with spaces',
      'Configured environment value is preserved.', mismatch('APC_VALUE', 'fixture value with spaces', env.APC_VALUE));
    if (env.PLUGIN_DATA === undefined) {
      for (const id of ['mcp.stdio.args.preservation-and-expansion', 'mcp.stdio.env.expansion']) set(id, 'not_verified', 'PLUGIN_DATA is missing; expected expansion cannot be computed.');
    } else {
      const expectedArgv = ['default', 'arg with spaces', '', root, env.PLUGIN_DATA,
        '${APC_UNKNOWN}', '$APC_VALUE', '${PLUGIN_ROOT_SUFFIX}'];
      check('mcp.stdio.args.preservation-and-expansion', argv.length === expectedArgv.length && argv.every((arg, i) => arg === expectedArgv[i]),
        'Arguments preserve boundaries and apply only the specified expansion.', mismatch('Arguments', expectedArgv, argv));
      const expectedExpansion = {
        APC_EXPANSION: `${root}|${env.PLUGIN_DATA}|${root}`,
        APC_LITERAL: '${APC_UNKNOWN}|$APC_VALUE|${PLUGIN_ROOT_SUFFIX}',
      };
      const differences = Object.entries(expectedExpansion)
        .filter(([key, expected]) => env[key] !== expected)
        .map(([key, expected]) => mismatch(key, expected, env[key]));
      check('mcp.stdio.env.expansion', differences.length === 0,
        'Environment values apply only the specified expansion.', differences.join(' '));
    }
  }
  const ordered = CASES.map(({ id, label, specSections }) => ({
    ...results.get(id), label, specSections: [...specSections],
  }));
  const summary = { pass: 0, fail: 0, not_verified: 0, total: ordered.length };
  for (const result of ordered) summary[result.status] += 1;
  return {
    schemaVersion: 1,
    specVersion: '1.0.0',
    observations: [
      ...Object.keys(SKILLS).filter((skill) => skills.has(skill)).map((skill) => ({
        kind: 'skill', skill, marker: skills.get(skill),
      })),
      ...SERVERS.filter((server) => runtime.has(server)).map((server) => {
        const evidence = runtime.get(server);
        if (server === 'recovery-valid') {
          return { kind: 'mcp-stdio', server, evidence: { version: evidence.version, server: evidence.server } };
        }
        return { kind: 'mcp-stdio', server, evidence: {
          version: evidence.version, server: evidence.server,
          root: evidence.root, cwd: evidence.cwd, resolvedData: evidence.resolvedData, argv: [...evidence.argv],
          env: Object.fromEntries(ENV_KEYS.filter((key) => Object.hasOwn(evidence.env, key)).map((key) => [key, evidence.env[key]])),
          ...(server === 'default' ? { dataWrite: evidence.dataWrite === null ? null : {
            path: evidence.dataWrite.path,
            error: evidence.dataWrite.error === null ? null : {
              operation: evidence.dataWrite.error.operation, code: evidence.dataWrite.error.code, message: evidence.dataWrite.error.message,
            },
            cleanupError: evidence.dataWrite.cleanupError === null ? null : {
              code: evidence.dataWrite.cleanupError.code, message: evidence.dataWrite.cleanupError.message,
            },
          } } : {}),
        } };
      }),
    ],
    results: ordered,
    summary,
    notes: [
      'Results describe submitted observations; they do not authenticate their source.',
      'Skill markers are agent assertions about client-loaded skills, not proof of loading.',
      'Working directories use normalized absolute paths under the producing operating system path rules and the data path resolved by the probe; the reporter performs no filesystem lookup.',
    ],
  };
}
