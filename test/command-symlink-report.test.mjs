import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildReport, CASE_IDS } from '../plugins/agent-plugins-conformance/src/report.mjs';

const CASE_ID = 'filesystem.containment.command-symlink-escape';
const POSIX_SERVER = 'recovery-command-symlink-posix';
const WINDOWS_SERVER = 'recovery-command-symlink-windows';
const reporter = fileURLToPath(new URL(
  '../plugins/agent-plugins-conformance/skills/run-conformance/scripts/report.mjs', import.meta.url,
));

const discovery = (server, advertised = false) => ({ kind: 'mcp-discovery', server, advertised });

const candidateRuntime = (server, {
  root = server === POSIX_SERVER ? '/plugin' : 'C:\\plugin',
  cwd = root,
} = {}) => ({
  kind: 'mcp-stdio', server,
  evidence: { version: 1, server, root, cwd },
});

const commandSymlink = ({
  server = POSIX_SERVER,
  link = 'symlink',
  root = server === POSIX_SERVER ? '/plugin' : 'C:\\plugin',
  target = server === POSIX_SERVER ? '/external/bin/launcher' : 'C:\\external\\launcher.exe',
  control = true,
  error = null,
} = {}) => ({ server, link, root, target, control, error });

const recoveryRuntime = (inspection = undefined) => ({
  kind: 'mcp-stdio', server: 'recovery-valid',
  evidence: {
    version: 1, server: 'recovery-valid', resolvedData: '/state/recovery',
    ...(inspection === undefined ? {} : { commandSymlink: inspection }),
  },
});

const report = (...observations) => buildReport({ schemaVersion: 1, observations });
const result = (value) => value.results.find(({ id }) => id === CASE_ID);
const status = (...observations) => result(report(...observations)).status;

test('the two platform fixtures feed one report case and preserve old reports', () => {
  assert.equal(CASE_IDS.filter((id) => id === CASE_ID).length, 1);
  const commandSymlinkResults = report().results.filter(({ id }) => id.includes('command-symlink'));
  assert.equal(commandSymlinkResults.length, 1);
  assert.deepEqual({
    id: commandSymlinkResults[0].id,
    status: commandSymlinkResults[0].status,
    label: commandSymlinkResults[0].label,
    specSections: commandSymlinkResults[0].specSections,
  }, {
    id: CASE_ID,
    status: 'not_verified',
    label: 'Executable symlink containment',
    specSections: ['4.1', '7.2.1', '7.2.2'],
  });

  const oldRecovery = recoveryRuntime();
  assert.equal(status(discovery(POSIX_SERVER), oldRecovery), 'not_verified');
  assert.doesNotThrow(() => report(oldRecovery));
  assert.deepEqual(report(oldRecovery).observations, [oldRecovery]);
});

test('candidate runtime or advertised discovery evidence fails regardless of the active platform', () => {
  const usablePosix = recoveryRuntime(commandSymlink());
  for (const observations of [
    [candidateRuntime(POSIX_SERVER)],
    [candidateRuntime(WINDOWS_SERVER)],
    [discovery(POSIX_SERVER, true)],
    [discovery(WINDOWS_SERVER, true)],
    [discovery(POSIX_SERVER), usablePosix, candidateRuntime(WINDOWS_SERVER)],
    [discovery(POSIX_SERVER), usablePosix, discovery(WINDOWS_SERVER, true)],
  ]) assert.equal(status(...observations), 'fail');
});

test('POSIX containment uses path boundaries rather than string prefixes', () => {
  const verdict = (target, overrides = {}) => status(
    discovery(POSIX_SERVER),
    recoveryRuntime(commandSymlink({ target, ...overrides })),
  );

  assert.equal(verdict('/external/bin/launcher'), 'pass');
  assert.equal(verdict('/plugin-other/bin/launcher'), 'pass');
  assert.equal(verdict('/plugin/bin/../../external/launcher'), 'pass');
  assert.equal(verdict('/plugin/bin/launcher'), 'not_verified');
  assert.equal(verdict('/plugin'), 'not_verified');
  assert.equal(verdict('/external/bin/launcher', { link: 'other' }), 'not_verified');
  assert.equal(verdict('/external/bin/launcher', { link: null }), 'not_verified');
  assert.equal(verdict('/external/bin/launcher', { control: false }), 'not_verified');
});

test('Windows containment is case-insensitive and recognizes sibling prefixes and other volumes', () => {
  const verdict = (target, root = 'C:\\Plugin') => status(
    discovery(WINDOWS_SERVER),
    recoveryRuntime(commandSymlink({ server: WINDOWS_SERVER, root, target })),
  );

  assert.equal(verdict('C:\\external\\launcher.exe'), 'pass');
  assert.equal(verdict('c:\\plugin-other\\launcher.exe'), 'pass');
  assert.equal(verdict('D:\\external\\launcher.exe'), 'pass');
  assert.equal(verdict('c:\\PLUGIN\\bin\\launcher.exe'), 'not_verified');
  assert.equal(verdict('c:\\plugin'), 'not_verified');
});

test('an installation-removed link passes independently of the external control', () => {
  const removed = commandSymlink({
    link: 'missing', target: null, control: false,
    error: 'ENOENT: installation link was removed before inspection',
  });
  assert.equal(status(discovery(POSIX_SERVER), recoveryRuntime(removed)), 'pass');

  assert.equal(status(discovery(POSIX_SERVER), recoveryRuntime({
    ...removed, target: '/external/bin/launcher', control: true,
  })), 'pass');
  assert.equal(status(recoveryRuntime(removed)), 'not_verified');
  assert.equal(status(discovery(POSIX_SERVER)), 'not_verified');
});

test('inspection, runtime, and discovery schemas are strict', () => {
  const validInspection = commandSymlink();
  const malformedInspections = [
    null,
    { ...validInspection, extra: true },
    { ...validInspection, server: 'recovery-command-symlink-other' },
    { ...validInspection, link: 'directory' },
    { ...validInspection, root: 'relative/plugin' },
    { ...validInspection, target: 'relative/launcher' },
    { ...validInspection, control: 1 },
    { ...validInspection, error: false },
    ...Object.keys(validInspection).map((field) => {
      const value = { ...validInspection };
      delete value[field];
      return value;
    }),
  ];
  for (const inspection of malformedInspections) {
    assert.throws(() => report(recoveryRuntime(inspection)), TypeError);
  }

  for (const server of [POSIX_SERVER, WINDOWS_SERVER]) {
    const validRuntime = candidateRuntime(server);
    const malformedRuntimes = [
      { ...validRuntime, extra: true },
      { ...validRuntime, evidence: { ...validRuntime.evidence, extra: true } },
      { ...validRuntime, evidence: { ...validRuntime.evidence, version: 2 } },
      { ...validRuntime, evidence: { ...validRuntime.evidence, server: POSIX_SERVER === server ? WINDOWS_SERVER : POSIX_SERVER } },
      { ...validRuntime, evidence: { ...validRuntime.evidence, root: 'relative' } },
      { ...validRuntime, evidence: { ...validRuntime.evidence, cwd: 'relative' } },
    ];
    for (const value of malformedRuntimes) assert.throws(() => report(value), TypeError);
    assert.throws(() => report(validRuntime, structuredClone(validRuntime)), /duplicate/);

    const validDiscovery = discovery(server);
    for (const value of [
      { ...validDiscovery, advertised: 'false' },
      { ...validDiscovery, extra: true },
      { kind: 'mcp-discovery', server },
    ]) assert.throws(() => report(value), TypeError);
    assert.throws(() => report(validDiscovery, { ...validDiscovery, advertised: true }), /duplicate/);
  }
});

test('command symlink evidence round trips canonically without changing unrelated results', () => {
  const inspection = commandSymlink({
    server: WINDOWS_SERVER,
    root: 'C:\\Plugin',
    target: 'D:\\tools\\launcher.exe',
    error: 'exact inspection diagnostic\n  with whitespace\t',
  });
  const observations = [discovery(WINDOWS_SERVER), recoveryRuntime(inspection)];
  const withEvidence = report(...observations);
  const baseline = report(discovery(WINDOWS_SERVER), recoveryRuntime());

  assert.equal(result(withEvidence).status, 'pass');
  assert.deepEqual(
    withEvidence.results.filter(({ id }) => id !== CASE_ID),
    baseline.results.filter(({ id }) => id !== CASE_ID),
  );
  assert.deepEqual(buildReport({
    schemaVersion: withEvidence.schemaVersion,
    observations: withEvidence.observations,
  }), withEvidence);
  assert.deepEqual(
    withEvidence.observations.find(({ server }) => server === 'recovery-valid').evidence.commandSymlink,
    inspection,
  );

  inspection.error = 'mutated after report';
  assert.notEqual(
    withEvidence.observations.find(({ server }) => server === 'recovery-valid').evidence.commandSymlink.error,
    inspection.error,
  );
});

test('report recording replaces discovery and recovery inspection evidence by their existing keys', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'command-symlink-report-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const output = path.join(directory, 'report.json');
  const run = (message) => spawnSync(process.execPath, [reporter, output], {
    cwd: directory,
    input: JSON.stringify(message),
    encoding: 'utf8',
    timeout: 10_000,
  });
  const record = (observation) => {
    const completed = run({ action: 'record', observation });
    assert.equal(completed.status, 0, completed.stderr);
  };
  const read = async () => JSON.parse(await readFile(output, 'utf8'));

  let completed = run({ action: 'start' });
  assert.equal(completed.status, 0, completed.stderr);
  record(discovery(POSIX_SERVER));
  record(recoveryRuntime(commandSymlink({ link: 'other' })));
  assert.equal(result(await read()).status, 'not_verified');

  record(recoveryRuntime(commandSymlink()));
  assert.equal(result(await read()).status, 'pass');

  record(discovery(POSIX_SERVER, true));
  assert.equal(result(await read()).status, 'fail');
  record(discovery(POSIX_SERVER));
  const saved = await read();
  assert.equal(result(saved).status, 'pass');
  assert.deepEqual(saved.observations.filter(({ server }) => server === POSIX_SERVER), [discovery(POSIX_SERVER)]);
  assert.equal(saved.observations.filter(({ server }) => server === 'recovery-valid').length, 1);
});
