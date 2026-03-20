import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

vi.mock('./permission-rule-engine/rule-engine.js', () => ({
  checkPermissionRule: vi.fn().mockReturnValue(undefined),
}));

vi.mock('./permission-rule-generator.js', () => ({
  generateRuleProposal: vi.fn().mockResolvedValue(null),
}));

import { checkPermissionRule } from './permission-rule-engine/rule-engine.js';
import {
  createMcpBridge,
  parseUpstreamBody,
  type McpBridgeDeps,
  type BridgeConfig,
} from './mcp-bridge.js';

function makeDeps(overrides?: Partial<McpBridgeDeps>): McpBridgeDeps {
  return {
    sendPermissionRequest: vi.fn().mockResolvedValue(42),
    getDecisionHistory: vi.fn().mockReturnValue([]),
    groupFolder: 'test-group',
    chatJid: 'tg:123',
    ...overrides,
  };
}

const testConfig: BridgeConfig = {
  name: 'vercel',
  url: 'https://mcp.vercel.com',
  headers: { Authorization: 'Bearer test-token' },
};

describe('MCP bridge permission gating', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('auto-allows tools/list without permission check', async () => {
    const bridge = createMcpBridge(testConfig, makeDeps());
    await bridge.handleJsonRpc({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: {},
    });
    expect(checkPermissionRule).not.toHaveBeenCalled();
  });

  it('auto-allows initialize without permission check', async () => {
    const bridge = createMcpBridge(testConfig, makeDeps());
    await bridge.handleJsonRpc({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {},
    });
    expect(checkPermissionRule).not.toHaveBeenCalled();
  });

  it('checks permission for tools/call', async () => {
    vi.mocked(checkPermissionRule).mockReturnValue('allow');
    const bridge = createMcpBridge(testConfig, makeDeps());
    await bridge.handleJsonRpc({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'list_teams', arguments: {} },
    });
    expect(checkPermissionRule).toHaveBeenCalledWith(
      'mcp',
      'mcp__vercel__list_teams',
      'test-group',
    );
  });

  it('checks permission for resources/read', async () => {
    vi.mocked(checkPermissionRule).mockReturnValue('allow');
    const bridge = createMcpBridge(testConfig, makeDeps());
    await bridge.handleJsonRpc({
      jsonrpc: '2.0',
      id: 1,
      method: 'resources/read',
      params: { uri: 'file:///config.json' },
    });
    expect(checkPermissionRule).toHaveBeenCalled();
  });

  it('returns JSON-RPC error when permission denied by rule', async () => {
    vi.mocked(checkPermissionRule).mockReturnValue('deny');
    const bridge = createMcpBridge(testConfig, makeDeps());
    const response = await bridge.handleJsonRpc({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'deploy', arguments: {} },
    });
    expect(response).toEqual({
      jsonrpc: '2.0',
      id: 1,
      error: { code: -32600, message: expect.stringContaining('denied') },
    });
  });

  it('sends Telegram approval when no rule matches', async () => {
    vi.mocked(checkPermissionRule).mockReturnValue(undefined);
    const deps = makeDeps();
    const bridge = createMcpBridge(testConfig, deps);
    // Simulate approval: capture the requestId and resolve it
    vi.mocked(deps.sendPermissionRequest).mockImplementation(async (req) => {
      setTimeout(() => bridge.resolvePermission(req.requestId, 'once'), 10);
      return 42;
    });
    await bridge.handleJsonRpc({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'list_teams', arguments: {} },
    });
    expect(deps.sendPermissionRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        egressType: 'mcp',
        subject: 'mcp__vercel__list_teams',
      }),
    );
  });

  it('constructs MCP tool subject as mcp__{server}__{tool}', async () => {
    vi.mocked(checkPermissionRule).mockReturnValue('allow');
    const bridge = createMcpBridge(
      { ...testConfig, name: 'github' },
      makeDeps(),
    );
    await bridge.handleJsonRpc({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'create_issue', arguments: { title: 'Bug' } },
    });
    expect(checkPermissionRule).toHaveBeenCalledWith(
      'mcp',
      'mcp__github__create_issue',
      'test-group',
    );
  });

  it('returns deny on permission timeout', async () => {
    vi.useFakeTimers();
    vi.mocked(checkPermissionRule).mockReturnValue(undefined);
    const deps = makeDeps();
    vi.mocked(deps.sendPermissionRequest).mockResolvedValue(42);
    const bridge = createMcpBridge(testConfig, deps);

    const resultPromise = bridge.handleJsonRpc({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'deploy', arguments: {} },
    });

    await vi.advanceTimersByTimeAsync(30 * 60 * 1000 + 1);
    const response = await resultPromise;
    expect(response).not.toBeNull();
    expect(response?.error?.message).toContain('denied');
    vi.useRealTimers();
  });

  it('returns deny when sendPermissionRequest throws', async () => {
    vi.mocked(checkPermissionRule).mockReturnValue(undefined);
    const deps = makeDeps();
    vi.mocked(deps.sendPermissionRequest).mockRejectedValue(
      new Error('Telegram API error'),
    );
    const bridge = createMcpBridge(testConfig, deps);
    const response = await bridge.handleJsonRpc({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'deploy', arguments: {} },
    });
    expect(response).not.toBeNull();
    expect(response?.error?.message).toContain('denied');
  });

  it('forwards unknown methods without permission check', async () => {
    const bridge = createMcpBridge(testConfig, makeDeps());
    await bridge.handleJsonRpc({
      jsonrpc: '2.0',
      id: 1,
      method: 'custom/method',
      params: {},
    });
    expect(checkPermissionRule).not.toHaveBeenCalled();
  });

  it('returns null for notifications (no id)', async () => {
    const bridge = createMcpBridge(testConfig, makeDeps());
    const response = await bridge.handleJsonRpc({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
      params: {},
    });
    expect(response).toBeNull();
  });

  it('returns null for notification in auto-allow list', async () => {
    const bridge = createMcpBridge(testConfig, makeDeps());
    const response = await bridge.handleJsonRpc({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    });
    expect(response).toBeNull();
  });
});

describe('parseUpstreamBody', () => {
  it('parses plain JSON response', () => {
    const body = '{"jsonrpc":"2.0","id":1,"result":{"tools":[]}}';
    const result = parseUpstreamBody(body);
    expect(result).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: { tools: [] },
    });
  });

  it('parses SSE response (event: message + data: line)', () => {
    const body =
      'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"tools":[]}}\n\n';
    const result = parseUpstreamBody(body);
    expect(result).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: { tools: [] },
    });
  });

  it('parses SSE with multiple events (takes last data line)', () => {
    const body = [
      'event: message',
      'data: {"jsonrpc":"2.0","id":1,"result":{"partial":true}}',
      '',
      'event: message',
      'data: {"jsonrpc":"2.0","id":1,"result":{"tools":["final"]}}',
      '',
    ].join('\n');
    const result = parseUpstreamBody(body);
    // Takes last data line (reverse iteration)
    expect(result).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: { tools: ['final'] },
    });
  });

  it('returns null for empty body', () => {
    expect(parseUpstreamBody('')).toBeNull();
    expect(parseUpstreamBody('  \n  ')).toBeNull();
  });

  it('returns null for non-JSON non-SSE body', () => {
    expect(parseUpstreamBody('Not Acceptable')).toBeNull();
  });

  it('handles SSE with malformed data lines gracefully', () => {
    const body = 'event: message\ndata: {broken json\n\n';
    expect(parseUpstreamBody(body)).toBeNull();
  });

  it('parses Vercel-style SSE response exactly', () => {
    // Real Vercel MCP response format observed via curl
    const body =
      'event: message\ndata: {"result":{"protocolVersion":"2024-11-05","capabilities":{"tools":{}},"serverInfo":{"name":"vercel","version":"1.0.0"}},"jsonrpc":"2.0","id":1}\n\n';
    const result = parseUpstreamBody(body);
    expect(result).not.toBeNull();
    expect(result?.jsonrpc).toBe('2.0');
    expect(result?.id).toBe(1);
    const res = result?.result as { serverInfo: { name: string } };
    expect(res.serverInfo.name).toBe('vercel');
  });
});
