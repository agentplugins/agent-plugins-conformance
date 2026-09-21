import assert from 'node:assert/strict';
import test from 'node:test';
import { buildReport } from '../plugins/agent-plugins-conformance/src/report.mjs';

const id = 'mcp.streamable-http.headers.cross-origin-redirect';
const marker = 'public redirect fixture value';
const nativeError = 'tool call error: tool call failed for `http-redirect/observe`\n\nCaused by:\n    unexpected server response: HTTP 307: ';
const request = (receivedHeader, query = [['sourceHeader', marker]], pathname = '/conformance/redirect') => ({
  kind: 'mcp-streamable-http', server: 'http-redirect', serverHealthCheck: 'passed',
  evidence: { type: 'request', version: 1, pathname, query, headers: { 'x-apc-fixture': receivedHeader } },
});
const error = (classification, message = nativeError) => ({
  kind: 'mcp-streamable-http', server: 'http-redirect', serverHealthCheck: 'passed',
  evidence: { type: 'error', message, classification },
});
const report = (...observations) => buildReport({ schemaVersion: 1, observations });
const outcome = (value) => value.results.find((result) => result.id === id).status;

test('redirect evaluation distinguishes refusal, stripping, forwarding, ambiguity, and missing evidence', () => {
  assert.equal(outcome(report(error('redirect-refused'))), 'pass');
  assert.equal(outcome(report(error(null, 'Connection timed out after HTTP 307'))), 'not_verified');
  assert.equal(outcome(report(request(null))), 'pass');
  assert.equal(outcome(report(request(marker))), 'fail');
  assert.equal(outcome(report(request(''))), 'fail');
  assert.equal(outcome(report({ ...request(null), evidence: null })), 'not_verified');
  assert.equal(outcome(report()), 'not_verified');
  assert.equal(report(error('redirect-refused')).observations[0].evidence.message, nativeError);
});

test('redirect evaluation requires one exact source marker but ignores unrelated request facts', () => {
  for (const query of [[], [['sourceHeader', 'wrong']], [['sourceHeader', marker], ['sourceHeader', marker]]]) {
    assert.equal(outcome(report(request(null, query))), 'not_verified');
  }
  const query = [['unrelated', 'before'], ['sourceHeader', marker], ['other', 'after']];
  assert.equal(outcome(report(request(null, query, '/unrelated/path'))), 'pass');
  assert.equal(outcome(report(request(marker, query, '/unrelated/path'))), 'fail');
});

test('HTTP evidence variants are closed and structurally independent of server identity', () => {
  const ordinaryError = { ...error(null), server: 'http' };
  assert.doesNotThrow(() => report(ordinaryError));
  assert.equal(report(ordinaryError).results.find((result) => result.id === 'mcp.streamable-http.tool-availability').status, 'fail');
  assert.doesNotThrow(() => report(request(null)));

  for (const evidence of [
    { type: 'error', message: nativeError, classification: 'unknown' },
    { type: 'error', message: nativeError, classification: null, version: 1 },
    { type: 'error', message: '', classification: null },
    { type: 'request', version: 1, pathname: '/', query: [], headers: {}, message: nativeError },
    { type: 'request', version: 1, pathname: '/', query: [], headers: {} },
    { type: 'unknown' },
  ]) {
    assert.throws(() => report({
      kind: 'mcp-streamable-http', server: 'http-redirect', serverHealthCheck: 'passed', evidence,
    }));
  }
});

test('redirect health is retained but never adjudicates missing or ambiguous evidence', () => {
  for (const serverHealthCheck of ['passed', 'failed']) {
    const missing = { ...request(null), evidence: null, serverHealthCheck };
    const ambiguous = { ...error(null), serverHealthCheck };
    assert.equal(outcome(report(missing)), 'not_verified');
    assert.equal(outcome(report(ambiguous)), 'not_verified');
    assert.equal(report(ambiguous).observations[0].serverHealthCheck, serverHealthCheck);
  }
});
