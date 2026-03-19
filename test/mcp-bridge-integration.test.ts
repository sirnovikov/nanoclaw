import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Detect whether listen() works (sandboxed environments may block it)
const canListen = await new Promise<boolean>((resolve) => {
  const s = net.createServer();
  s.on('error', () => resolve(false));
  s.listen(0, '127.0.0.1', () => {
    s.close(() => resolve(true));
  });
});

vi.mock('../src/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

vi.mock('../src/permission-rule-engine/rule-engine.js', () => ({
  checkPermissionRule: vi.fn().mockReturnValue('allow'),
}));

vi.mock('../src/permission-rule-generator.js', () => ({
  generateRuleProposal: vi.fn().mockResolvedValue(null),
}));

import { createMcpBridge, type McpBridgeDeps } from '../src/mcp-bridge.js';

function makeDeps(overrides?: Partial<McpBridgeDeps>): McpBridgeDeps {
  return {
    sendPermissionRequest: vi.fn().mockResolvedValue(42),
    groupFolder: 'test-group',
    chatJid: 'tg:123',
    ...overrides,
  };
}

describe.skipIf(!canListen)('MCP bridge HTTP forwarding', () => {
  let upstreamServer: http.Server;
  let upstreamPort: number;
  let lastRequestHeaders: http.IncomingHttpHeaders;
  let lastRequestBody: string;

  beforeEach(async () => {
    lastRequestHeaders = {};
    lastRequestBody = '';

    upstreamServer = http.createServer((req, res) => {
      lastRequestHeaders = { ...req.headers };
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        lastRequestBody = Buffer.concat(chunks).toString();
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            result: { tools: [{ name: 'list_teams' }] },
          }),
        );
      });
    });

    await new Promise<void>((resolve) =>
      upstreamServer.listen(0, '127.0.0.1', resolve),
    );
    upstreamPort = (upstreamServer.address() as AddressInfo).port;
  });

  afterEach(async () => {
    await new Promise<void>((r) => upstreamServer?.close(() => r()));
    vi.restoreAllMocks();
  });

  it('forwards tools/list to upstream and returns result', async () => {
    const bridge = createMcpBridge(
      {
        name: 'test',
        url: `http://127.0.0.1:${upstreamPort}/mcp`,
      },
      makeDeps(),
    );

    const response = await bridge.handleJsonRpc({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: {},
    });

    expect(response.result).toEqual({ tools: [{ name: 'list_teams' }] });
    expect(response.error).toBeUndefined();
  });

  it('injects auth headers from config', async () => {
    const bridge = createMcpBridge(
      {
        name: 'test',
        url: `http://127.0.0.1:${upstreamPort}/mcp`,
        headers: { Authorization: 'Bearer secret-token' },
      },
      makeDeps(),
    );

    await bridge.handleJsonRpc({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: {},
    });

    expect(lastRequestHeaders.authorization).toBe('Bearer secret-token');
  });

  it('caches tools list from tools/list response', async () => {
    const bridge = createMcpBridge(
      {
        name: 'test',
        url: `http://127.0.0.1:${upstreamPort}/mcp`,
      },
      makeDeps(),
    );

    expect(bridge.toolsList).toBeNull();

    await bridge.handleJsonRpc({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: {},
    });

    expect(bridge.toolsList).toEqual([{ name: 'list_teams' }]);
  });

  it('returns error when upstream is unreachable', async () => {
    const bridge = createMcpBridge(
      {
        name: 'test',
        url: 'http://127.0.0.1:59999/mcp',
      },
      makeDeps(),
    );

    const response = await bridge.handleJsonRpc({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: {},
    });

    expect(response.error).toBeDefined();
    expect(response.error?.code).toBe(-32603);
    expect(response.error?.message).toMatch(/Upstream error:/);
  });
});
