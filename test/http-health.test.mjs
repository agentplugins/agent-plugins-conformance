import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { checkHttpHealth } from '../plugins/agent-plugins-conformance/src/http-health.mjs';

const identity = { fixture: 'agent-plugins-conformance-http', version: 1 };

test('health checker uses the fixed local endpoint and accepts only its exact identity', async () => {
  const health = await checkHttpHealth(async (url, options) => {
    assert.equal(url, 'http://127.0.0.1:43187/conformance/health');
    assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal instanceof AbortSignal);
    return { status: 200, json: async () => ({ version: 1, fixture: identity.fixture }) };
  });
  assert.equal(health, 'passed');
  for (const body of [null, [], {}, { ...identity, version: 2 }, { ...identity, extra: true },
    { ...identity, fixture: 'another-service' }]) {
    const result = await checkHttpHealth(async () => ({ status: 200, json: async () => body }));
    assert.equal(result, 'failed');
  }
});

test('unavailable, redirected, wrong-status, and malformed health responses are factual failures', async () => {
  for (const status of [204, 302, 404, 500]) {
    const health = await checkHttpHealth(async () => ({ status, json() { assert.fail('status must be checked before body'); } }));
    assert.equal(health, 'failed');
  }
  for (const message of ['connection refused', 'unexpected redirect']) {
    const health = await checkHttpHealth(async () => { throw new Error(message); });
    assert.equal(health, 'failed');
  }
  const malformed = await checkHttpHealth(async () => ({
    status: 200, json: async () => { throw new SyntaxError('invalid JSON'); },
  }));
  assert.equal(malformed, 'failed');
});

test('health deadline covers both connection and body completion and aborts each request', async () => {
  const signals = [];
  const [connection, body] = await Promise.all([
    checkHttpHealth(async (_, { signal }) => {
      signals.push(signal);
      return setTimeout(10_000, undefined, { signal });
    }),
    checkHttpHealth(async (_, { signal }) => {
      signals.push(signal);
      return { status: 200, json: () => setTimeout(10_000, undefined, { signal }) };
    }),
  ]);
  for (const result of [connection, body]) {
    assert.equal(result, 'failed');
  }
  assert.ok(signals.every((signal) => signal.aborted));
});
