export function requestEvidence(request) {
  // Preserve the received pathname: URL parsing would normalize dot segments.
  const separator = request.url.indexOf('?');
  const pathname = separator === -1 ? request.url : request.url.slice(0, separator);
  return {
    type: 'request',
    version: 1,
    pathname,
    // URLSearchParams yields decoded pairs and preserves duplicates and order.
    query: [...new URLSearchParams(separator === -1 ? '' : request.url.slice(separator + 1))],
    headers: { 'x-apc-fixture': request.headers['x-apc-fixture'] ?? null },
  };
}
