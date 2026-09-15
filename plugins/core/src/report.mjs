import path from 'node:path';
import { CASES, CASE_IDS } from './cases.mjs';

export { CASES, CASE_IDS } from './cases.mjs';
export const MAX_INPUT_BYTES = 262144;
const SERVERS = ['default', 'relative', 'root', 'data'];
const SKILLS = {
  'conformance-guide': ['skills.guide', 'APC_GUIDE_V1'],
  'conformance-alpha': ['skills.alpha', 'APC_ALPHA_V1'],
  'conformance-beta': ['skills.beta', 'APC_BETA_V1'],
};
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

function string(value, at, max = 4096, allowEmpty = false) {
  if (typeof value !== 'string' || (!allowEmpty && value.trim().length === 0) ||
      value.length > max || value.includes('\0')) {
    invalid(at, `expected ${allowEmpty ? 'a' : 'a nonempty'} string of at most ${max} characters without NUL`);
  }
}

function member(value, values, at) {
  if (!values.includes(value)) invalid(at, `expected one of: ${values.join(', ')}`);
}

function array(value, max, at) {
  if (!Array.isArray(value) || value.length > max) invalid(at, `expected an array of at most ${max} items`);
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
  object(input, ['schemaVersion', 'runId', 'client', 'collection', 'expectedPasses', 'observations'],
    ['schemaVersion', 'runId', 'client', 'collection', 'expectedPasses', 'observations'], 'input');
  if (input.schemaVersion !== 1) invalid('input.schemaVersion', 'expected 1');
  string(input.runId, 'input.runId', 100);
  object(input.client, ['name', 'version'], ['name', 'version'], 'input.client');
  string(input.client.name, 'input.client.name', 200);
  string(input.client.version, 'input.client.version', 200);
  object(input.collection, ['kind', 'route'], ['kind', 'route'], 'input.collection');
  member(input.collection.kind, ['client', 'reference'], 'input.collection.kind');
  string(input.collection.route, 'input.collection.route', 500);
  array(input.expectedPasses, CASE_IDS.length, 'input.expectedPasses');
  const expected = new Set();
  for (const [index, id] of input.expectedPasses.entries()) {
    member(id, CASE_IDS, `input.expectedPasses[${index}]`);
    if (expected.has(id)) invalid(`input.expectedPasses[${index}]`, `duplicate case: ${id}`);
    expected.add(id);
  }
  array(input.observations, 7, 'input.observations');
  const runtime = new Map();
  const skills = new Map();
  for (const [index, observation] of input.observations.entries()) {
    const at = `input.observations[${index}]`;
    object(observation, ['kind', 'server', 'evidence', 'skill', 'marker'], ['kind'], at);
    member(observation.kind, ['runtime', 'skill'], `${at}.kind`);
    if (observation.kind === 'runtime') {
      object(observation, ['kind', 'server', 'evidence'], ['kind', 'server', 'evidence'], at);
      member(observation.server, SERVERS, `${at}.server`);
      if (runtime.has(observation.server)) invalid(at, `duplicate runtime observation: ${observation.server}`);
      const evidenceAt = `${at}.evidence`;
      const evidence = observation.evidence;
      const keys = ['version', 'runId', 'server', 'root', 'cwd', 'resolvedData', 'argv', 'env'];
      object(evidence, keys, keys, evidenceAt);
      if (evidence.version !== 1) invalid(`${evidenceAt}.version`, 'expected 1');
      if (evidence.runId !== input.runId) invalid(`${evidenceAt}.runId`, 'must match input.runId');
      if (evidence.server !== observation.server) invalid(`${evidenceAt}.server`, 'must match observation.server');
      for (const field of ['root', 'cwd']) {
        string(evidence[field], `${evidenceAt}.${field}`);
        if (!pathFlavor(evidence[field])) invalid(`${evidenceAt}.${field}`, 'expected an absolute POSIX or Windows path');
      }
      if (evidence.resolvedData !== null) {
        string(evidence.resolvedData, `${evidenceAt}.resolvedData`);
        if (!pathFlavor(evidence.resolvedData)) invalid(`${evidenceAt}.resolvedData`, 'expected null or an absolute POSIX or Windows path');
      }
      array(evidence.argv, 32, `${evidenceAt}.argv`);
      evidence.argv.forEach((argument, i) => string(argument, `${evidenceAt}.argv[${i}]`, 4096, true));
      object(evidence.env, ENV_KEYS, [], `${evidenceAt}.env`);
      for (const [key, value] of Object.entries(evidence.env)) string(value, `${evidenceAt}.env.${key}`, 16384, true);
      runtime.set(observation.server, evidence);
    } else {
      object(observation, ['kind', 'skill', 'marker'], ['kind', 'skill', 'marker'], at);
      member(observation.skill, Object.keys(SKILLS), `${at}.skill`);
      if (skills.has(observation.skill)) invalid(at, `duplicate skill observation: ${observation.skill}`);
      string(observation.marker, `${at}.marker`, 100);
      skills.set(observation.skill, observation.marker);
    }
  }
  if (Buffer.byteLength(JSON.stringify(input), 'utf8') > MAX_INPUT_BYTES) invalid('input', `exceeds ${MAX_INPUT_BYTES} bytes`);
  return { runtime, skills, expected };
}

export function buildReport(input) {
  const { runtime, skills, expected } = validate(input);
  const results = new Map(CASES.map(({ id }) => [id, { id, status: 'not_verified', detail: 'No observation supplied.' }]));
  const set = (id, status, detail) => results.set(id, { id, status, detail });
  const check = (id, condition, pass, fail) => set(id, condition ? 'pass' : 'fail', condition ? pass : fail);

  for (const [skill, [id, marker]] of Object.entries(SKILLS)) {
    if (skills.has(skill)) check(id, skills.get(skill) === marker,
      'Agent reported the expected client-loaded skill marker.', 'Reported skill marker does not match.');
  }
  for (const [server, evidence] of runtime) {
    set(`mcp.${server}.tool`, 'pass', 'Valid runtime evidence supplied for this server and run.');
    const flavor = pathFlavor(evidence.root);
    const target = server === 'default' ? evidence.root
      : server === 'data' ? evidence.resolvedData
      : flavor.join(evidence.root, 'probe-workdir');
    if (target === null) {
      set(`mcp.${server}.cwd`, 'not_verified', 'PLUGIN_DATA could not be resolved; the expected working directory is unavailable.');
    } else {
      check(`mcp.${server}.cwd`, samePath(evidence.cwd, target, flavor),
        'Working directory matches the resolved expected path.', 'Working directory does not match the resolved expected path.');
    }
  }
  const evidence = runtime.get('default');
  if (evidence) {
    const { root, env, argv } = evidence;
    const flavor = pathFlavor(root);
    check('stdio.root', samePath(env.PLUGIN_ROOT, root, flavor),
      'PLUGIN_ROOT is absolute and matches the independently computed root.', 'PLUGIN_ROOT is missing, not absolute, or does not match the independently computed root.');
    check('stdio.data', typeof env.PLUGIN_DATA === 'string' && flavor.isAbsolute(env.PLUGIN_DATA),
      'PLUGIN_DATA is an absolute path for the producing operating system.', 'PLUGIN_DATA is missing or is not an absolute path for the producing operating system.');
    check('stdio.env', env.APC_VALUE === 'fixture value with spaces',
      'Configured environment value is preserved.', 'APC_VALUE is missing or does not match the configured value.');
    if (env.PLUGIN_DATA === undefined) {
      for (const id of ['stdio.args', 'stdio.expansion']) set(id, 'not_verified', 'PLUGIN_DATA is missing; expected expansion cannot be computed.');
    } else {
      const expectedArgv = ['default', 'arg with spaces', '', root, env.PLUGIN_DATA,
        '${APC_UNKNOWN}', '$APC_VALUE', '${PLUGIN_ROOT_SUFFIX}'];
      check('stdio.args', argv.length === expectedArgv.length && argv.every((arg, i) => arg === expectedArgv[i]),
        'Arguments preserve boundaries and apply only the specified expansion.', 'Arguments do not match the expected ordered values.');
      check('stdio.expansion', env.APC_EXPANSION === `${root}|${env.PLUGIN_DATA}|${root}` &&
        env.APC_LITERAL === '${APC_UNKNOWN}|$APC_VALUE|${PLUGIN_ROOT_SUFFIX}',
      'Environment values apply only the specified expansion.', 'APC_EXPANSION or APC_LITERAL is missing or does not match.');
    }
  }
  const ordered = CASES.map(({ id, specSections }) => ({ ...results.get(id), specSections: [...specSections] }));
  const summary = { pass: 0, fail: 0, not_verified: 0, total: ordered.length };
  for (const result of ordered) summary[result.status] += 1;
  const expectedPasses = CASE_IDS.filter((id) => expected.has(id));
  const unmetExpectations = expectedPasses.filter((id) => results.get(id).status !== 'pass');
  return {
    schemaVersion: 1,
    specVersion: '1.0.0',
    runId: input.runId,
    client: { name: input.client.name, version: input.client.version },
    collection: { kind: input.collection.kind, route: input.collection.route },
    observations: [
      ...Object.keys(SKILLS).filter((skill) => skills.has(skill)).map((skill) => ({
        kind: 'skill', skill, marker: skills.get(skill),
      })),
      ...SERVERS.filter((server) => runtime.has(server)).map((server) => {
        const evidence = runtime.get(server);
        return { kind: 'runtime', server, evidence: {
          version: evidence.version, runId: evidence.runId, server: evidence.server,
          root: evidence.root, cwd: evidence.cwd, resolvedData: evidence.resolvedData, argv: [...evidence.argv],
          env: Object.fromEntries(ENV_KEYS.filter((key) => Object.hasOwn(evidence.env, key)).map((key) => [key, evidence.env[key]])),
        } };
      }),
    ],
    results: ordered,
    summary,
    expectedPasses,
    unmetExpectations,
    notes: [
      'Results describe submitted observations; they do not authenticate their source.',
      'Skill markers are agent assertions about client-loaded skills, not proof of loading.',
      ...(input.collection.kind === 'reference' ? ['Reference collection tests the fixture and cannot count as client certification.'] : []),
      'Working directories use normalized absolute paths under the producing operating system path rules and the data path resolved by the probe; the reporter performs no filesystem lookup.',
    ],
  };
}

export function formatReport(report) {
  const safe = (value) => JSON.stringify(value);
  return [
    `Agent Plugins conformance: ${safe(report.client.name)} ${safe(report.client.version)}`,
    `Run: ${safe(report.runId)}`,
    `Collection: ${report.collection.kind} via ${safe(report.collection.route)}`,
    `Summary: ${report.summary.pass} pass, ${report.summary.fail} fail, ${report.summary.not_verified} not_verified (${report.summary.total} total)`,
    ...report.results.filter(({ status }) => status !== 'pass').map(({ id, status, detail }) => `${status.padEnd(12)} ${id}: ${detail}`),
    `Unmet expected passes: ${report.unmetExpectations.length ? report.unmetExpectations.join(', ') : 'none'}`,
    'Scope: submitted runtime evidence and agent-reported skill markers; not full client certification.',
    ...(report.collection.kind === 'reference' ? ['Reference collection verifies the fixture only.'] : []),
  ].join('\n');
}

export function reportExitCode(report) {
  return report.summary.fail > 0 || report.unmetExpectations.length > 0 ? 1 : 0;
}
