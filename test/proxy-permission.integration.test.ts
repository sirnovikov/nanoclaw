import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import http from 'http';
import net from 'net';
import { _initTestDatabase } from '../src/db.js';

// Mock Anthropic SDK (Haiku) — vi.mock is hoisted; factory must be self-contained
vi.mock('@anthropic-ai/sdk', () => {
  const mockCreate = vi.fn();
  function MockAnthropic() {
    return { messages: { create: mockCreate } };
  }
  (MockAnthropic as any).__mockCreate = mockCreate;
  return { default: MockAnthropic };
});

// Mock the rule engine so we can control outcomes in each test
vi.mock('../src/permission-rule-engine/rule-engine.js', () => ({
  checkPermissionRule: vi.fn().mockReturnValue(undefined), // no match by default
}));

// Mock the rule generator so Haiku is never called in integration tests
vi.mock('../src/permission-rule-generator.js', () => ({
  generateRuleProposal: vi.fn().mockResolvedValue(null),
}));

// Spy on insertPermissionRule so we can assert rule persistence
vi.mock('../src/db.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/db.js')>();
  return { ...actual, insertPermissionRule: vi.fn() };
});

import { checkPermissionRule } from '../src/permission-rule-engine/rule-engine.js';
import { generateRuleProposal } from '../src/permission-rule-generator.js';
import { insertPermissionRule } from '../src/db.js';
import { handleProxyPermissionResponse } from '../src/credential-proxy.js';

async function startTestProxy(
  approvalCallbacks?: Parameters<
    typeof import('../src/credential-proxy.js').startCredentialProxy
  >[2],
) {
  const { startCredentialProxy } = await import('../src/credential-proxy.js');
  const server = await startCredentialProxy(0, '127.0.0.1', approvalCallbacks);
  const port = (server.address() as net.AddressInfo).port;
  return { server, port };
}

beforeEach(() => {
  _initTestDatabase();
  vi.clearAllMocks();
  // Default: no matching rule (falls through to Telegram)
  vi.mocked(checkPermissionRule).mockReturnValue(undefined);
});

afterEach(() => {
  // servers closed inside each test
});

describe('proxy permission integration', () => {
  it('HTTP request with matching allow rule is forwarded without calling sendPermissionRequest', async () => {
    // Simulate rule engine returning 'allow' directly
    vi.mocked(checkPermissionRule).mockReturnValue('allow');

    const sendPermissionRequest = vi.fn().mockResolvedValue(1);
    const resolveGroup = vi.fn().mockReturnValue({ groupFolder: 'test', chatJid: 'tg:123' });

    const { server, port } = await startTestProxy({
      resolveGroup,
      sendPermissionRequest,
      onPermissionResponse: vi.fn(),
    });

    await new Promise<void>((resolve) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          method: 'GET',
          path: '/test',
          headers: { host: 'example.com' },
        },
        (res) => {
          res.resume();
          resolve();
        },
      );
      req.on('error', () => resolve());
      req.end();
    });

    expect(sendPermissionRequest).not.toHaveBeenCalled();
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('CONNECT request with deny tap returns 403', async () => {
    const { resolvePermission } = await import('../src/credential-proxy.js');

    const sendPermissionRequest = vi.fn().mockImplementation(async (req) => {
      // Simulate user tapping "Deny" after a short delay
      setTimeout(() => resolvePermission(req.requestId, 'deny'), 20);
      return 42;
    });

    const { server, port } = await startTestProxy({
      resolveGroup: vi.fn().mockReturnValue({ groupFolder: 'test', chatJid: 'tg:123' }),
      sendPermissionRequest,
      onPermissionResponse: vi.fn(),
    });

    const responseCode = await new Promise<number>((resolve) => {
      const socket = net.connect(port, '127.0.0.1', () => {
        socket.write('CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n');
      });
      socket.on('data', (data) => {
        const status = data.toString().match(/HTTP\/\d\.\d (\d+)/)?.[1];
        resolve(parseInt(status ?? '0', 10));
        socket.destroy();
      });
      socket.on('error', () => resolve(0));
    });

    expect(responseCode).toBe(403);
    await new Promise<void>((r) => server.close(() => r()));
  }, 10_000);

  it('direct API request (path-only URL) is never permission-gated even with approvalCallbacks', async () => {
    // Regression: proxy was treating direct ANTHROPIC_BASE_URL calls as external
    // traffic because host.docker.internal != api.anthropic.com. Direct requests
    // have a path-only URL (e.g. /v1/messages) and must always pass through.
    const sendPermissionRequest = vi.fn().mockResolvedValue(1);
    const resolveGroup = vi.fn().mockReturnValue({ groupFolder: 'test', chatJid: 'tg:123' });

    const { server, port } = await startTestProxy({
      resolveGroup,
      sendPermissionRequest,
      onPermissionResponse: vi.fn(),
    });

    const res = await new Promise<{ status: number }>((resolve) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          method: 'POST',
          // Path-only URL — this is how ANTHROPIC_BASE_URL traffic arrives
          path: '/v1/messages',
          headers: { host: 'host.docker.internal:3001', 'content-type': 'application/json' },
        },
        (r) => {
          r.resume();
          resolve({ status: r.statusCode ?? 0 });
        },
      );
      req.on('error', () => resolve({ status: 0 }));
      req.end('{}');
    });

    // Must NOT have been permission-gated (no Telegram message)
    expect(sendPermissionRequest).not.toHaveBeenCalled();
    // 502 is fine — upstream isn't real in tests. What matters is it wasn't 403.
    expect(res.status).not.toBe(403);
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('HTTP proxy request with no matching rule and deny tap returns 403', async () => {
    const { resolvePermission } = await import('../src/credential-proxy.js');

    const sendPermissionRequest = vi.fn().mockImplementation(async (req) => {
      setTimeout(() => resolvePermission(req.requestId, 'deny'), 20);
      return 42;
    });

    const { server, port } = await startTestProxy({
      resolveGroup: vi.fn().mockReturnValue({ groupFolder: 'test', chatJid: 'tg:123' }),
      sendPermissionRequest,
      onPermissionResponse: vi.fn(),
    });

    // HTTP proxy requests use an absolute URL (e.g. http://example.com/test),
    // not a path-only URL — that distinction is how the proxy tells them apart
    // from direct Anthropic API calls.
    const responseCode = await new Promise<number>((resolve) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          method: 'GET',
          path: 'http://example.com/test', // absolute URL → HTTP proxy mode
          headers: { host: 'example.com' },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on('error', () => resolve(0));
      req.end();
    });

    expect(responseCode).toBe(403);
    expect(sendPermissionRequest).toHaveBeenCalledOnce();
    await new Promise<void>((r) => server.close(() => r()));
  }, 10_000);

  it('CONNECT with always tap calls insertPermissionRule with the proposal', async () => {
    const proposal = {
      pattern: '*.example.com:443',
      scope: 'global' as const,
      description: 'Allow example.com HTTPS',
    };
    vi.mocked(generateRuleProposal).mockResolvedValue(proposal);

    let capturedRequestId = '';
    const sendPermissionRequest = vi.fn().mockImplementation(async (req) => {
      capturedRequestId = req.requestId;
      // Don't resolve — handleProxyPermissionResponse will do it
      return 42;
    });

    const { server, port } = await startTestProxy({
      resolveGroup: vi.fn().mockReturnValue({ groupFolder: 'test', chatJid: 'tg:123' }),
      sendPermissionRequest,
      onPermissionResponse: vi.fn(),
    });

    // Send CONNECT — it will block waiting for a decision
    const connectPromise = new Promise<number>((resolve) => {
      const socket = net.connect(port, '127.0.0.1', () => {
        socket.write('CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n');
      });
      socket.on('data', (data) => {
        const status = data.toString().match(/HTTP\/\d\.\d (\d+)/)?.[1];
        resolve(parseInt(status ?? '0', 10));
        socket.destroy();
      });
      socket.on('error', () => resolve(0));
    });

    // Wait for sendPermissionRequest to be called (requestId populated)
    await vi.waitFor(() => expect(capturedRequestId).not.toBe(''));

    // Simulate user tapping "Always"
    handleProxyPermissionResponse(capturedRequestId, 'always');

    await connectPromise;

    expect(insertPermissionRule).toHaveBeenCalledOnce();
    expect(insertPermissionRule).toHaveBeenCalledWith(
      expect.objectContaining({
        pattern: proposal.pattern,
        effect: 'allow',
        egress_type: 'connect',
        source: 'telegram',
      }),
    );

    await new Promise<void>((r) => server.close(() => r()));
  }, 10_000);

  it('CONNECT with once tap does not call insertPermissionRule', async () => {
    const proposal = {
      pattern: '*.example.com:443',
      scope: 'global' as const,
      description: 'Allow example.com HTTPS',
    };
    vi.mocked(generateRuleProposal).mockResolvedValue(proposal);

    let capturedRequestId = '';
    const sendPermissionRequest = vi.fn().mockImplementation(async (req) => {
      capturedRequestId = req.requestId;
      return 42;
    });

    const { server, port } = await startTestProxy({
      resolveGroup: vi.fn().mockReturnValue({ groupFolder: 'test', chatJid: 'tg:123' }),
      sendPermissionRequest,
      onPermissionResponse: vi.fn(),
    });

    const connectPromise = new Promise<number>((resolve) => {
      const socket = net.connect(port, '127.0.0.1', () => {
        socket.write('CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n');
      });
      socket.on('data', (data) => {
        const status = data.toString().match(/HTTP\/\d\.\d (\d+)/)?.[1];
        resolve(parseInt(status ?? '0', 10));
        socket.destroy();
      });
      socket.on('error', () => resolve(0));
    });

    await vi.waitFor(() => expect(capturedRequestId).not.toBe(''));

    handleProxyPermissionResponse(capturedRequestId, 'once');

    await connectPromise;

    expect(insertPermissionRule).not.toHaveBeenCalled();
    await new Promise<void>((r) => server.close(() => r()));
  }, 10_000);

  it('CONNECT with allow rule bypasses sendPermissionRequest', async () => {
    vi.mocked(checkPermissionRule).mockReturnValue('allow');

    const sendPermissionRequest = vi.fn().mockResolvedValue(1);

    const { server, port } = await startTestProxy({
      resolveGroup: vi.fn().mockReturnValue({ groupFolder: 'test', chatJid: 'tg:123' }),
      sendPermissionRequest,
      onPermissionResponse: vi.fn(),
    });

    await new Promise<void>((resolve) => {
      const socket = net.connect(port, '127.0.0.1', () => {
        socket.write('CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n');
      });
      socket.on('data', () => {
        socket.destroy();
        resolve();
      });
      socket.on('error', () => resolve());
    });

    expect(sendPermissionRequest).not.toHaveBeenCalled();
    await new Promise<void>((r) => server.close(() => r()));
  });
});
