import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { observeDataWrite } from '../plugins/agent-plugins-conformance-core/src/data-write.mjs';

const makeDirectory = () => fs.mkdtempSync(join(tmpdir(), 'agent-plugins-data-write-'));

test('skips missing and relative PLUGIN_DATA values', () => {
  assert.equal(observeDataWrite(undefined), null);
  assert.equal(observeDataWrite('relative/data'), null);
});

test('writes directly in PLUGIN_DATA, cleans up, and freshly observes directory availability', (t) => {
  const data = makeDirectory();
  t.after(() => fs.rmSync(data, { recursive: true, force: true }));
  const existing = join(data, 'existing.txt');
  fs.writeFileSync(existing, 'keep me');

  const first = observeDataWrite(data);
  assert.equal(first.error, null);
  assert.equal(first.cleanupError, null);
  assert.equal(fs.existsSync(first.path), false);
  assert.equal(fs.readFileSync(existing, 'utf8'), 'keep me');

  fs.rmSync(data, { recursive: true });
  const unavailable = observeDataWrite(data);
  assert.equal(unavailable.error.operation, 'create');
  assert.equal(unavailable.error.code, 'ENOENT');
  assert.equal(unavailable.cleanupError, null);

  fs.mkdirSync(data);
  const restored = observeDataWrite(data);
  assert.equal(restored.error, null);
  assert.equal(restored.cleanupError, null);
  assert.notEqual(restored.path, first.path);
});

test('reports real create failures without disturbing neighboring files', (t) => {
  const parent = makeDirectory();
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const existing = join(parent, 'existing.txt');
  fs.writeFileSync(existing, 'keep me');

  const missing = observeDataWrite(join(parent, 'missing'));
  assert.equal(missing.error.operation, 'create');
  assert.equal(missing.error.code, 'ENOENT');
  assert.equal(missing.cleanupError, null);

  const notDirectory = observeDataWrite(existing);
  assert.equal(notDirectory.error.operation, 'create');
  assert.match(notDirectory.error.code, /^(ENOENT|ENOTDIR)$/);
  assert.equal(notDirectory.cleanupError, null);
  assert.equal(fs.readFileSync(existing, 'utf8'), 'keep me');
});

test('reports a genuine permission failure when the platform can enforce it', (t) => {
  if (process.platform === 'win32' || process.getuid?.() === 0) {
    t.skip('mode-bit permission failures are not reliable on this platform or as root');
    return;
  }
  const data = makeDirectory();
  t.after(() => {
    fs.chmodSync(data, 0o755);
    fs.rmSync(data, { recursive: true, force: true });
  });
  fs.chmodSync(data, 0o555);
  const observation = observeDataWrite(data);
  assert.equal(observation.error.operation, 'create');
  assert.match(observation.error.code, /^(EACCES|EPERM)$/);
  assert.equal(observation.cleanupError, null);
});

test('removes its created file after a write failure', (t) => {
  const data = makeDirectory();
  t.after(() => fs.rmSync(data, { recursive: true, force: true }));
  t.mock.method(fs, 'writeFileSync', () => {
    throw Object.assign(new Error('injected write failure'), { code: 'EIO' });
  });

  const observation = observeDataWrite(data);
  assert.deepEqual(observation.error, {
    operation: 'write', code: 'EIO', message: 'injected write failure',
  });
  assert.equal(observation.cleanupError, null);
  assert.equal(fs.existsSync(observation.path), false);
});

test('reports a close failure and still removes its created file', (t) => {
  const data = makeDirectory();
  t.after(() => fs.rmSync(data, { recursive: true, force: true }));
  const closeSync = fs.closeSync.bind(fs);
  t.mock.method(fs, 'closeSync', (descriptor) => {
    closeSync(descriptor);
    throw Object.assign(new Error('injected close failure'), { code: 'EIO' });
  });

  const observation = observeDataWrite(data);
  assert.deepEqual(observation.error, {
    operation: 'close', code: 'EIO', message: 'injected close failure',
  });
  assert.equal(observation.cleanupError, null);
  assert.equal(fs.existsSync(observation.path), false);
});

test('reports a cleanup failure and leaves the path available for recovery', (t) => {
  const data = makeDirectory();
  t.after(() => fs.rmSync(data, { recursive: true, force: true }));
  t.mock.method(fs, 'unlinkSync', () => {
    throw Object.assign(new Error('injected cleanup failure'), { code: 'EBUSY' });
  });

  const observation = observeDataWrite(data);
  assert.equal(observation.error, null);
  assert.deepEqual(observation.cleanupError, {
    code: 'EBUSY', message: 'injected cleanup failure',
  });
  assert.equal(fs.existsSync(observation.path), true);
});

test('an exclusive-create collision never deletes the existing file', (t) => {
  const data = makeDirectory();
  t.after(() => fs.rmSync(data, { recursive: true, force: true }));
  const writeFileSync = fs.writeFileSync.bind(fs);
  let collidedPath;
  t.mock.method(fs, 'openSync', (path, flags) => {
    assert.equal(flags, 'wx');
    collidedPath = path;
    writeFileSync(path, 'existing collision');
    throw Object.assign(new Error('injected exclusive collision'), { code: 'EEXIST' });
  });

  const observation = observeDataWrite(data);
  assert.equal(observation.path, collidedPath);
  assert.deepEqual(observation.error, {
    operation: 'create', code: 'EEXIST', message: 'injected exclusive collision',
  });
  assert.equal(observation.cleanupError, null);
  assert.equal(fs.readFileSync(collidedPath, 'utf8'), 'existing collision');
});
