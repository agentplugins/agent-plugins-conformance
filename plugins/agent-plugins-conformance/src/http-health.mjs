const HEALTH_URL = 'http://127.0.0.1:43187/conformance/health';
const TIMEOUT_MS = 2000;

// This diagnostic is deliberately independent of the client's MCP connection.
export async function checkHttpHealth(fetch = globalThis.fetch) {
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  try {
    const response = await fetch(HEALTH_URL, { method: 'GET', redirect: 'error', signal });
    if (response.status !== 200) return 'failed';
    const body = await response.json();
    return body && typeof body === 'object' && !Array.isArray(body) &&
      Object.keys(body).length === 2 &&
      body.fixture === 'agent-plugins-conformance-http' && body.version === 1
      ? 'passed' : 'failed';
  } catch {
    return 'failed';
  }
}
