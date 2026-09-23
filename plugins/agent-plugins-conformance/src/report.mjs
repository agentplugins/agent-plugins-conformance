import path from 'node:path';
import { CASES, MCP_CWD_VARIANTS } from './cases.mjs';

export { CASES, CASE_IDS } from './cases.mjs';
const CORE_SERVERS = Object.keys(MCP_CWD_VARIANTS);
const INVALID_STDIO_SERVERS = Object.freeze({
  'recovery-cwd-invalid-form': 'mcp.stdio.cwd.invalid-form',
  'recovery-cwd-escape': 'mcp.stdio.cwd.plugin-relative-escape',
  'recovery-cwd-data-escape': 'mcp.stdio.cwd.plugin-data-escape',
  'recovery-cwd-symlink-escape': 'filesystem.containment.cwd-symlink-escape',
  'recovery-unknown-field': 'mcp.stdio.config.unknown-field',
  'recovery-missing-type': 'mcp.config.missing-type',
  'recovery-env-plugin-root': 'mcp.stdio.env.reserved-plugin-root',
  'recovery-env-plugin-data': 'mcp.stdio.env.reserved-plugin-data',
});
const INVALID_HTTP_SERVERS = Object.freeze({
  'recovery-http-type': 'mcp.config.legacy-http-type',
  'recovery-http-relative-url': 'mcp.streamable-http.url.relative',
  'recovery-http-fragment': 'mcp.streamable-http.url.fragment',
  'recovery-http-userinfo': 'mcp.streamable-http.url.userinfo',
  'recovery-http-duplicate-headers': 'mcp.streamable-http.headers.duplicate-names',
  'recovery-http-header-name': 'mcp.streamable-http.headers.invalid-name',
  'recovery-http-header-value': 'mcp.streamable-http.headers.invalid-value',
});
const INVALID_SSE_SERVERS = Object.freeze({
  'recovery-sse-relative-url': 'mcp.sse.url.relative',
  'recovery-sse-fragment': 'mcp.sse.url.fragment',
  'recovery-sse-userinfo': 'mcp.sse.url.userinfo',
  'recovery-sse-duplicate-headers': 'mcp.sse.headers.duplicate-names',
  'recovery-sse-header-name': 'mcp.sse.headers.invalid-name',
  'recovery-sse-header-value': 'mcp.sse.headers.invalid-value',
});
const INVALID_STDIO_SERVER_NAMES = Object.keys(INVALID_STDIO_SERVERS);
const RECOVERY_INVALID_SERVER_NAMES = [
  ...INVALID_STDIO_SERVER_NAMES, ...Object.keys(INVALID_HTTP_SERVERS), ...Object.keys(INVALID_SSE_SERVERS),
];
const SERVERS = [...CORE_SERVERS, 'recovery-valid', ...INVALID_STDIO_SERVER_NAMES];
const HTTP_SERVERS = ['http', 'http-redirect', ...Object.keys(INVALID_HTTP_SERVERS)];
const SSE_SERVERS = [
  'sse', 'sse-header-precedence', 'sse-redirect', 'sse-endpoint-origin', ...Object.keys(INVALID_SSE_SERVERS),
];
const CORE_SKILLS = {
  'conformance-alpha': 'APC_ALPHA_V1',
  'conformance-beta': 'APC_BETA_V1',
};
const SKILLS = {
  ...CORE_SKILLS,
  'conformance-recovery-valid': 'APC_RECOVERY_VALID_V1',
  'conformance-invalid-mcp-valid': 'APC_INVALID_MCP_VALID_V1',
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

function nullableString(value, at) {
  if (value !== null && typeof value !== 'string') invalid(at, 'expected a string or null');
}

function validateQuery(query, at) {
  array(query, at);
  for (const [i, pair] of query.entries()) {
    const pairAt = `${at}[${i}]`;
    array(pair, pairAt);
    if (pair.length !== 2) invalid(pairAt, 'expected a name and value pair');
    for (const [j, value] of pair.entries()) {
      if (typeof value !== 'string') invalid(`${pairAt}[${j}]`, 'expected a string');
    }
  }
}

function validateSseConnection(connection, at) {
  object(connection, ['origin', 'pathname', 'query', 'headers'], ['origin', 'pathname', 'query', 'headers'], at);
  if (typeof connection.origin !== 'string') invalid(`${at}.origin`, 'expected a string');
  if (typeof connection.pathname !== 'string') invalid(`${at}.pathname`, 'expected a string');
  validateQuery(connection.query, `${at}.query`);
  object(connection.headers, ['x-apc-fixture', 'accept'], ['x-apc-fixture', 'accept'], `${at}.headers`);
  nullableString(connection.headers['x-apc-fixture'], `${at}.headers.x-apc-fixture`);
  nullableString(connection.headers.accept, `${at}.headers.accept`);
}

function validateHttpEvidence(evidence, at, allowedTypes = ['request', 'error'],
  allowedClassifications = [null, 'redirect-refused']) {
  object(evidence, [
    'type', 'version', 'pathname', 'query', 'headers', 'message', 'classification',
    'connection', 'redirectSource', 'messages',
  ], ['type'], at);
  member(evidence.type, allowedTypes, `${at}.type`);
  if (evidence.type === 'error') {
    object(evidence, ['type', 'message', 'classification'], ['type', 'message', 'classification'], at);
    string(evidence.message, `${at}.message`);
    if (!allowedClassifications.includes(evidence.classification)) {
      invalid(`${at}.classification`, `expected one of: ${allowedClassifications.map((value) => value ?? 'null').join(', ')}`);
    }
    return;
  }
  if (evidence.type === 'sse-session') {
    object(evidence, ['type', 'version', 'connection', 'redirectSource', 'messages'],
      ['type', 'version', 'connection', 'redirectSource', 'messages'], at);
    if (evidence.version !== 1) invalid(`${at}.version`, 'expected 1');
    validateSseConnection(evidence.connection, `${at}.connection`);
    if (evidence.redirectSource !== null) validateSseConnection(evidence.redirectSource, `${at}.redirectSource`);
    array(evidence.messages, `${at}.messages`);
    for (const [i, message] of evidence.messages.entries()) {
      const messageAt = `${at}.messages[${i}]`;
      object(message, ['origin', 'headers'], ['origin', 'headers'], messageAt);
      if (typeof message.origin !== 'string') invalid(`${messageAt}.origin`, 'expected a string');
      object(message.headers, ['x-apc-fixture'], ['x-apc-fixture'], `${messageAt}.headers`);
      nullableString(message.headers['x-apc-fixture'], `${messageAt}.headers.x-apc-fixture`);
    }
    return;
  }
  object(evidence, ['type', 'version', 'pathname', 'query', 'headers'],
    ['type', 'version', 'pathname', 'query', 'headers'], at);
  if (evidence.version !== 1) invalid(`${at}.version`, 'expected 1');
  if (typeof evidence.pathname !== 'string') invalid(`${at}.pathname`, 'expected a string');
  validateQuery(evidence.query, `${at}.query`);
  object(evidence.headers, ['x-apc-fixture'], ['x-apc-fixture'], `${at}.headers`);
  nullableString(evidence.headers['x-apc-fixture'], `${at}.headers.x-apc-fixture`);
}

function canonicalHttpEvidence(evidence) {
  if (evidence === null) return null;
  if (evidence.type === 'error') {
    return { type: 'error', message: evidence.message, classification: evidence.classification };
  }
  if (evidence.type === 'sse-session') {
    const connection = ({ origin, pathname, query, headers }) => ({
      origin, pathname, query: query.map((pair) => [...pair]),
      headers: { 'x-apc-fixture': headers['x-apc-fixture'], accept: headers.accept },
    });
    return {
      type: 'sse-session', version: evidence.version,
      connection: connection(evidence.connection),
      redirectSource: evidence.redirectSource === null ? null : connection(evidence.redirectSource),
      messages: evidence.messages.map((message) => ({
        origin: message.origin,
        headers: { 'x-apc-fixture': message.headers['x-apc-fixture'] },
      })),
    };
  }
  return {
    type: 'request', version: evidence.version, pathname: evidence.pathname,
    query: evidence.query.map((pair) => [...pair]),
    headers: { 'x-apc-fixture': evidence.headers['x-apc-fixture'] },
  };
}

export function observationKey(value) {
  return `${value.kind}:${['skill', 'skill-discovery'].includes(value.kind) ? value.skill : value.server}`;
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

export function validateInput(input, { recording = false } = {}) {
  object(input, ['schemaVersion', 'observations'],
    ['schemaVersion', 'observations'], 'input');
  if (input.schemaVersion !== 1) invalid('input.schemaVersion', 'expected 1');
  array(input.observations, 'input.observations');
  const runtime = new Map();
  const skills = new Map();
  let nestedDiscovery;
  const invalidServerDiscovery = new Map();
  const http = new Map();
  const sse = new Map();
  for (const [index, observation] of input.observations.entries()) {
    const at = `input.observations[${index}]`;
    object(observation, ['kind', 'server', 'evidence', 'skill', 'marker', 'serverHealthCheck', 'advertised'], ['kind'], at);
    member(observation.kind, ['mcp-stdio', 'mcp-streamable-http', 'mcp-sse', 'mcp-discovery', 'skill', 'skill-discovery'], `${at}.kind`);
    if (observation.kind === 'mcp-streamable-http') {
      const fields = ['kind', 'server', 'evidence', ...(recording ? [] : ['serverHealthCheck'])];
      object(observation, fields, fields, at);
      if (!recording) member(observation.serverHealthCheck, ['passed', 'failed'], `${at}.serverHealthCheck`);
      member(observation.server, HTTP_SERVERS, `${at}.server`);
      if (http.has(observation.server)) invalid(at, `duplicate mcp-streamable-http observation: ${observation.server}`);
      http.set(observation.server, observation);
      if (observation.evidence !== null) validateHttpEvidence(observation.evidence, `${at}.evidence`);
    } else if (observation.kind === 'mcp-sse') {
      object(observation, ['kind', 'server', 'evidence'], ['kind', 'server', 'evidence'], at);
      member(observation.server, SSE_SERVERS, `${at}.server`);
      if (sse.has(observation.server)) invalid(at, `duplicate mcp-sse observation: ${observation.server}`);
      sse.set(observation.server, observation);
      if (observation.evidence !== null) {
        validateHttpEvidence(observation.evidence, `${at}.evidence`, ['request', 'error', 'sse-session'],
          [null, 'redirect-refused', 'endpoint-refused']);
        if (observation.evidence.type === 'error') {
          const classifications = observation.server === 'sse-redirect' ? [null, 'redirect-refused']
            : observation.server === 'sse-endpoint-origin' ? [null, 'endpoint-refused'] : [null];
          if (!classifications.includes(observation.evidence.classification)) {
            invalid(`${at}.evidence.classification`, observation.server === 'sse-redirect'
              ? 'expected redirect-refused or null'
              : observation.server === 'sse-endpoint-origin' ? 'expected endpoint-refused or null' : 'expected null');
          }
        }
      }
    } else if (observation.kind === 'mcp-stdio') {
      object(observation, ['kind', 'server', 'evidence'], ['kind', 'server', 'evidence'], at);
      member(observation.server, SERVERS, `${at}.server`);
      if (runtime.has(observation.server)) invalid(at, `duplicate mcp-stdio observation: ${observation.server}`);
      const evidenceAt = `${at}.evidence`;
      const evidence = observation.evidence;
      const keys = observation.server === 'recovery-valid'
        ? ['version', 'server', 'resolvedData']
        : INVALID_STDIO_SERVER_NAMES.includes(observation.server)
          ? ['version', 'server', 'root', 'cwd']
          : ['version', 'server', 'root', 'cwd', 'resolvedData', 'argv', 'env'];
      if (observation.server === 'default') keys.push('dataWrite');
      object(evidence, observation.server === 'recovery-valid' ? [...keys, 'symlinkCwd'] : keys, keys, evidenceAt);
      if (evidence.version !== 1) invalid(`${evidenceAt}.version`, 'expected 1');
      if (evidence.server !== observation.server) invalid(`${evidenceAt}.server`, 'must match observation.server');
      if (INVALID_STDIO_SERVER_NAMES.includes(observation.server)) {
        for (const field of ['root', 'cwd']) {
          string(evidence[field], `${evidenceAt}.${field}`);
          if (!pathFlavor(evidence[field])) invalid(`${evidenceAt}.${field}`, 'expected an absolute POSIX or Windows path');
        }
        runtime.set(observation.server, evidence);
        continue;
      }
      if (evidence.resolvedData !== null) {
        string(evidence.resolvedData, `${evidenceAt}.resolvedData`);
        if (!pathFlavor(evidence.resolvedData)) invalid(`${evidenceAt}.resolvedData`, 'expected null or an absolute POSIX or Windows path');
      }
      if (observation.server === 'recovery-valid') {
        if (Object.hasOwn(evidence, 'symlinkCwd') && evidence.symlinkCwd !== null) {
          member(evidence.symlinkCwd, ['symlink', 'missing', 'other'], `${evidenceAt}.symlinkCwd`);
        }
        runtime.set(observation.server, evidence);
        continue;
      }
      for (const field of ['root', 'cwd']) {
        string(evidence[field], `${evidenceAt}.${field}`);
        if (!pathFlavor(evidence[field])) invalid(`${evidenceAt}.${field}`, 'expected an absolute POSIX or Windows path');
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
    } else if (observation.kind === 'mcp-discovery') {
      object(observation, ['kind', 'server', 'advertised'], ['kind', 'server', 'advertised'], at);
      member(observation.server, RECOVERY_INVALID_SERVER_NAMES, `${at}.server`);
      if (typeof observation.advertised !== 'boolean') invalid(`${at}.advertised`, 'expected a boolean');
      if (invalidServerDiscovery.has(observation.server)) invalid(at, `duplicate mcp-discovery observation: ${observation.server}`);
      invalidServerDiscovery.set(observation.server, observation.advertised);
    } else if (observation.kind === 'skill-discovery') {
      object(observation, ['kind', 'skill', 'advertised'], ['kind', 'skill', 'advertised'], at);
      member(observation.skill, ['conformance-nested'], `${at}.skill`);
      if (typeof observation.advertised !== 'boolean') invalid(`${at}.advertised`, 'expected a boolean');
      if (nestedDiscovery !== undefined) invalid(at, 'duplicate skill-discovery observation: conformance-nested');
      nestedDiscovery = observation.advertised;
    } else {
      object(observation, ['kind', 'skill', 'marker'], ['kind', 'skill', 'marker'], at);
      member(observation.skill, Object.keys(SKILLS), `${at}.skill`);
      if (skills.has(observation.skill)) invalid(at, `duplicate skill observation: ${observation.skill}`);
      string(observation.marker, `${at}.marker`);
      skills.set(observation.skill, observation.marker);
    }
  }
  return { runtime, skills, http, sse, nestedDiscovery, invalidServerDiscovery };
}

export function buildReport(input) {
  const { runtime, skills, http, sse, nestedDiscovery, invalidServerDiscovery } = validateInput(input);
  const results = new Map(CASES.map(({ id }) => [id, { id, status: 'not_verified', detail: 'No observation supplied.' }]));
  const set = (id, status, detail) => results.set(id, { id, status, detail });
  const check = (id, condition, pass, fail) => set(id, condition ? 'pass' : 'fail', condition ? pass : fail);
  const mismatch = (field, expected, observed) =>
    `${field}: expected ${JSON.stringify(expected)}; observed ${observed === undefined ? 'missing' : JSON.stringify(observed)}.`;

  const ordinaryHttp = http.get('http');
  if (ordinaryHttp?.evidence?.type === 'request') {
    const evidence = ordinaryHttp.evidence;
    set('mcp.streamable-http.tool-availability', 'pass', 'Valid runtime evidence supplied for the HTTP server.');
    const expectedPathname = '/conformance/mcp';
    const expectedQuery = [['value', '$APC_HTTP_VALUE']];
    const differences = [];
    if (evidence.pathname !== expectedPathname) differences.push(mismatch('URL pathname', expectedPathname, evidence.pathname));
    if (JSON.stringify(evidence.query) !== JSON.stringify(expectedQuery)) differences.push(mismatch('URL query pairs', expectedQuery, evidence.query));
    check('mcp.streamable-http.url.literal-route-and-query', differences.length === 0,
      'URL pathname and decoded query pairs preserve the configured literal values.', differences.join(' '));
    const expectedHeader = '${PLUGIN_ROOT}|${PLUGIN_DATA}|fixture value with spaces';
    check('mcp.streamable-http.headers.literal-value', evidence.headers['x-apc-fixture'] === expectedHeader,
      'The configured header value is preserved literally.', mismatch('x-apc-fixture header', expectedHeader, evidence.headers['x-apc-fixture']));
  }

  if (ordinaryHttp && ordinaryHttp.evidence?.type !== 'request') {
    const healthPassed = ordinaryHttp.serverHealthCheck === 'passed';
    const returnedError = ordinaryHttp.evidence?.type === 'error';
    set('mcp.streamable-http.tool-availability', healthPassed ? 'fail' : 'not_verified',
      returnedError
        ? healthPassed
          ? 'The native attempt returned an error while the HTTP server health check passed.'
          : 'The native attempt returned an error and the HTTP server health check failed.'
        : healthPassed
          ? 'The native attempt yielded no observation while the HTTP server health check passed.'
          : 'The native attempt yielded no observation and the HTTP server health check failed.');
  }

  const sseObservation = sse.get('sse');
  const sseCaseIds = [
    'mcp.sse.tool-availability',
    'mcp.sse.url.literal-route-and-query',
    'mcp.sse.headers.literal-value',
    'mcp.sse.headers.literal-post-value',
  ];
  const sseEvidence = sseObservation?.evidence;
  const sseConnection = sseEvidence?.type === 'request' ? sseEvidence
    : sseEvidence?.type === 'sse-session' ? sseEvidence.connection : null;
  if (sseConnection) {
    set('mcp.sse.tool-availability', 'pass', 'Valid runtime evidence supplied for the SSE server.');
    const expectedPathname = '/conformance/sse';
    const expectedQuery = [['value', '$APC_SSE_VALUE']];
    const differences = [];
    if (sseConnection.pathname !== expectedPathname) differences.push(mismatch('URL pathname', expectedPathname, sseConnection.pathname));
    if (JSON.stringify(sseConnection.query) !== JSON.stringify(expectedQuery)) differences.push(mismatch('URL query pairs', expectedQuery, sseConnection.query));
    check('mcp.sse.url.literal-route-and-query', differences.length === 0,
      'URL pathname and decoded query pairs preserve the configured literal values.', differences.join(' '));
    const expectedHeader = '${PLUGIN_ROOT}|${PLUGIN_DATA}|fixture value with spaces';
    check('mcp.sse.headers.literal-value', sseConnection.headers['x-apc-fixture'] === expectedHeader,
      'The initial connection preserves the configured header value literally.',
      mismatch('Initial x-apc-fixture header', expectedHeader, sseConnection.headers['x-apc-fixture']));
    if (sseEvidence.type === 'sse-session') {
      const expectedOrigin = 'http://127.0.0.1:43187';
      if (sseEvidence.messages.length === 0) {
        set('mcp.sse.headers.literal-post-value', 'not_verified', 'No POST message evidence was supplied.');
      } else if (sseEvidence.messages.some((message) => message.origin !== expectedOrigin)) {
        set('mcp.sse.headers.literal-post-value', 'not_verified',
          'POST message evidence included an unexpected origin, so literal header delivery to the fixture origin was not evaluated.');
      } else {
        const postDifferences = sseEvidence.messages.flatMap((message, index) =>
          message.headers['x-apc-fixture'] === expectedHeader ? [] : [
            mismatch(`POST message ${index} x-apc-fixture header`, expectedHeader, message.headers['x-apc-fixture']),
          ]);
        check('mcp.sse.headers.literal-post-value', postDifferences.length === 0,
          'Every observed POST message preserves the configured header value literally.', postDifferences.join(' '));
      }
    }
  } else if (sseObservation) {
    const detail = sseObservation.evidence?.type === 'error'
      ? 'The native SSE attempt returned an error; the exact diagnostic is preserved in the observation.'
      : 'The completed native SSE attempt supplied no usable evidence.';
    for (const id of sseCaseIds) set(id, 'not_verified', detail);
  }

  const precedenceId = 'mcp.sse.headers.generated-precedence';
  const precedenceObservation = sse.get('sse-header-precedence');
  const precedenceEvidence = precedenceObservation?.evidence;
  if (sseEvidence?.type === 'sse-session' && precedenceEvidence?.type === 'sse-session') {
    const expectedOrigin = 'http://127.0.0.1:43187';
    const baselineAccept = sseEvidence.connection.headers.accept;
    const configuredAccept = precedenceEvidence.connection.headers.accept;
    const sentinel = 'application/x-apc-configured';
    const containsSentinel = (value) => typeof value === 'string' && value.split(',')
      .some((range) => range.split(';', 1)[0].trim().toLowerCase() === sentinel);
    if (sseEvidence.connection.origin !== expectedOrigin || precedenceEvidence.connection.origin !== expectedOrigin) {
      set(precedenceId, 'not_verified', 'Both SSE sessions must supply evidence from the configured fixture origin.');
    } else if (baselineAccept === null) {
      set(precedenceId, 'not_verified', 'The baseline SSE session supplied no generated Accept header.');
    } else if (containsSentinel(baselineAccept)) {
      set(precedenceId, 'not_verified', 'The baseline SSE session unexpectedly contained the configured sentinel media type.');
    } else if (configuredAccept === baselineAccept) {
      set(precedenceId, 'pass', 'The configured Accept header did not override the client-generated header.');
    } else if (containsSentinel(configuredAccept)) {
      set(precedenceId, 'fail', 'The configured sentinel media type appeared in the observed Accept header.');
    } else {
      set(precedenceId, 'not_verified',
        `Accept header: expected the generated baseline ${JSON.stringify(baselineAccept)}; observed ${configuredAccept === null ? 'missing' : JSON.stringify(configuredAccept)}.`);
    }
  } else if (sseObservation || precedenceObservation) {
    set(precedenceId, 'not_verified', 'Both SSE sessions must supply initial Accept header evidence for comparison.');
  }

  const redirect = http.get('http-redirect');
  if (redirect) {
    const id = 'mcp.streamable-http.headers.cross-origin-redirect';
    const evidence = redirect.evidence;
    if (evidence === null) {
      set(id, 'not_verified', 'The completed native attempt supplied no usable redirect evidence.');
    } else if (evidence.type === 'error') {
      set(id, evidence.classification === 'redirect-refused' ? 'pass' : 'not_verified',
        evidence.classification === 'redirect-refused'
          ? 'Agent reported an unambiguous native refusal to follow the cross-origin redirect; the exact error is preserved in the observation.'
          : 'The native attempt returned an error that does not establish redirect refusal; the exact error is preserved in the observation.');
    } else {
      const expectedHeader = 'public redirect fixture value';
      const sourceHeaders = evidence.query.filter(([name]) => name === 'sourceHeader').map(([, value]) => value);
      if (sourceHeaders.length !== 1 || sourceHeaders[0] !== expectedHeader) {
        set(id, 'not_verified', 'The redirect destination supplied no usable, unambiguous evidence that the source received the expected configured header.');
      } else {
        check(id, evidence.headers['x-apc-fixture'] === null,
          'The redirected destination did not receive the configured header.',
          'The redirected destination received the configured header without destination authorization.');
      }
    }
  }

  const sseRedirectId = 'mcp.sse.headers.cross-origin-redirect';
  const sseRedirectObservation = sse.get('sse-redirect');
  const sseRedirectEvidence = sseRedirectObservation?.evidence;
  if (sseRedirectEvidence?.type === 'error') {
    set(sseRedirectId, sseRedirectEvidence.classification === 'redirect-refused' ? 'pass' : 'not_verified',
      sseRedirectEvidence.classification === 'redirect-refused'
        ? 'Agent reported an unambiguous native refusal to follow the cross-origin SSE redirect; the exact error is preserved in the observation.'
        : 'The native SSE redirect attempt returned an error that does not establish redirect refusal; the exact error is preserved in the observation.');
  } else if (sseRedirectEvidence?.type === 'sse-session') {
    const source = sseRedirectEvidence.redirectSource;
    const destination = sseRedirectEvidence.connection;
    const pathname = '/conformance/sse-redirect';
    const sourceOrigin = 'http://127.0.0.1:43187';
    const destinationOrigin = 'http://127.0.0.1:43189';
    const sourceHeader = 'public SSE redirect fixture value';
    if (source === null || source.origin !== sourceOrigin || source.pathname !== pathname ||
        source.headers['x-apc-fixture'] !== sourceHeader || destination.origin !== destinationOrigin ||
        destination.pathname !== pathname) {
      set(sseRedirectId, 'not_verified',
        'The SSE session did not supply the expected source and destination redirect route evidence.');
    } else {
      check(sseRedirectId, destination.headers['x-apc-fixture'] === null,
        'The redirected destination did not receive the configured source header.',
        'The redirected destination received the configured source header without destination authorization.');
    }
  } else if (sseRedirectObservation) {
    set(sseRedirectId, 'not_verified', 'The completed native SSE redirect attempt supplied no usable session evidence.');
  }

  const sseEndpointId = 'mcp.sse.headers.cross-origin-endpoint';
  const sseEndpointObservation = sse.get('sse-endpoint-origin');
  const sseEndpointEvidence = sseEndpointObservation?.evidence;
  if (sseEndpointEvidence?.type === 'error') {
    set(sseEndpointId, sseEndpointEvidence.classification === 'endpoint-refused' ? 'pass' : 'not_verified',
      sseEndpointEvidence.classification === 'endpoint-refused'
        ? 'Agent reported an unambiguous native refusal to use the cross-origin SSE message endpoint; the exact error is preserved in the observation.'
        : 'The native cross-origin SSE endpoint attempt returned an error that does not establish endpoint refusal; the exact error is preserved in the observation.');
  } else if (sseEndpointEvidence?.type === 'sse-session') {
    const connection = sseEndpointEvidence.connection;
    const pathname = '/conformance/sse-endpoint-origin';
    const connectionOrigin = 'http://127.0.0.1:43187';
    const endpointOrigin = 'http://127.0.0.1:43189';
    const connectionHeader = 'public SSE endpoint fixture value';
    if (sseEndpointEvidence.redirectSource !== null || connection.origin !== connectionOrigin ||
        connection.pathname !== pathname || connection.headers['x-apc-fixture'] !== connectionHeader) {
      set(sseEndpointId, 'not_verified',
        'The SSE session did not supply the expected direct connection route evidence.');
    } else if (sseEndpointEvidence.messages.some((message) =>
      message.origin === endpointOrigin && message.headers['x-apc-fixture'] !== null)) {
      set(sseEndpointId, 'fail',
        'A cross-origin SSE endpoint message received the configured connection header without endpoint authorization.');
    } else if (sseEndpointEvidence.messages.length === 0) {
      set(sseEndpointId, 'not_verified', 'No cross-origin SSE endpoint message evidence was supplied.');
    } else if (sseEndpointEvidence.messages.some((message) => message.origin !== endpointOrigin)) {
      set(sseEndpointId, 'not_verified',
        'SSE message evidence included an unexpected endpoint origin, so header delivery was not evaluated.');
    } else {
      set(sseEndpointId, 'pass', 'No cross-origin SSE endpoint message received the configured connection header.');
    }
  } else if (sseEndpointObservation) {
    set(sseEndpointId, 'not_verified', 'The completed native cross-origin SSE endpoint attempt supplied no usable session evidence.');
  }

  const missingSkills = Object.keys(CORE_SKILLS).filter((skill) => !skills.has(skill));
  const wrongSkills = Object.entries(CORE_SKILLS)
    .filter(([skill, marker]) => skills.has(skill) && skills.get(skill) !== marker)
    .map(([skill, marker]) => mismatch(`Skill marker for ${skill}`, marker, skills.get(skill)));
  const skillDetails = [...wrongSkills];
  if (missingSkills.length) skillDetails.push(`Missing skill observations: ${missingSkills.join(', ')}.`);
  if (nestedDiscovery === true) skillDetails.push('Agent reported conformance-nested advertised as an available skill.');
  if (nestedDiscovery === undefined) skillDetails.push('Missing skill discovery observation: conformance-nested.');
  set('skills.discovery.immediate-children', wrongSkills.length || nestedDiscovery === true ? 'fail'
    : missingSkills.length || nestedDiscovery === undefined ? 'not_verified' : 'pass',
    skillDetails.length ? skillDetails.join(' ')
      : 'Agent reported the expected client-loaded markers for both immediate child skills and that conformance-nested was not advertised as an available skill.');
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
  if (skills.has('conformance-invalid-mcp-valid')) {
    check('skills.recovery.invalid-mcp-document', skills.get('conformance-invalid-mcp-valid') === SKILLS['conformance-invalid-mcp-valid'],
      'Agent reported the expected client-loaded marker for the valid skill in the malformed MCP document fixture.',
      mismatch('Skill marker for conformance-invalid-mcp-valid', SKILLS['conformance-invalid-mcp-valid'], skills.get('conformance-invalid-mcp-valid')));
  }
  if (runtime.has('recovery-valid')) {
    set('mcp.stdio.recovery.valid-server-available', 'pass', 'Valid runtime evidence supplied for the recovery server.');
  }
  for (const [server, id] of Object.entries(INVALID_STDIO_SERVERS)) {
    const invalidRuntime = runtime.get(server);
    const advertised = invalidServerDiscovery.get(server);
    if (invalidRuntime) {
      set(id, 'fail',
        `${server} ran with working directory ${JSON.stringify(invalidRuntime.cwd)} and plugin root ${JSON.stringify(invalidRuntime.root)}.`);
    } else if (advertised === true) {
      set(id, 'fail', `Agent reported the ${server} observe tool advertised by the client.`);
    } else if (advertised === false && runtime.has('recovery-valid')) {
      const symlinkCwd = runtime.get('recovery-valid').symlinkCwd;
      if (server === 'recovery-cwd-symlink-escape' && !['symlink', 'missing'].includes(symlinkCwd)) {
        set(id, 'not_verified', symlinkCwd === 'other'
          ? 'The installed working-directory fixture is not a symlink; symlink containment was not verified.'
          : 'The installed working-directory fixture could not be inspected; symlink containment was not verified.');
      } else {
        set(id, 'pass', `Agent reported the ${server} tool absent from the client inventory while recovery-valid runtime evidence was available.`);
      }
    } else if (advertised === false) {
      set(id, 'not_verified',
        `Agent reported the ${server} tool absent, but recovery-valid runtime evidence is missing.`);
    } else {
      set(id, 'not_verified', `Missing MCP discovery observation for ${server}.`);
    }
  }
  for (const [server, id] of Object.entries(INVALID_HTTP_SERVERS)) {
    const observation = http.get(server);
    const advertised = invalidServerDiscovery.get(server);
    if (observation?.evidence?.type === 'request') {
      set(id, 'fail', `The invalid ${server} entry returned runtime evidence.`);
    } else if (advertised === true) {
      set(id, 'fail', `Agent reported the ${server} observe tool advertised by the client.`);
    } else if (observation) {
      set(id, 'not_verified', `The completed native attempt for ${server} did not establish exclusion; its evidence is preserved in the observation.`);
    } else if (advertised === false) {
      const missing = [
        ...(runtime.has('recovery-valid') ? [] : ['recovery-valid']),
        ...(ordinaryHttp?.evidence?.type === 'request' ? [] : ['http']),
      ];
      set(id, missing.length ? 'not_verified' : 'pass', missing.length
        ? `Agent reported the ${server} tool absent, but valid runtime evidence is missing for: ${missing.join(', ')}.`
        : `Agent reported the ${server} tool absent from the client inventory while recovery-valid and http runtime evidence was available.`);
    } else {
      set(id, 'not_verified', `Missing MCP discovery observation for ${server}.`);
    }
  }
  for (const [server, id] of Object.entries(INVALID_SSE_SERVERS)) {
    const observation = sse.get(server);
    const advertised = invalidServerDiscovery.get(server);
    if (['request', 'sse-session'].includes(observation?.evidence?.type)) {
      set(id, 'fail', `The invalid ${server} entry returned runtime evidence.`);
    } else if (advertised === true) {
      set(id, 'fail', `Agent reported the ${server} observe tool advertised by the client.`);
    } else if (observation) {
      set(id, 'not_verified', `The completed native attempt for ${server} did not establish exclusion; its evidence is preserved in the observation.`);
    } else if (advertised === false) {
      const validSseRuntime = ['request', 'sse-session'].includes(sseObservation?.evidence?.type);
      const missing = [
        ...(runtime.has('recovery-valid') ? [] : ['recovery-valid']),
        ...(validSseRuntime ? [] : ['sse']),
      ];
      set(id, missing.length ? 'not_verified' : 'pass', missing.length
        ? `Agent reported the ${server} tool absent, but valid runtime evidence is missing for: ${missing.join(', ')}.`
        : `Agent reported the ${server} tool absent from the client inventory while recovery-valid and sse runtime evidence was available.`);
    } else {
      set(id, 'not_verified', `Missing MCP discovery observation for ${server}.`);
    }
  }
  const coreData = CORE_SERVERS.filter((server) => runtime.get(server)?.resolvedData != null)
    .map((server) => [server, runtime.get(server).resolvedData]);
  const missingCoreData = CORE_SERVERS.filter((server) => runtime.get(server)?.resolvedData == null);
  const recoveryData = runtime.get('recovery-valid')?.resolvedData;
  const sharedData = coreData.filter(([, data]) => recoveryData != null && samePath(data, recoveryData, pathFlavor(data)));
  const missingData = [...(coreData.length ? [] : missingCoreData), ...(recoveryData == null ? ['recovery-valid'] : [])];
  set('filesystem.data.distinct-across-plugins', sharedData.length ? 'fail' : missingData.length ? 'not_verified' : 'pass',
    sharedData.length
      ? `Core servers ${sharedData.map(([server]) => server).join(', ')} and recovery-valid resolved PLUGIN_DATA to the same path: ${JSON.stringify(recoveryData)}.`
      : missingData.length
        ? `Resolved PLUGIN_DATA unavailable for: ${missingData.join(', ')}.`
        : `Core servers ${coreData.map(([server]) => server).join(', ')} resolved PLUGIN_DATA to paths distinct from recovery-valid (${JSON.stringify(recoveryData)}).`);

  const [firstCoreData, ...otherCoreData] = coreData;
  const inconsistentData = firstCoreData
    ? otherCoreData.filter(([, data]) => !samePath(data, firstCoreData[1], pathFlavor(firstCoreData[1]))) : [];
  set('filesystem.data.consistent-within-plugin', inconsistentData.length ? 'fail' : missingCoreData.length ? 'not_verified' : 'pass',
    inconsistentData.length
      ? [firstCoreData, ...inconsistentData].map(([server, data]) => `${server} resolved PLUGIN_DATA to ${JSON.stringify(data)}.`).join(' ')
      : missingCoreData.length
        ? `Resolved PLUGIN_DATA unavailable for: ${missingCoreData.join(', ')}.`
        : 'All four core servers resolved PLUGIN_DATA to the same path.');
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
    const writeCase = 'filesystem.data.writable';
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
      ...(nestedDiscovery === undefined ? [] : [{ kind: 'skill-discovery', skill: 'conformance-nested', advertised: nestedDiscovery }]),
      ...RECOVERY_INVALID_SERVER_NAMES.filter((server) => invalidServerDiscovery.has(server)).map((server) => ({
        kind: 'mcp-discovery', server, advertised: invalidServerDiscovery.get(server),
      })),
      ...SERVERS.filter((server) => runtime.has(server)).map((server) => {
        const evidence = runtime.get(server);
        if (server === 'recovery-valid') {
          return { kind: 'mcp-stdio', server, evidence: {
            version: evidence.version, server: evidence.server, resolvedData: evidence.resolvedData,
            ...(Object.hasOwn(evidence, 'symlinkCwd') ? { symlinkCwd: evidence.symlinkCwd } : {}),
          } };
        }
        if (INVALID_STDIO_SERVER_NAMES.includes(server)) {
          return { kind: 'mcp-stdio', server, evidence: {
            version: evidence.version, server: evidence.server, root: evidence.root, cwd: evidence.cwd,
          } };
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
      ...HTTP_SERVERS.filter((server) => http.has(server)).map((server) => {
        const observation = http.get(server);
        const evidence = canonicalHttpEvidence(observation.evidence);
        return { kind: 'mcp-streamable-http', server, evidence, serverHealthCheck: observation.serverHealthCheck };
      }),
      ...SSE_SERVERS.filter((server) => sse.has(server)).map((server) => {
        const observation = sse.get(server);
        const evidence = canonicalHttpEvidence(observation.evidence);
        return { kind: 'mcp-sse', server, evidence };
      }),
    ],
    results: ordered,
    summary,
    notes: [
      'Results describe submitted observations; they do not authenticate their source.',
      'Remote MCP error classifications are the agent’s interpretation of the preserved native diagnostic.',
      'Null Streamable HTTP evidence describes a completed unsuccessful native attempt reported by the agent; server health is checked by the reporter.',
      'SSE support is optional; missing, null, or error evidence does not establish nonconformance.',
      'Skill markers and skill or MCP discovery observations are agent assertions about client-loaded components and advertised availability, not independent proof.',
      'Directory comparisons use normalized absolute paths under the producing operating system path rules and data paths resolved by the probes; the reporter performs no filesystem lookup.',
    ],
  };
}
