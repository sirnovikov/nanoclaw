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

vi.mock('../src/env.js', () => ({
  readEnvFile: vi.fn(() => ({})),
}));

vi.mock('../src/db.js', () => ({
  _initTestDatabase: vi.fn(),
  insertPermissionRule: vi.fn(),
  logPermissionDecision: vi.fn(),
  getDb: vi.fn(),
}));

vi.mock('../src/permission-rule-engine/rule-engine.js', () => ({
  checkPermissionRule: vi.fn().mockReturnValue('allow'),
}));

vi.mock('../src/permission-rule-generator.js', () => ({
  generateRuleProposal: vi.fn().mockResolvedValue(null),
}));

import { createMcpBridge, type McpBridgeDeps } from '../src/mcp-bridge.js';
import { handleProxyPermissionResponse } from '../src/credential-proxy.js';
import { checkPermissionRule } from '../src/permission-rule-engine/rule-engine.js';
import { insertPermissionRule } from '../src/db.js';

function makeDeps(overrides?: Partial<McpBridgeDeps>): McpBridgeDeps {
  return {
    sendPermissionRequest: vi.fn().mockResolvedValue(42),
    getDecisionHistory: vi.fn().mockReturnValue([]),
    groupFolder: 'test-group',
    chatJid: 'tg:123',
    ...overrides,
  };
}

describe.skipIf(!canListen)('MCP bridge HTTP forwarding', () => {
  let upstreamServer: http.Server;
  let upstreamPort: number;
  let lastRequestHeaders: http.IncomingHttpHeaders;

  beforeEach(async () => {
    vi.clearAllMocks();
    lastRequestHeaders = {};

    upstreamServer = http.createServer((req, res) => {
      lastRequestHeaders = { ...req.headers };
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
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
      { name: 'test', url: `http://127.0.0.1:${upstreamPort}/mcp` },
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
      { name: 'test', url: `http://127.0.0.1:${upstreamPort}/mcp` },
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
      { name: 'test', url: 'http://127.0.0.1:59999/mcp' },
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

/**
 * Permission approval flow — deny path.
 * No upstream server needed (denied requests never forward).
 */
describe('Permission approval deny flow (no server needed)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (checkPermissionRule as ReturnType<typeof vi.fn>).mockReturnValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('deny via unified registry → returns JSON-RPC error', async () => {
    const deps = makeDeps();
    // URL doesn't matter — denied requests never reach upstream
    const bridge = createMcpBridge(
      { name: 'vercel', url: 'http://127.0.0.1:1/mcp' },
      deps,
    );

    (deps.sendPermissionRequest as ReturnType<typeof vi.fn>).mockImplementation(async (req) => {
      // Simulate Telegram deny button tap
      setTimeout(() => handleProxyPermissionResponse(req.requestId, 'deny'), 10);
      return 42;
    });

    const response = await bridge.handleJsonRpc({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'deploy', arguments: {} },
    });

    expect(response.error).toBeDefined();
    expect(response.error?.message).toContain('denied');
    expect(insertPermissionRule).not.toHaveBeenCalled();
  });

  it('sendPermissionRequest includes toolInput for tools/call', async () => {
    const deps = makeDeps();
    const bridge = createMcpBridge(
      { name: 'vercel', url: 'http://127.0.0.1:1/mcp' },
      deps,
    );

    (deps.sendPermissionRequest as ReturnType<typeof vi.fn>).mockImplementation(async (req) => {
      setTimeout(() => handleProxyPermissionResponse(req.requestId, 'deny'), 10);
      return 42;
    });

    await bridge.handleJsonRpc({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'deploy', arguments: { project: 'my-app', env: 'prod' } },
    });

    expect(deps.sendPermissionRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        toolInput: { project: 'my-app', env: 'prod' },
      }),
    );
  });
});

/**
 * Permission approval flow — approve paths.
 * Needs an upstream HTTP server to verify forwarding after approval.
 */
describe.skipIf(!canListen)('Permission approval flow (bridge → Telegram sim → upstream)', () => {
  let upstreamServer: http.Server;
  let upstreamPort: number;

  beforeEach(async () => {
    vi.clearAllMocks();
    (checkPermissionRule as ReturnType<typeof vi.fn>).mockReturnValue(undefined);

    upstreamServer = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString();
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: JSON.parse(body).id,
            result: { content: [{ type: 'text', text: 'deployed!' }] },
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

  it('approve "once" → forwards to upstream and returns result', async () => {
    const deps = makeDeps();
    const bridge = createMcpBridge(
      { name: 'vercel', url: `http://127.0.0.1:${upstreamPort}/mcp` },
      deps,
    );

    (deps.sendPermissionRequest as ReturnType<typeof vi.fn>).mockImplementation(async (req) => {
      setTimeout(() => handleProxyPermissionResponse(req.requestId, 'once'), 10);
      return 42;
    });

    const response = await bridge.handleJsonRpc({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'deploy', arguments: { project: 'my-app' } },
    });

    expect(response.error).toBeUndefined();
    expect(response.result).toEqual({
      content: [{ type: 'text', text: 'deployed!' }],
    });
    expect(insertPermissionRule).not.toHaveBeenCalled();
  });

  it('approve "always" → forwards + persists rule to DB', async () => {
    const { generateRuleProposal } = await import(
      '../src/permission-rule-generator.js'
    );
    (generateRuleProposal as ReturnType<typeof vi.fn>).mockResolvedValue({
      name: 'Allow Vercel deploy',
      patterns: ['mcp__vercel__deploy'],
      effect: 'allow',
      scope: 'global',
      description: 'Allow deploying via Vercel MCP',
    });

    const deps = makeDeps();
    const bridge = createMcpBridge(
      { name: 'vercel', url: `http://127.0.0.1:${upstreamPort}/mcp` },
      deps,
    );

    (deps.sendPermissionRequest as ReturnType<typeof vi.fn>).mockImplementation(async (req) => {
      setTimeout(
        () => handleProxyPermissionResponse(req.requestId, 'always'),
        10,
      );
      return 42;
    });

    const response = await bridge.handleJsonRpc({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'deploy', arguments: { project: 'my-app' } },
    });

    expect(response.error).toBeUndefined();
    expect(insertPermissionRule).toHaveBeenCalledTimes(1);
    const rule = (insertPermissionRule as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(rule?.pattern).toBe('mcp__vercel__deploy');
    expect(rule?.effect).toBe('allow');
    expect(rule?.source).toBe('telegram');
  });
});
