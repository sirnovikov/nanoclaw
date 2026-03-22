import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
import {
  checkWithApproval,
  handleProxyPermissionResponse,
  type PermissionApprovalCallbacks,
} from '../src/credential-proxy.js';

beforeEach(() => {
  _initTestDatabase();
  vi.clearAllMocks();
  // Default: no matching rule (falls through to Telegram)
  vi.mocked(checkPermissionRule).mockReturnValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('proxy permission integration', () => {
  it('matching allow rule returns allow without calling sendPermissionRequest', async () => {
    vi.mocked(checkPermissionRule).mockReturnValue('allow');

    const sendPermissionRequest = vi.fn().mockResolvedValue(1);
    const callbacks: PermissionApprovalCallbacks = {
      resolveGroup: vi.fn().mockReturnValue({ groupFolder: 'test', chatJid: 'tg:123' }),
      sendPermissionRequest,
      onPermissionResponse: vi.fn(),
    };

    const decision = await checkWithApproval(
      'http',
      'http://example.com/test',
      'test',
      'tg:123',
      callbacks,
    );

    expect(decision).toBe('allow');
    expect(sendPermissionRequest).not.toHaveBeenCalled();
  });

  it('matching deny rule returns deny without calling sendPermissionRequest', async () => {
    vi.mocked(checkPermissionRule).mockReturnValue('deny');

    const sendPermissionRequest = vi.fn().mockResolvedValue(1);
    const callbacks: PermissionApprovalCallbacks = {
      resolveGroup: vi.fn().mockReturnValue({ groupFolder: 'test', chatJid: 'tg:123' }),
      sendPermissionRequest,
      onPermissionResponse: vi.fn(),
    };

    const decision = await checkWithApproval(
      'connect',
      'example.com:443',
      'test',
      'tg:123',
      callbacks,
    );

    expect(decision).toBe('deny');
    expect(sendPermissionRequest).not.toHaveBeenCalled();
  });

  it('no matching rule + deny tap returns deny', async () => {
    const sendPermissionRequest = vi.fn().mockImplementation(async (req) => {
      // Simulate user tapping "Deny" after a short delay
      setTimeout(() => handleProxyPermissionResponse(req.requestId, 'deny'), 20);
      return 42;
    });

    const callbacks: PermissionApprovalCallbacks = {
      resolveGroup: vi.fn().mockReturnValue({ groupFolder: 'test', chatJid: 'tg:123' }),
      sendPermissionRequest,
      onPermissionResponse: vi.fn(),
    };

    const decision = await checkWithApproval(
      'connect',
      'example.com:443',
      'test',
      'tg:123',
      callbacks,
    );

    expect(decision).toBe('deny');
    expect(sendPermissionRequest).toHaveBeenCalledOnce();
  });

  it('no matching rule + once tap returns allow without persisting rule', async () => {
    const sendPermissionRequest = vi.fn().mockImplementation(async (req) => {
      setTimeout(() => handleProxyPermissionResponse(req.requestId, 'once'), 20);
      return 42;
    });

    const callbacks: PermissionApprovalCallbacks = {
      resolveGroup: vi.fn().mockReturnValue({ groupFolder: 'test', chatJid: 'tg:123' }),
      sendPermissionRequest,
      onPermissionResponse: vi.fn(),
    };

    const decision = await checkWithApproval(
      'http',
      'http://example.com/test',
      'test',
      'tg:123',
      callbacks,
    );

    expect(decision).toBe('allow');
    expect(insertPermissionRule).not.toHaveBeenCalled();
  });

  it('always tap calls insertPermissionRule with the proposal', async () => {
    const proposal = {
      name: 'example.com HTTPS',
      patterns: ['*.example.com:443'],
      effect: 'allow' as const,
      scope: 'global' as const,
      description: 'Allow example.com HTTPS',
    };
    vi.mocked(generateRuleProposal).mockResolvedValue(proposal);

    const sendPermissionRequest = vi.fn().mockImplementation(async (req) => {
      setTimeout(() => handleProxyPermissionResponse(req.requestId, 'always'), 20);
      return 42;
    });

    const callbacks: PermissionApprovalCallbacks = {
      resolveGroup: vi.fn().mockReturnValue({ groupFolder: 'test', chatJid: 'tg:123' }),
      sendPermissionRequest,
      onPermissionResponse: vi.fn(),
    };

    const decision = await checkWithApproval(
      'connect',
      'example.com:443',
      'test',
      'tg:123',
      callbacks,
    );

    expect(decision).toBe('allow');
    expect(insertPermissionRule).toHaveBeenCalledOnce();
    expect(insertPermissionRule).toHaveBeenCalledWith(
      expect.objectContaining({
        pattern: proposal.patterns[0],
        effect: 'allow',
        egress_type: 'connect',
        source: 'telegram',
      }),
    );
  });

  it('always tap with group-scoped proposal sets group_folder', async () => {
    const proposal = {
      name: 'internal.com HTTPS',
      patterns: ['*.internal.com:443'],
      effect: 'allow' as const,
      scope: 'group' as const,
      description: 'Allow internal for this group',
    };
    vi.mocked(generateRuleProposal).mockResolvedValue(proposal);

    const sendPermissionRequest = vi.fn().mockImplementation(async (req) => {
      setTimeout(() => handleProxyPermissionResponse(req.requestId, 'always'), 20);
      return 42;
    });

    const callbacks: PermissionApprovalCallbacks = {
      resolveGroup: vi.fn().mockReturnValue({ groupFolder: 'my-group', chatJid: 'tg:123' }),
      sendPermissionRequest,
      onPermissionResponse: vi.fn(),
    };

    await checkWithApproval(
      'connect',
      'internal.com:443',
      'my-group',
      'tg:123',
      callbacks,
    );

    expect(insertPermissionRule).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: 'group',
        group_folder: 'my-group',
      }),
    );
  });

  it('once tap does not call insertPermissionRule even with proposal', async () => {
    const proposal = {
      name: 'example.com HTTPS',
      patterns: ['*.example.com:443'],
      effect: 'allow' as const,
      scope: 'global' as const,
      description: 'Allow example.com HTTPS',
    };
    vi.mocked(generateRuleProposal).mockResolvedValue(proposal);

    const sendPermissionRequest = vi.fn().mockImplementation(async (req) => {
      setTimeout(() => handleProxyPermissionResponse(req.requestId, 'once'), 20);
      return 42;
    });

    const callbacks: PermissionApprovalCallbacks = {
      resolveGroup: vi.fn().mockReturnValue({ groupFolder: 'test', chatJid: 'tg:123' }),
      sendPermissionRequest,
      onPermissionResponse: vi.fn(),
    };

    const decision = await checkWithApproval(
      'connect',
      'example.com:443',
      'test',
      'tg:123',
      callbacks,
    );

    expect(decision).toBe('allow');
    expect(insertPermissionRule).not.toHaveBeenCalled();
  });
});
