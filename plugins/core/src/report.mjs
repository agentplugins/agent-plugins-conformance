import path from 'node:path';
import { CASES } from './cases.mjs';

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
  object(input, ['schemaVersion', 'runId', 'client', 'collection', 'observations'],
    ['schemaVersion', 'runId', 'client', 'collection', 'observations'], 'input');
  if (input.schemaVersion !== 1) invalid('input.schemaVersion', 'expected 1');
  string(input.runId, 'input.runId', 100);
  object(input.client, ['name', 'version'], ['name', 'version'], 'input.client');
  string(input.client.name, 'input.client.name', 200);
  string(input.client.version, 'input.client.version', 200);
  object(input.collection, ['kind', 'route'], ['kind', 'route'], 'input.collection');
  member(input.collection.kind, ['client', 'reference'], 'input.collection.kind');
  string(input.collection.route, 'input.collection.route', 500);
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
  return { runtime, skills };
}

export function buildReport(input) {
  const { runtime, skills } = validate(input);
  const results = new Map(CASES.map(({ id }) => [id, { id, status: 'not_verified', detail: 'No observation supplied.' }]));
  const set = (id, status, detail) => results.set(id, { id, status, detail });
  const check = (id, condition, pass, fail) => set(id, condition ? 'pass' : 'fail', condition ? pass : fail);
  const mismatch = (field, expected, observed) =>
    `${field}: expected ${JSON.stringify(expected)}; observed ${observed === undefined ? 'missing' : JSON.stringify(observed)}.`;

  for (const [skill, [id, marker]] of Object.entries(SKILLS)) {
    if (skills.has(skill)) check(id, skills.get(skill) === marker,
      'Agent reported the expected client-loaded skill marker.', mismatch('Skill marker', marker, skills.get(skill)));
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
        'Working directory matches the resolved expected path.', mismatch('Working directory', target, evidence.cwd));
    }
  }
  const evidence = runtime.get('default');
  if (evidence) {
    const { root, env, argv } = evidence;
    const flavor = pathFlavor(root);
    check('stdio.root', samePath(env.PLUGIN_ROOT, root, flavor),
      'PLUGIN_ROOT is absolute and matches the independently computed root.', mismatch('PLUGIN_ROOT', root, env.PLUGIN_ROOT));
    check('stdio.data', typeof env.PLUGIN_DATA === 'string' && flavor.isAbsolute(env.PLUGIN_DATA),
      'PLUGIN_DATA is an absolute path for the producing operating system.',
      `PLUGIN_DATA: expected an absolute ${flavor === path.win32 ? 'Windows' : 'POSIX'} path; observed ${env.PLUGIN_DATA === undefined ? 'missing' : JSON.stringify(env.PLUGIN_DATA)}.`);
    check('stdio.env', env.APC_VALUE === 'fixture value with spaces',
      'Configured environment value is preserved.', mismatch('APC_VALUE', 'fixture value with spaces', env.APC_VALUE));
    if (env.PLUGIN_DATA === undefined) {
      for (const id of ['stdio.args', 'stdio.expansion']) set(id, 'not_verified', 'PLUGIN_DATA is missing; expected expansion cannot be computed.');
    } else {
      const expectedArgv = ['default', 'arg with spaces', '', root, env.PLUGIN_DATA,
        '${APC_UNKNOWN}', '$APC_VALUE', '${PLUGIN_ROOT_SUFFIX}'];
      check('stdio.args', argv.length === expectedArgv.length && argv.every((arg, i) => arg === expectedArgv[i]),
        'Arguments preserve boundaries and apply only the specified expansion.', mismatch('Arguments', expectedArgv, argv));
      const expectedExpansion = {
        APC_EXPANSION: `${root}|${env.PLUGIN_DATA}|${root}`,
        APC_LITERAL: '${APC_UNKNOWN}|$APC_VALUE|${PLUGIN_ROOT_SUFFIX}',
      };
      const differences = Object.entries(expectedExpansion)
        .filter(([key, expected]) => env[key] !== expected)
        .map(([key, expected]) => mismatch(key, expected, env[key]));
      check('stdio.expansion', differences.length === 0,
        'Environment values apply only the specified expansion.', differences.join(' '));
    }
  }
  const ordered = CASES.map(({ id, label, category, specSections }) => ({
    ...results.get(id), label, category, specSections: [...specSections],
  }));
  const summary = { pass: 0, fail: 0, not_verified: 0, total: ordered.length };
  for (const result of ordered) summary[result.status] += 1;
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
    notes: [
      'Results describe submitted observations; they do not authenticate their source.',
      'Skill markers are agent assertions about client-loaded skills, not proof of loading.',
      ...(input.collection.kind === 'reference' ? ['Reference collection tests the fixture and cannot count as client certification.'] : []),
      'Working directories use normalized absolute paths under the producing operating system path rules and the data path resolved by the probe; the reporter performs no filesystem lookup.',
    ],
  };
}

export function formatReport(report) {
  const safe = (value) => value.replace(/[\u0000-\u001f\u007f-\u009f]/g, (character) => {
    const escaped = JSON.stringify(character).slice(1, -1);
    return escaped === character ? `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}` : escaped;
  });
  const row = (label, pass, fail, unverified) => [
    label.padEnd(11), String(pass).padStart(6), String(fail).padStart(6), String(unverified).padStart(12),
  ].join('  ');
  const lines = [
    `Agent Plugins conformance — spec ${safe(report.specVersion)}`,
    `Client: ${safe(report.client.name)}, version ${safe(report.client.version)}`,
    '',
    row('Checks', 'Passed', 'Failed', 'Not verified'),
  ];
  for (const [category, label] of [['skills', 'Skills'], ['mcp', 'MCP']]) {
    const results = report.results.filter((result) => result.category === category);
    const count = (status) => results.filter((result) => result.status === status).length;
    lines.push(row(label, count('pass'), count('fail'), count('not_verified')));
  }
  const failures = report.results.filter(({ status }) => status === 'fail');
  if (failures.length) {
    lines.push('', 'Failed');
    for (const { id, label, detail } of failures) {
      lines.push(`  ${label} (${id})`, `    ${safe(detail)}`);
    }
  }
  const unverified = report.results.filter(({ status }) => status === 'not_verified');
  if (unverified.length) {
    lines.push('', 'Not verified');
    const skills = new Set(report.observations.filter(({ kind }) => kind === 'skill').map(({ skill }) => skill));
    const servers = new Set(report.observations.filter(({ kind }) => kind === 'runtime').map(({ server }) => server));
    const missingSkills = Object.keys(SKILLS).filter((skill) => !skills.has(skill));
    const missingServers = SERVERS.filter((server) => !servers.has(server));
    if (missingSkills.length) lines.push(`  Skills: ${missingSkills.join(', ')} — no observations.`);
    if (missingServers.length) lines.push(`  MCP servers: ${missingServers.join(', ')} — no runtime observations.`);
    for (const { id, label, detail } of unverified) {
      const grouped = missingSkills.some((skill) => SKILLS[skill][0] === id) ||
        missingServers.some((server) => id.startsWith(`mcp.${server}.`) || (server === 'default' && id.startsWith('stdio.')));
      if (!grouped) lines.push(`  ${label} (${id})`, `    ${safe(detail)}`);
    }
  }
  lines.push('',
    `Run: ${safe(report.runId)}`,
    `Evidence source: ${safe(report.collection.kind)} run — ${safe(report.collection.route)}`,
    report.collection.kind === 'reference'
      ? 'Scope: fixture observations only; does not establish client conformance.'
      : 'Scope: submitted observations; skill loading is agent-reported. Selected checks only.',
  );
  return lines.join('\n');
}
