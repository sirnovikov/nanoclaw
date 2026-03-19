/**
 * Integration tests that call real Haiku API.
 * Requires HAIKU_API_KEY or ANTHROPIC_API_KEY in .env (or env vars).
 * Skipped in CI — run manually with: bun test permission-rule-generator.integration
 */
import { describe, expect, it } from 'vitest';

import { generateRuleProposal, validateProposal } from './permission-rule-generator.js';

// Check both API key availability and actual network access (sandboxed environments block DNS)
const hasApiKey = !!(
  process.env.HAIKU_API_KEY ||
  process.env.ANTHROPIC_API_KEY ||
  (() => {
    try {
      const fs = require('node:fs');
      const path = require('node:path');
      const content = fs.readFileSync(path.join(process.cwd(), '.env'), 'utf-8');
      return content.includes('HAIKU_API_KEY') || content.includes('ANTHROPIC_API_KEY');
    } catch {
      return false;
    }
  })()
);

const canReachApi = hasApiKey
  ? await new Promise<boolean>((resolve) => {
      const dns = require('node:dns');
      dns.lookup('api.anthropic.com', (err: unknown) => resolve(!err));
    })
  : false;

const describeIntegration = canReachApi ? describe : describe.skip;

describeIntegration('generateRuleProposal (live Haiku)', () => {
  it('generates valid MCP proposal for vercel tool', async () => {
    const result = await generateRuleProposal(
      'mcp',
      'mcp__vercel__list_teams',
      [{ name: 'list_teams' }, { name: 'get_deployment' }, { name: 'deploy' }],
    );

    expect(result).not.toBeNull();
    expect(result?.name).toBeTruthy();
    expect(result?.name.length).toBeLessThanOrEqual(40);
    expect(result?.patterns.every((p) => /^mcp__/.test(p))).toBe(true);
    expect(result?.scope).toMatch(/^(global|group)$/);
    expect(result?.description).toBeTruthy();
  }, 15_000);

  it('generates valid CONNECT proposal for HTTPS host', async () => {
    const result = await generateRuleProposal(
      'connect',
      'api.github.com:443',
    );

    expect(result).not.toBeNull();
    expect(result?.name.length).toBeLessThanOrEqual(40);
    expect(result?.patterns.every((p) => p.includes(':'))).toBe(true);
    expect(result?.scope).toMatch(/^(global|group)$/);
  }, 15_000);

  it('generates valid HTTP proposal for URL', async () => {
    const result = await generateRuleProposal(
      'http',
      'https://registry.npmjs.org/express',
    );

    expect(result).not.toBeNull();
    expect(result?.name.length).toBeLessThanOrEqual(40);
    expect(result?.patterns.length).toBeGreaterThan(0);
    expect(result?.scope).toMatch(/^(global|group)$/);
  }, 15_000);

  it('does not propose near-universal wildcard patterns', async () => {
    const result = await generateRuleProposal(
      'connect',
      'some-random-host.example.com:443',
    );

    // If Haiku proposes *, our validation catches it
    if (result) {
      expect(result.patterns).not.toContain('*');
      expect(result.patterns).not.toContain('**');
      expect(result.patterns).not.toContain('*:*');
      expect(result.patterns).not.toContain('*:443');
    }
  }, 15_000);

  it('proposal passes validateProposal after generation', async () => {
    const result = await generateRuleProposal(
      'mcp',
      'mcp__github__create_issue',
    );

    expect(result).not.toBeNull();
    // Re-validate to confirm round-trip integrity
    const revalidated = validateProposal(result, 'mcp');
    expect(revalidated).toEqual(result);
  }, 15_000);
});
