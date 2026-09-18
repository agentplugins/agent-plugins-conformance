import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, writeFile, readFile, readdir, cp, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildReport } from '../plugins/agent-plugins-conformance/src/report.mjs';
import { formatReport } from '../plugins/agent-plugins-conformance/src/report-format.mjs';

const plugin = fileURLToPath(new URL('../plugins/agent-plugins-conformance', import.meta.url));
const script = path.join(plugin, 'skills/run-conformance/scripts/summarize.mjs');
const report = () => buildReport({ schemaVersion: 1, observations: [] });
const run = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });

test('summarizer renders saved judgments, including future IDs, without reevaluating observations or writing artifacts', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'apc-summary-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'report.json');
  const value = report();
  value.specVersion = 'future-spec';
  value.results = [
    { id: 'future.check', label: 'Future check', status: 'fail', detail: 'Saved failure.', specSections: ['new'] },
    { id: 'skills.future', label: 'Future skill', status: 'not_verified', detail: 'Saved missing evidence.', specSections: [] },
    { id: 'mcp.stdio.cwd.omitted', label: 'Previously evaluated cwd', status: 'pass', detail: 'Saved pass with no observations.', specSections: ['9'] },
  ];
  value.summary = { pass: 1, fail: 1, not_verified: 1, total: 3 };
  // Display remains valid even if an older producer's observations cannot be evaluated now.
  value.observations = [{ kind: 'future-evidence', data: true }];
  const original = JSON.stringify(value, null, 2);
  await writeFile(filename, original);
  const output = run(filename);
  assert.equal(output.status, 0, output.stderr);
  assert.equal(output.stderr, '');
  assert.equal(output.stdout.trimEnd(), formatReport(value));
  assert.match(output.stdout, /Other\s+0\s+1\s+0/);
  assert.match(output.stdout, /Total\s+1\s+1\s+1/);
  assert.match(output.stdout, /Future check \(future.check\)\n    Saved failure\./);
  assert.match(output.stdout, /Future skill \(skills.future\)\n    Saved missing evidence\./);
  assert.equal(await readFile(filename, 'utf8'), original);
  assert.deepEqual(await readdir(directory), ['report.json']);
});

test('successful formatting is independent of pass, fail, or missing evidence', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'apc-summary-status-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'report.json');
  for (const status of ['pass', 'fail', 'not_verified']) {
    const value = report();
    for (const result of value.results) result.status = status;
    value.summary = { pass: 0, fail: 0, not_verified: 0, total: 20, [status]: 20 };
    await writeFile(filename, JSON.stringify(value));
    const output = run(filename);
    assert.equal(output.status, 0, output.stderr);
    assert.equal(output.stdout.trimEnd(), formatReport(value));
  }
});

test('summarizer renders a saved cleanup warning from canonical evaluator output', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'apc-summary-warning-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'report.json');
  const value = buildReport({
    schemaVersion: 1,
    observations: [{
      kind: 'mcp-stdio', server: 'default', evidence: {
        version: 1, server: 'default', root: '/plugin', cwd: '/plugin', resolvedData: '/data',
        dataWrite: {
          path: '/data/.agent-plugins-conformance-write-test', error: null,
          cleanupError: { code: 'EBUSY', message: 'resource busy' },
        },
        argv: ['default', 'arg with spaces', '', '/plugin', '/data', '${APC_UNKNOWN}', '$APC_VALUE', '${PLUGIN_ROOT_SUFFIX}'],
        env: {
          PLUGIN_ROOT: '/plugin', PLUGIN_DATA: '/data', APC_VALUE: 'fixture value with spaces',
          APC_EXPANSION: '/plugin|/data|/plugin', APC_LITERAL: '${APC_UNKNOWN}|$APC_VALUE|${PLUGIN_ROOT_SUFFIX}',
        },
      },
    }],
  });
  await writeFile(filename, JSON.stringify(value));

  const output = run(filename);
  assert.equal(output.status, 0, output.stderr);
  assert.equal(output.stderr, '');
  assert.equal(output.stdout.trimEnd(), formatReport(value));
  assert.match(output.stdout, /\nWarnings\n/);
  assert.match(output.stdout, /Plugin data writability \(mcp\.stdio\.data\.writable\)/);
  assert.match(output.stdout, /EBUSY/);
  assert.match(output.stdout, /resource busy/);
});

test('malformed saved reports fail instead of printing misleading partial summaries', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'apc-summary-errors-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'report.json');
  const changes = [
    (value) => { value.schemaVersion = 2; },
    (value) => { value.specVersion = null; },
    (value) => { value.observations = {}; },
    (value) => { value.results = {}; },
    (value) => { value.results[0].status = 'unknown'; },
    (value) => { value.results[0].id = value.results[1].id; },
    (value) => { value.results[0].label = 42; },
    (value) => { value.results[0].detail = null; },
    (value) => { value.results[0].specSections = '9'; },
    (value) => { value.summary.not_verified = 0; },
    (value) => { value.summary.total = 16; },
    (value) => { value.summary.pass = '0'; },
    (value) => { value.notes = [null]; },
  ];
  for (const change of changes) {
    const value = report();
    change(value);
    await writeFile(filename, JSON.stringify(value));
    const output = run(filename);
    assert.equal(output.status, 2, output.stdout);
    assert.equal(output.stdout, '');
    assert.match(output.stderr, /^Summary error: report\./);
  }
  await writeFile(filename, '{broken');
  assert.equal(run(filename).status, 2);
  for (const args of [[], ['relative.json'], [filename, 'extra'], [directory], [path.join(directory, 'missing')]]) {
    const output = run(...args);
    assert.equal(output.status, 2);
    assert.equal(output.stdout, '');
    assert.match(output.stderr, /^Summary error:/);
  }
});

test('all displayed saved strings and errors escape terminal controls and extra lines', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'apc-summary-controls-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'report.json');
  const value = report();
  const injection = '\nFAKE\x1b[2J\x7f\x85\u2028\u202e';
  value.specVersion += injection;
  for (const field of ['id', 'label', 'detail']) value.results[0][field] += injection;
  await writeFile(filename, JSON.stringify(value));
  const output = run(filename);
  assert.equal(output.status, 0, output.stderr);
  assert.doesNotMatch(output.stdout, /[\x00-\x09\x0b-\x1f\x7f-\x9f\u2028-\u202e]/);
  assert.doesNotMatch(output.stdout, /\nFAKE/);
  assert.match(output.stdout, /\\nFAKE\\u001b\[2J\\u007f\\u0085\\u2028\\u202e/);
  const failure = run(path.join(directory, `missing${injection}`));
  assert.equal(failure.status, 2);
  assert.doesNotMatch(failure.stderr, /\nFAKE|\x1b|\u2028|\u202e/);
});

test('copied plugin runs from an unrelated working directory with no dependencies or build', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'apc-summary-copy-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const copied = path.join(directory, 'installed plugin');
  await cp(path.join(plugin, 'src/report-format.mjs'), path.join(copied, 'src/report-format.mjs'), { recursive: true });
  await cp(script, path.join(copied, 'skills/run-conformance/scripts/summarize.mjs'), { recursive: true });
  const filename = path.join(directory, 'report.json');
  await writeFile(filename, JSON.stringify(report()));
  const output = spawnSync(process.execPath, [path.join(copied, 'skills/run-conformance/scripts/summarize.mjs'), filename], {
    cwd: os.tmpdir(), encoding: 'utf8',
  });
  assert.equal(output.status, 0, output.stderr);
  assert.equal(output.stdout.trimEnd(), formatReport(report()));
});
