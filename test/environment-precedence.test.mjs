import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateEnvironmentPrecedence } from '../scripts/environment-precedence.mjs';

test('environment precedence passes only for a delivered override with a conflicting baseline', () => {
  const result = evaluateEnvironmentPrecedence({
    control: { USER: 'ambient-user', USERNAME: 'ambient-username' },
    configured: { USER: 'fixture-user', USERNAME: 'fixture-username' },
    expected: { USER: 'fixture-user', USERNAME: 'fixture-username' },
  });
  assert.equal(result.status, 'pass');
  assert.deepEqual(result.candidates.map(({ name, status }) => [name, status]), [
    ['USER', 'pass'], ['USERNAME', 'pass'],
  ]);
});

test('environment precedence fails a missing or mismatched configured value', () => {
  const result = evaluateEnvironmentPrecedence({
    control: { USER: 'ambient-user', USERNAME: 'ambient-username' },
    configured: { USER: 'ambient-user' },
    expected: { USER: 'fixture-user', USERNAME: 'fixture-username' },
  });
  assert.equal(result.status, 'fail');
  assert.deepEqual(result.candidates.map(({ name, status }) => [name, status]), [
    ['USER', 'fail'], ['USERNAME', 'fail'],
  ]);
});

test('environment precedence is not verified when either process observation is missing', () => {
  for (const input of [
    { control: null, configured: { USER: 'fixture-user' } },
    { control: { USER: 'ambient-user' }, configured: null },
  ]) {
    const result = evaluateEnvironmentPrecedence({ ...input, expected: { USER: 'fixture-user' } });
    assert.equal(result.status, 'not_verified');
    assert.equal(result.candidates[0].status, 'not_verified');
  }
});

test('environment precedence is not verified without a conflicting ambient baseline', () => {
  const result = evaluateEnvironmentPrecedence({
    control: { USERNAME: 'fixture-username' },
    configured: { USER: 'fixture-user', USERNAME: 'fixture-username' },
    expected: { USER: 'fixture-user', USERNAME: 'fixture-username' },
  });
  assert.equal(result.status, 'not_verified');
  assert.deepEqual(result.candidates.map(({ name, status }) => [name, status]), [
    ['USER', 'not_verified'], ['USERNAME', 'not_verified'],
  ]);
});

test('one wrong configured value fails the aggregate despite another genuine replacement', () => {
  const result = evaluateEnvironmentPrecedence({
    control: { USER: 'ambient-user', USERNAME: 'ambient-username' },
    configured: { USER: 'fixture-user', USERNAME: 'ambient-username' },
    expected: { USER: 'fixture-user', USERNAME: 'fixture-username' },
  });
  assert.equal(result.status, 'fail');
  assert.deepEqual(result.candidates.map(({ name, status }) => [name, status]), [
    ['USER', 'pass'], ['USERNAME', 'fail'],
  ]);
});
