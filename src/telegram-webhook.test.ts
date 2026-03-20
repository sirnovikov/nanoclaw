import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import net from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Detect whether listen() works (sandboxed environments may block it)
const canListen = await new Promise<boolean>((resolve) => {
  const s = net.createServer();
  s.on('error', () => resolve(false));
  s.listen(0, '127.0.0.1', () => {
    s.close(() => resolve(true));
  });
});

vi.mock('./logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

import { startWebhookServer, type WebhookServer } from './telegram-webhook.js';

function makeRequest(
  port: number,
  options: http.RequestOptions,
  body = '',
): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { ...options, hostname: '127.0.0.1', port },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString(),
          });
        });
      },
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

describe.skipIf(!canListen)('telegram-webhook', () => {
  let server: WebhookServer;

  afterEach(async () => {
    await server?.stop();
  });

  it('GET /health returns 200 "ok"', async () => {
    server = await startWebhookServer({
      port: 0,
      handler: (_req, res) => {
        res.writeHead(200);
        res.end('handled');
      },
    });

    const result = await makeRequest(server.port, {
      method: 'GET',
      path: '/health',
    });

    expect(result.statusCode).toBe(200);
    expect(result.body).toBe('ok');
  });

  it('POST /webhook delegates to the provided handler', async () => {
    const handler = vi.fn((_req: IncomingMessage, res: ServerResponse) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ received: true }));
    });

    server = await startWebhookServer({ port: 0, handler });

    const result = await makeRequest(
      server.port,
      {
        method: 'POST',
        path: '/webhook',
        headers: { 'content-type': 'application/json' },
      },
      '{"update_id":1}',
    );

    expect(handler).toHaveBeenCalledOnce();
    expect(result.statusCode).toBe(200);
    expect(result.body).toBe('{"received":true}');
  });

  it('unknown paths return 404', async () => {
    server = await startWebhookServer({
      port: 0,
      handler: (_req, res) => {
        res.writeHead(200);
        res.end();
      },
    });

    const result = await makeRequest(server.port, {
      method: 'GET',
      path: '/unknown',
    });

    expect(result.statusCode).toBe(404);
  });

  it('non-POST to /webhook returns 404', async () => {
    server = await startWebhookServer({
      port: 0,
      handler: (_req, res) => {
        res.writeHead(200);
        res.end();
      },
    });

    const result = await makeRequest(server.port, {
      method: 'GET',
      path: '/webhook',
    });

    expect(result.statusCode).toBe(404);
  });

  it('stop() resolves after in-flight requests complete', async () => {
    // Issue a request and await it, then verify stop() resolves cleanly.
    // Node's server.close() waits for all keep-alive sockets to drain,
    // so we use a keepAlive agent to keep the underlying socket alive.
    const agent = new http.Agent({ keepAlive: true });

    const handler = (_req: IncomingMessage, res: ServerResponse) => {
      res.writeHead(200);
      res.end('done');
    };

    server = await startWebhookServer({ port: 0, handler });

    const result = await makeRequest(server.port, {
      method: 'POST',
      path: '/webhook',
      agent,
    });
    expect(result.statusCode).toBe(200);
    expect(result.body).toBe('done');

    // stop() must resolve (not hang or throw) even with a keepAlive socket open
    agent.destroy(); // release keepAlive socket so server.close() can finish
    await expect(server.stop()).resolves.toBeUndefined();
  });
});
