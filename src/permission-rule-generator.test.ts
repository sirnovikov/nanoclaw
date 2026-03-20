import { beforeEach, describe, expect, it, vi } from 'vitest';

// Must mock before importing the module under test
const mockCreate = vi.fn();

vi.mock('@anthropic-ai/sdk', () => {
  function MockAnthropic() {
    return { messages: { create: mockCreate } };
  }
  return { default: MockAnthropic };
});

import {
  buildPrompt,
  generateRuleProposal,
  htmlEscape,
  validateProposal,
} from './permission-rule-generator.js';

function getMockCreate(): ReturnType<typeof vi.fn> {
  return mockCreate;
}

function makeToolUseResponse(overrides: Record<string, unknown> = {}) {
  return {
    content: [
      {
        type: 'tool_use',
        id: 'toolu_test',
        name: 'propose_rule',
        input: {
          name: 'Allow OpenAI API',
          patterns: ['https://api.openai.com/*'],
          effect: 'allow',
          scope: 'global',
          description: 'Allow requests to the OpenAI API.',
          ...overrides,
        },
      },
    ],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('htmlEscape', () => {
  it('escapes all five special HTML characters', () => {
    expect(htmlEscape('<script>&"\'</script>')).toBe(
      '&lt;script&gt;&amp;&quot;&#39;&lt;/script&gt;',
    );
  });

  it('leaves normal URLs unchanged', () => {
    expect(htmlEscape('https://api.openai.com/v1/chat')).toBe(
      'https://api.openai.com/v1/chat',
    );
  });
});

describe('buildPrompt', () => {
  it('contains <request> delimiters wrapping the HTML-escaped subject', () => {
    const subject = 'https://example.com/<path>';
    const prompt = buildPrompt('http', subject);

    expect(prompt).toContain('<request>');
    expect(prompt).toContain('</request>');
    expect(prompt).toContain('https://example.com/&lt;path&gt;');
    const requestBlock = prompt.match(/<request>([\s\S]*?)<\/request>/)?.[1];
    expect(requestBlock).toBeDefined();
    expect(requestBlock).not.toContain('<path>');
  });

  it('includes the egress_type in the prompt', () => {
    const prompt = buildPrompt('connect', 'api.github.com:443');
    expect(prompt).toContain('connect');
  });

  it('includes tools list when provided for MCP egress', () => {
    const toolsList = [
      { name: 'list_teams' },
      { name: 'deploy' },
      { name: 'delete_project' },
    ];
    const prompt = buildPrompt('mcp', 'mcp__vercel__list_teams', toolsList);
    expect(prompt).toContain('Available tools on this MCP server:');
    expect(prompt).toContain('- list_teams');
    expect(prompt).toContain('- deploy');
    expect(prompt).toContain('- delete_project');
  });

  it('omits tools section when toolsList is null', () => {
    const prompt = buildPrompt('mcp', 'mcp__vercel__list_teams', null);
    expect(prompt).not.toContain('Available tools on this MCP server:');
  });

  it('omits tools section when toolsList is empty', () => {
    const prompt = buildPrompt('mcp', 'mcp__vercel__list_teams', []);
    expect(prompt).not.toContain('Available tools on this MCP server:');
  });
});

describe('validateProposal', () => {
  it('accepts a valid http proposal', () => {
    const result = validateProposal(
      {
        name: 'Allow OpenAI API',
        patterns: ['https://api.openai.com/*'],
        effect: 'allow',
        scope: 'global',
        description: 'Allow requests to the OpenAI API.',
      },
      'http',
    );
    expect(result).not.toBeNull();
    expect(result?.name).toBe('Allow OpenAI API');
  });

  it('rejects name > 40 chars', () => {
    expect(
      validateProposal(
        {
          name: 'A'.repeat(41),
          patterns: ['https://api.openai.com/*'],
          effect: 'allow',
          scope: 'global',
          description: 'desc',
        },
        'http',
      ),
    ).toBeNull();
  });

  it('rejects bare * pattern', () => {
    expect(
      validateProposal(
        {
          name: 'Allow all',
          patterns: ['*'],
          effect: 'allow',
          scope: 'global',
          description: 'desc',
        },
        'http',
      ),
    ).toBeNull();
  });

  it('rejects ** pattern', () => {
    expect(
      validateProposal(
        {
          name: 'Allow all',
          patterns: ['**'],
          effect: 'allow',
          scope: 'global',
          description: 'desc',
        },
        'http',
      ),
    ).toBeNull();
  });

  it('rejects *:* pattern', () => {
    expect(
      validateProposal(
        {
          name: 'Allow all',
          patterns: ['*:*'],
          effect: 'allow',
          scope: 'global',
          description: 'desc',
        },
        'connect',
      ),
    ).toBeNull();
  });

  it('rejects *:443 pattern', () => {
    expect(
      validateProposal(
        {
          name: 'Allow all',
          patterns: ['*:443'],
          effect: 'allow',
          scope: 'global',
          description: 'desc',
        },
        'connect',
      ),
    ).toBeNull();
  });

  it('rejects invalid scope', () => {
    expect(
      validateProposal(
        {
          name: 'Allow X',
          patterns: ['https://example.com/*'],
          effect: 'allow',
          scope: 'team',
          description: 'desc',
        },
        'http',
      ),
    ).toBeNull();
  });

  it('rejects connect pattern without colon', () => {
    expect(
      validateProposal(
        {
          name: 'Allow GitHub',
          patterns: ['*.github.com'],
          effect: 'allow',
          scope: 'global',
          description: 'desc',
        },
        'connect',
      ),
    ).toBeNull();
  });

  it('accepts connect pattern with colon', () => {
    expect(
      validateProposal(
        {
          name: 'Allow GitHub',
          patterns: ['*.github.com:443'],
          effect: 'allow',
          scope: 'global',
          description: 'desc',
        },
        'connect',
      ),
    ).not.toBeNull();
  });

  it('rejects mcp pattern not starting with mcp__', () => {
    expect(
      validateProposal(
        {
          name: 'Allow tool',
          patterns: ['nanoclaw__send_message'],
          effect: 'allow',
          scope: 'group',
          description: 'desc',
        },
        'mcp',
      ),
    ).toBeNull();
  });

  it('accepts mcp pattern starting with mcp__', () => {
    expect(
      validateProposal(
        {
          name: 'Allow send',
          patterns: ['mcp__nanoclaw__send_message'],
          effect: 'allow',
          scope: 'group',
          description: 'desc',
        },
        'mcp',
      ),
    ).not.toBeNull();
  });

  it('rejects non-object input', () => {
    expect(validateProposal('string', 'http')).toBeNull();
    expect(validateProposal(null, 'http')).toBeNull();
    expect(validateProposal(42, 'http')).toBeNull();
  });

  it('rejects proposal with missing fields', () => {
    expect(
      validateProposal(
        { name: 'Allow X', patterns: ['https://example.com/*'] },
        'http',
      ),
    ).toBeNull();
  });

  it('rejects empty string fields', () => {
    expect(
      validateProposal(
        {
          name: '',
          patterns: ['https://x.com/*'],
          effect: 'allow',
          scope: 'global',
          description: 'desc',
        },
        'http',
      ),
    ).toBeNull();
  });

  it('rejects pattern > 200 chars', () => {
    expect(
      validateProposal(
        {
          name: 'Long',
          patterns: ['x'.repeat(201)],
          effect: 'allow',
          scope: 'global',
          description: 'desc',
        },
        'http',
      ),
    ).toBeNull();
  });
});

describe('generateRuleProposal (mocked)', () => {
  it('returns RuleProposal from tool_use response', async () => {
    getMockCreate().mockResolvedValueOnce(makeToolUseResponse());

    const result = await generateRuleProposal(
      'http',
      'https://api.openai.com/v1/chat',
    );

    expect(result).not.toBeNull();
    expect(result?.name).toBe('Allow OpenAI API');
    expect(result?.patterns).toEqual(['https://api.openai.com/*']);
    expect(result?.effect).toBe('allow');
    expect(result?.scope).toBe('global');
  });

  it('sends tool_choice forcing propose_rule tool', async () => {
    getMockCreate().mockResolvedValueOnce(makeToolUseResponse());

    await generateRuleProposal('mcp', 'mcp__vercel__list_teams');

    const callArgs = getMockCreate().mock.calls[0]?.[0];
    expect(callArgs.tools).toHaveLength(1);
    expect(callArgs.tools[0].name).toBe('propose_rule');
    expect(callArgs.tool_choice).toEqual({
      type: 'tool',
      name: 'propose_rule',
    });
  });

  it('passes HTML-escaped subject inside <request> delimiters', async () => {
    getMockCreate().mockResolvedValueOnce(makeToolUseResponse());

    await generateRuleProposal('http', 'https://evil.com/<injected>');

    const callArgs = getMockCreate().mock.calls[0]?.[0];
    const promptContent = callArgs.messages[0].content as string;

    expect(promptContent).toContain('<request>');
    expect(promptContent).toContain('https://evil.com/&lt;injected&gt;');
    expect(promptContent).not.toContain('<injected>');
  });

  it('returns null when Haiku times out', async () => {
    getMockCreate().mockImplementationOnce(
      () => new Promise((resolve) => setTimeout(resolve, 60_000)),
    );

    vi.useFakeTimers();
    const promise = generateRuleProposal('http', 'https://example.com/');
    vi.advanceTimersByTime(10_001);
    const result = await promise;
    vi.useRealTimers();

    expect(result).toBeNull();
  });

  it('returns null when response has no tool_use block', async () => {
    getMockCreate().mockResolvedValueOnce({
      content: [{ type: 'text', text: 'I cannot help with that.' }],
    });

    expect(
      await generateRuleProposal('http', 'https://example.com/'),
    ).toBeNull();
  });

  it('returns null when Haiku throws an error', async () => {
    getMockCreate().mockRejectedValueOnce(new Error('API error'));

    expect(
      await generateRuleProposal('http', 'https://example.com/'),
    ).toBeNull();
  });

  it('returns null when tool input has name > 40 chars', async () => {
    getMockCreate().mockResolvedValueOnce(
      makeToolUseResponse({ name: 'A'.repeat(41) }),
    );

    expect(
      await generateRuleProposal('http', 'https://example.com/'),
    ).toBeNull();
  });

  it('returns null for * pattern in tool input', async () => {
    getMockCreate().mockResolvedValueOnce(
      makeToolUseResponse({ patterns: ['*'] }),
    );

    expect(
      await generateRuleProposal('http', 'https://example.com/'),
    ).toBeNull();
  });

  it('returns null for bad scope in tool input', async () => {
    getMockCreate().mockResolvedValueOnce(
      makeToolUseResponse({ scope: 'everyone' }),
    );

    expect(
      await generateRuleProposal('http', 'https://example.com/'),
    ).toBeNull();
  });

  it('returns null for connect pattern without : in tool input', async () => {
    getMockCreate().mockResolvedValueOnce(
      makeToolUseResponse({ patterns: ['*.github.com'] }),
    );

    expect(
      await generateRuleProposal('connect', 'api.github.com:443'),
    ).toBeNull();
  });

  it('returns null for mcp pattern not starting with mcp__', async () => {
    getMockCreate().mockResolvedValueOnce(
      makeToolUseResponse({ patterns: ['nanoclaw__send_message'] }),
    );

    expect(
      await generateRuleProposal('mcp', 'mcp__nanoclaw__send_message'),
    ).toBeNull();
  });
});
