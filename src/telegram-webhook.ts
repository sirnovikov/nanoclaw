/**
 * Lightweight HTTP server for receiving Telegram webhook POSTs.
 *
 * Routes:
 *   POST /webhook  — delegated to the provided handler
 *   GET  /health   — returns 200 "ok"
 *   *              — returns 404
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
}

export interface WebhookServer {
  port: number;
  stop: () => Promise<void>;
}

export function startWebhookServer(
  opts: WebhookServerOptions,
): Promise<WebhookServer> {
  const host = opts.host ?? '127.0.0.1';

  return new Promise((resolve, reject) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const { method, url } = req;

      if (method === 'GET' && url === '/health') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('ok');
        return;
      }

      if (method === 'POST' && url === '/webhook') {
        opts.handler(req, res);
        return;
      }

      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('Not Found');
    });

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
