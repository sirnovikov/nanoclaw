import { minimatch } from 'minimatch';

import {
  getPermissionRules,
  incrementRuleMatchCount,
  type PermissionRule,
} from '../db.js';

export type EgressType = 'http' | 'connect' | 'mcp';
export type Effect = 'allow' | 'deny';

/**
 * Evaluate whether a request should be allowed or denied based on stored rules.
 *
 * @param egressType - 'http' | 'connect' | 'mcp'
 * @param subject    - Full URL for http; "hostname:port" for connect; tool name for mcp
 * @param groupFolder - The agent's group folder (used for per-group rule matching)
 * @returns 'allow' | 'deny' if a rule matches, undefined if no rule matches (escalate)
 */
export function checkPermissionRule(
  egressType: EgressType,
  subject: string,
  groupFolder: string,
): Effect | undefined {
  const allRules = getPermissionRules({ egress_type: egressType });

  // Evaluation tiers (first match wins across all tiers in order):
  //   1. Per-group deny  — highest priority (explicit block for this group)
  //   2. Per-group allow — per-group allow overrides global deny
  //   3. Global deny     — deny everything else
  //   4. Global allow    — lowest priority
  const tiers: Array<{ scope: 'global' | 'group'; effect: Effect }> = [
    { scope: 'group', effect: 'deny' },
    { scope: 'group', effect: 'allow' },
    { scope: 'global', effect: 'deny' },
    { scope: 'global', effect: 'allow' },
  ];

  for (const tier of tiers) {
    const tierRules = allRules.filter((r) => {
      const scopeMatch = r.scope === tier.scope;
      const effectMatch = r.effect === tier.effect;
      const groupMatch =
        tier.scope === 'global' ? true : r.group_folder === groupFolder;
      return scopeMatch && effectMatch && groupMatch;
    });

    const matched = findFirstMatch(tierRules, subject, egressType);
    if (matched !== undefined) {
      incrementRuleMatchCount(matched.id);
      return tier.effect;
    }
  }

  return undefined;
}

/**
 * For HTTP URL patterns, `*` should match across path segments (e.g.
 * `https://api.openai.com/*` should match deep paths like
 * `https://api.openai.com/v1/chat/completions`).
 * Replace non-globstar `*` with `**` for http egress type.
 */
function normalizePattern(pattern: string, egressType: EgressType): string {
  if (egressType === 'http') {
    return pattern.replace(/(?<!\*)\*(?!\*)/g, '**');
  }
  return pattern;
}

function findFirstMatch(
  rules: PermissionRule[],
  subject: string,
  egressType: EgressType,
): PermissionRule | undefined {
  for (const rule of rules) {
    const normalizedPattern = normalizePattern(rule.pattern, egressType);
    if (minimatch(subject, normalizedPattern, { nocase: true })) {
      return rule;
    }
  }
  return undefined;
}
