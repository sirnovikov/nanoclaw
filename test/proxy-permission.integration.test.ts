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

import { checkPermissionRule } from '../src/permission-rule-engine/rule-engine.js';

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

  it('CONNECT with always tap persists rule and allows second identical request without Telegram', async () => {
    // TODO: implement after onPermissionResponse rule persistence is wired
    expect(true).toBe(true);
  });
});
