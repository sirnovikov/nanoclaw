/**
 * Lightweight HTTP server for receiving Telegram webhook POSTs.
 *
 * Routes:
 *   POST /webhook  — delegated to the provided handler
 *   GET  /health   — returns 200 "ok"
 *   *              — returns 404
 *
 * Security:
 *   - POST /webhook only accepts requests from Telegram's published
 *     IP ranges (validated via Cf-Connecting-Ip header from Cloudflare Tunnel)
 *   - Request body capped at 1 MB to prevent memory exhaustion
 *   - Request/header timeouts to mitigate Slowloris
 */

import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';

import { logger } from './logger.js';

export type WebhookHandler = (
  req: IncomingMessage,
  res: ServerResponse,
) => void;

export interface WebhookServerOptions {
  port: number;
  handler: WebhookHandler;
  host?: string;
  /** Set to false to disable Telegram IP validation (e.g. in tests). */
  validateIp?: boolean;
}

export interface WebhookServer {
  port: number;
  stop: () => Promise<void>;
}

/** Max request body size (1 MB — Telegram updates are typically <100 KB). */
const MAX_BODY_BYTES = 1_048_576;

/**
 * Telegram's published IP ranges for webhook requests.
 * https://core.telegram.org/bots/webhooks#the-short-version
 */
const TELEGRAM_CIDRS = [
  { base: ipToInt('149.154.160.0'), mask: 20 },
  { base: ipToInt('91.108.4.0'), mask: 22 },
  { base: ipToInt('91.108.8.0'), mask: 22 },
  { base: ipToInt('91.108.12.0'), mask: 22 },
  { base: ipToInt('91.108.16.0'), mask: 22 },
  { base: ipToInt('91.108.20.0'), mask: 22 },
];

function ipToInt(ip: string): number {
  const [a = '0', b = '0', c = '0', d = '0'] = ip.split('.');
  return (
    ((parseInt(a, 10) << 24) |
      (parseInt(b, 10) << 16) |
      (parseInt(c, 10) << 8) |
      parseInt(d, 10)) >>>
    0
  );
}

export function isTelegramIp(ip: string): boolean {
  // Strip IPv4-mapped IPv6 prefix (::ffff:1.2.3.4 → 1.2.3.4)
  const normalized = ip.startsWith('::ffff:') ? ip.slice(7) : ip;

  // Reject pure IPv6 — Telegram's webhook ranges are IPv4-only
  if (normalized.includes(':')) return false;

  const addr = ipToInt(normalized);
  return TELEGRAM_CIDRS.some(({ base, mask }) => {
    const maskBits = (~0 << (32 - mask)) >>> 0;
    return (addr & maskBits) === (base & maskBits);
  });
}

export function startWebhookServer(
  opts: WebhookServerOptions,
): Promise<WebhookServer> {
  const host = opts.host ?? '127.0.0.1';
  const shouldValidateIp = opts.validateIp !== false;

  return new Promise((resolve, reject) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const { method, url } = req;

      if (method === 'GET' && url === '/health') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('ok');
        return;
      }

      if (method === 'POST' && url === '/webhook') {
        if (shouldValidateIp) {
          const cfIp = req.headers['cf-connecting-ip'];
          // Take only the first IP if multiple headers were coalesced
          const clientIp =
            typeof cfIp === 'string' ? (cfIp.split(',')[0] ?? '').trim() : '';
          if (!clientIp || !isTelegramIp(clientIp)) {
            logger.warn({ clientIp }, 'Webhook request from non-Telegram IP');
            res.writeHead(403, { 'content-type': 'text/plain' });
            res.end('Forbidden');
            return;
          }
        }

        // Reject non-JSON content types before they reach grammY
        const contentType = req.headers['content-type'] ?? '';
        if (contentType && !contentType.includes('application/json')) {
          res.writeHead(415, { 'content-type': 'text/plain' });
          res.end('Unsupported Media Type');
          return;
        }

        // Enforce body size limit
        let bodyBytes = 0;
        req.on('data', (chunk: Buffer) => {
          bodyBytes += chunk.length;
          if (bodyBytes > MAX_BODY_BYTES) {
            req.destroy();
            res.writeHead(413, { 'content-type': 'text/plain' });
            res.end('Payload Too Large');
          }
        });

        opts.handler(req, res);
        return;
      }

      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('Not Found');
    });

    // Mitigate Slowloris: timeout slow headers and idle connections
    server.headersTimeout = 15_000;
    server.requestTimeout = 30_000;

    server.listen(opts.port, host, () => {
      const address = server.address();
      const boundPort =
        address !== null && typeof address === 'object'
          ? address.port
          : opts.port;

      logger.info({ port: boundPort, host }, 'Telegram webhook server started');

      const stop = (): Promise<void> =>
        new Promise((res, rej) => {
          server.closeAllConnections();
          server.close((err) => {
            if (
              err !== undefined &&
              (err as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING'
            ) {
              rej(err);
            } else {
              res();
            }
          });
        });

      resolve({ port: boundPort, stop });
    });

    server.on('error', reject);
  });
}
