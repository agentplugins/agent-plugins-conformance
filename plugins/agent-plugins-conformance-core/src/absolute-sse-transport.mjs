import { randomUUID } from 'node:crypto';
import { JSONRPCMessageSchema } from '@modelcontextprotocol/sdk/types.js';

const maximumMessageBytes = 4 * 1024 * 1024;

// The SDK 1.30 SSEServerTransport normalizes endpoint events to relative URLs.
// This fixture transport implements the public Transport contract so a test can
// deliberately advertise a cross-origin absolute endpoint without reaching into
// SDK-private fields.
export class AbsoluteSseServerTransport {
  constructor(endpoint, response, options = {}) {
    this.endpoint = new URL(endpoint);
    this.response = response;
    this.options = options;
    this.sessionId = randomUUID();
    this.started = false;
  }

  validateRequestHeaders(request) {
    const host = request.headers.host;
    if (this.options.allowedHosts?.length && (!host || !this.options.allowedHosts.includes(host))) {
      return `Invalid Host header: ${host}`;
    }
    const origin = request.headers.origin;
    if (origin && this.options.allowedOrigins?.length && !this.options.allowedOrigins.includes(origin)) {
      return `Invalid Origin header: ${origin}`;
    }
  }

  async start() {
    if (this.started) throw new Error('AbsoluteSseServerTransport already started');
    this.started = true;
    this.response.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    });
    const endpoint = new URL(this.endpoint);
    endpoint.searchParams.set('sessionId', this.sessionId);
    this.response.write(`event: endpoint\ndata: ${endpoint.href}\n\n`);
    this.response.on('close', () => {
      if (!this.started) return;
      this.started = false;
      this.onclose?.();
    });
  }

  async handlePostMessage(request, response) {
    if (!this.started) {
      response.writeHead(500).end('SSE connection not established');
      return;
    }
    const validationError = this.validateRequestHeaders(request);
    if (validationError) {
      response.writeHead(403).end(validationError);
      this.onerror?.(new Error(validationError));
      return;
    }
    if ((request.headers['content-type'] ?? '').split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
      response.writeHead(400).end('Unsupported content-type');
      return;
    }
    const chunks = [];
    let bytes = 0;
    for await (const chunk of request) {
      bytes += chunk.length;
      if (bytes > maximumMessageBytes) {
        response.writeHead(413).end('Message exceeds 4 MiB');
        return;
      }
      chunks.push(chunk);
    }
    let message;
    try {
      message = JSONRPCMessageSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    } catch (error) {
      response.writeHead(400).end('Invalid JSON-RPC message');
      this.onerror?.(error);
      return;
    }
    this.onmessage?.(message);
    response.writeHead(202).end('Accepted');
  }

  async send(message) {
    if (!this.started) throw new Error('Not connected');
    this.response.write(`event: message\ndata: ${JSON.stringify(message)}\n\n`);
  }

  async close() {
    if (!this.started) return;
    this.started = false;
    this.response.end();
    this.onclose?.();
  }
}
