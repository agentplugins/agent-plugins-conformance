import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluate } from './evaluate.mjs';

for (const platform of ['darwin', 'win32']) {
  const root = platform === 'win32' ? 'C:\\plugins\\recovery' : '/plugins/recovery';
  const parent = platform === 'win32' ? 'C:\\plugins' : '/plugins';
  const escape = { root, kind: 'symlink', linkText: '..', resolvedKind: 'directory', resolvedPath: parent };
  const control = { kind: 'mcp-stdio', server: 'recovery-valid' };
  const baseline = { platform, input: escape, installed: escape, inventory: { complete: true, advertised: false }, control };
  test(`${platform}: exclusion accepts preserved and removed links when the input escape is known`, () => {
    assert.equal(evaluate(baseline).status, 'pass');
    assert.equal(evaluate({ ...baseline, installed: { root, kind: 'missing' } }).status, 'pass');
  });
  test(`${platform}: non-symlink input and missing provenance provide no containment evidence`, () => {
    assert.equal(evaluate({ ...baseline, input: { root, kind: 'file' }, installed: { root, kind: 'file' } }).status, 'not_verified');
    assert.equal(evaluate({ ...baseline, input: undefined, installed: { root, kind: 'missing' } }).status, 'not_verified');
    assert.equal(evaluate({ ...baseline, input: undefined }).status, 'pass');
  });
  test(`${platform}: safe control is not graded as an invalid server`, () => {
    const safe = { ...escape, linkText: '.', resolvedPath: root };
    assert.equal(evaluate({ ...baseline, input: safe, installed: safe, inventory: { complete: true, advertised: true } }).status, 'not_verified');
  });
  test(`${platform}: positive failures and incomplete evidence remain distinct`, () => {
    assert.equal(evaluate({ ...baseline, inventory: { complete: true, advertised: true } }).status, 'fail');
    assert.equal(evaluate({ ...baseline, inventory: { complete: false, advertised: false } }).status, 'not_verified');
    assert.equal(evaluate({ ...baseline, control: undefined }).status, 'not_verified');
    const target = { kind: 'mcp-stdio', server: 'recovery-cwd-symlink-escape', evidence: { root, cwd: parent } };
    assert.equal(evaluate({ platform, target }).status, 'fail');
  });
}
