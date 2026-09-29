import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import test from 'node:test';
import { buildReport } from '../plugins/agent-plugins-conformance/src/report.mjs';

const reporter = fileURLToPath(new URL(
  '../plugins/agent-plugins-conformance/skills/run-conformance/scripts/report.mjs', import.meta.url,
));
const start = { action: 'start' };
const skill = (name, marker = `APC_${name.toUpperCase()}_V1`) => ({
  kind: 'skill', skill: `conformance-${name}`, marker,
});
const discoveryServers = [
  'recovery-cwd-invalid-form',
  'recovery-cwd-escape',
  'recovery-cwd-data-escape',
  'recovery-cwd-symlink-escape',
  'recovery-command-symlink-posix',
  'recovery-command-symlink-windows',
  'recovery-unknown-field',
  'recovery-missing-type',
  'recovery-env-plugin-root',
  'recovery-env-plugin-data',
  'recovery-http-type',
  'recovery-http-non-loopback',
  'recovery-http-relative-url',
  'recovery-http-fragment',
  'recovery-http-userinfo',
  'recovery-http-duplicate-headers',
  'recovery-http-header-name',
  'recovery-http-header-value',
  'recovery-sse-non-loopback',
  'recovery-sse-relative-url',
];
const discovery = (server) => ({ kind: 'mcp-discovery', server, advertised: false });
const http = () => ({
  kind: 'mcp-streamable-http', server: 'http', evidence: {
    type: 'request', version: 1, pathname: '/conformance/mcp', query: [['value', '$APC_HTTP_VALUE']],
    headers: { 'x-apc-fixture': '${PLUGIN_ROOT}|${PLUGIN_DATA}|fixture value with spaces' },
  },
});

function spawnReporter(fixture, message, nodeArgs = []) {
  const child = spawn(process.execPath, [...nodeArgs, reporter, fixture.outputPath], {
    cwd: fixture.directory,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
  const result = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  const running = { child, result };
  fixture.processes.add(running);
  result.then(
    () => fixture.processes.delete(running),
    () => fixture.processes.delete(running),
  );
  child.stdin.end(JSON.stringify(message));
  return { child, result };
}

async function runReporter(fixture, message, nodeArgs = []) {
  return spawnReporter(fixture, message, nodeArgs).result;
}

function assertSuccess(result, action = 'record') {
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.signal, null);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, action === 'start' ? 'Report started.\n' : 'Observation recorded.\n');
}

async function makeFixture(t, observations = []) {
  const directory = await mkdtemp(join(tmpdir(), 'report-concurrency-'));
  const outputPath = join(directory, 'nested directory', 'report with spaces.json');
  await mkdir(dirname(outputPath), { recursive: true });
  const fixture = { directory, outputPath, processes: new Set() };
  t.after(async () => {
    for (const { child } of fixture.processes) child.kill('SIGKILL');
    await Promise.allSettled([...fixture.processes].map(({ result }) => result));
    await rm(directory, { recursive: true, force: true });
  });
  assertSuccess(await runReporter(fixture, start), 'start');
  for (const observation of observations) {
    assertSuccess(await runReporter(fixture, { action: 'record', observation }));
  }
  return fixture;
}

async function readReport(fixture) {
  return JSON.parse(await readFile(fixture.outputPath, 'utf8'));
}

async function assertUnlocked(fixture) {
  await assert.rejects(readdir(`${fixture.outputPath}.lock`), { code: 'ENOENT' });
}

async function waitFor(check, description, timeout = 10_000) {
  const deadline = performance.now() + timeout;
  for (;;) {
    if (await check()) return;
    if (performance.now() >= deadline) throw new Error(`Timed out waiting for ${description}`);
    await delay(10);
  }
}

async function makeFsBarrier(fixture, mode) {
  const barrier = await mkdtemp(join(fixture.directory, 'barrier-'));
  const release = join(barrier, 'release');
  const preload = join(barrier, 'preload.mjs');
  await writeFile(preload, `
    import fs from 'node:fs/promises';
    import { syncBuiltinESMExports } from 'node:module';
    import { setTimeout as delay } from 'node:timers/promises';

    const target = ${JSON.stringify(fixture.outputPath)};
    const barrier = ${JSON.stringify(barrier)};
    const release = ${JSON.stringify(release)};
    const mode = ${JSON.stringify(mode)};
    let firstTargetRead = true;
    let firstTemporaryOpen = true;
    const originalOpen = fs.open.bind(fs);
    const originalReadFile = fs.readFile.bind(fs);

    async function signalAndWait() {
      await fs.writeFile(barrier + '/' + process.pid + '.ready', 'ready');
      for (;;) {
        try {
          await fs.access(release);
          return;
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
        await delay(10);
      }
    }

    fs.readFile = async function readFile(path, ...args) {
      const value = await originalReadFile(path, ...args);
      if (mode === 'read' && firstTargetRead && String(path) === target) {
        firstTargetRead = false;
        await signalAndWait();
      }
      return value;
    };

    fs.open = async function open(path, ...args) {
      const handle = await originalOpen(path, ...args);
      const name = String(path);
      if (mode === 'open' && firstTemporaryOpen && name.includes('.conformance-report-') && name.endsWith('.tmp')) {
        firstTemporaryOpen = false;
        await signalAndWait();
      }
      return handle;
    };

    syncBuiltinESMExports();
  `);
  return {
    nodeArgs: ['--import', pathToFileURL(preload).href],
    release: () => writeFile(release, 'release'),
    waitForReady: (count) => waitFor(async () => (
      await readdir(barrier)
    ).filter((name) => name.endsWith('.ready')).length >= count, `${count} reporter processes at the barrier`),
  };
}

async function makeFetchBarrier(fixture) {
  const barrier = await mkdtemp(join(fixture.directory, 'fetch-barrier-'));
  const ready = join(barrier, 'ready');
  const release = join(barrier, 'release');
  const preload = join(barrier, 'preload.mjs');
  await writeFile(preload, `
    import * as fs from 'node:fs/promises';
    import { setTimeout as delay } from 'node:timers/promises';

    globalThis.fetch = async () => {
      await fs.writeFile(${JSON.stringify(ready)}, 'ready');
      for (;;) {
        try {
          await fs.access(${JSON.stringify(release)});
          break;
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
        await delay(10);
      }
      return {
        status: 200,
        json: async () => ({ fixture: 'agent-plugins-conformance-http', version: 1 }),
      };
    };
  `);
  return {
    nodeArgs: ['--import', pathToFileURL(preload).href],
    release: () => writeFile(release, 'release'),
    waitForReady: () => waitFor(async () => {
      try {
        await readFile(ready);
        return true;
      } catch (error) {
        if (error.code === 'ENOENT') return false;
        throw error;
      }
    }, 'HTTP reporter health request'),
  };
}

test('concurrent processes preserve records derived from the same preflight snapshot', async (t) => {
  const fixture = await makeFixture(t);
  const barrier = await makeFsBarrier(fixture, 'read');
  const observations = discoveryServers.map(discovery);
  const writers = observations.map((observation) => spawnReporter(
    fixture, { action: 'record', observation }, barrier.nodeArgs,
  ));

  await barrier.waitForReady(writers.length);
  await barrier.release();
  for (const writer of writers) assertSuccess(await writer.result);

  assert.deepEqual(await readReport(fixture), buildReport({ schemaVersion: 1, observations }));
  await assertUnlocked(fixture);
});

test('concurrent same-key records publish one complete replacement', async (t) => {
  const fixture = await makeFixture(t);
  const barrier = await makeFsBarrier(fixture, 'read');
  const candidates = [skill('alpha'), skill('alpha', 'incorrect marker')];
  const writers = candidates.map((observation) => spawnReporter(
    fixture, { action: 'record', observation }, barrier.nodeArgs,
  ));

  await barrier.waitForReady(writers.length);
  await barrier.release();
  for (const writer of writers) assertSuccess(await writer.result);

  const report = await readReport(fixture);
  assert.equal(report.observations.length, 1);
  assert.ok(candidates.some((candidate) => isDeepStrictEqual(report.observations[0], candidate)));
  assert.deepEqual(report, buildReport({ schemaVersion: 1, observations: report.observations }));
  await assertUnlocked(fixture);
});

test('a record committed while HTTP health waits survives the delayed writer', async (t) => {
  const oldObservation = skill('alpha');
  const concurrentObservation = skill('beta');
  const httpObservation = http();
  const fixture = await makeFixture(t, [oldObservation]);
  const barrier = await makeFetchBarrier(fixture);
  const delayedWriter = spawnReporter(fixture, {
    action: 'record', observation: httpObservation,
  }, barrier.nodeArgs);

  await barrier.waitForReady();
  assertSuccess(await runReporter(fixture, {
    action: 'record', observation: concurrentObservation,
  }));
  await barrier.release();
  assertSuccess(await delayedWriter.result);

  assert.deepEqual(await readReport(fixture), buildReport({
    schemaVersion: 1,
    observations: [oldObservation, concurrentObservation, { ...httpObservation, serverHealthCheck: 'passed' }],
  }));
  await assertUnlocked(fixture);
});

test('start cannot be undone by a record whose preflight read saw the old report', async (t) => {
  const oldObservation = skill('alpha');
  const newObservation = skill('beta');
  const fixture = await makeFixture(t, [oldObservation]);
  const barrier = await makeFsBarrier(fixture, 'read');
  const writer = spawnReporter(fixture, { action: 'record', observation: newObservation }, barrier.nodeArgs);

  await barrier.waitForReady(1);
  assertSuccess(await runReporter(fixture, start), 'start');
  await barrier.release();
  assertSuccess(await writer.result);

  assert.deepEqual(await readReport(fixture), buildReport({ schemaVersion: 1, observations: [newObservation] }));
  await assertUnlocked(fixture);
});

test('a writer waits for a held report lock and proceeds after release', async (t) => {
  const oldObservation = skill('alpha');
  const newObservation = skill('beta');
  const fixture = await makeFixture(t, [oldObservation]);
  const destination = join(await realpath(dirname(fixture.outputPath)), basename(fixture.outputPath));
  const lockPath = `${destination}.lock`;
  await mkdir(lockPath);
  const owner = randomUUID();
  await writeFile(join(lockPath, owner), '');
  const writer = spawnReporter(fixture, { action: 'record', observation: newObservation });

  await delay(250);
  assert.equal(writer.child.exitCode, null);
  await rename(lockPath, `${lockPath}-released`);
  assertSuccess(await writer.result);

  assert.deepEqual(await readReport(fixture), buildReport({
    schemaVersion: 1, observations: [oldObservation, newObservation],
  }));
  await assertUnlocked(fixture);
});

test('writers recover an expired lock after its owner is killed and preserve every record', { timeout: 30_000 }, async (t) => {
  const oldObservation = skill('alpha');
  const fixture = await makeFixture(t, [oldObservation]);
  const before = await readFile(fixture.outputPath, 'utf8');
  const barrier = await makeFsBarrier(fixture, 'open');
  const interrupted = spawnReporter(fixture, {
    action: 'record', observation: skill('beta'),
  }, barrier.nodeArgs);

  await barrier.waitForReady(1);
  assert.equal(interrupted.child.kill('SIGKILL'), true);
  const interruptedResult = await interrupted.result;
  assert.notEqual(interruptedResult.code, 0);
  assert.equal(await readFile(fixture.outputPath, 'utf8'), before);
  assert.deepEqual(await readReport(fixture), buildReport({ schemaVersion: 1, observations: [oldObservation] }));

  const observations = discoveryServers.map(discovery);
  const writers = observations.map((observation) => spawnReporter(
    fixture, { action: 'record', observation },
  ));
  for (const writer of writers) assertSuccess(await writer.result);

  assert.deepEqual(await readReport(fixture), buildReport({
    schemaVersion: 1, observations: [oldObservation, ...observations],
  }));
  await assertUnlocked(fixture);
});
