import fs from 'fs';
import path from 'path';

import { HookCallback } from '@anthropic-ai/claude-agent-sdk';

const PERM_DIR = '/workspace/ipc/permissions';
const POLL_INTERVAL_MS = 500;
const TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

interface PermissionInput {
  tool_name?: string;
  tool_input?: unknown;
}

function formatDescription(toolName: string, toolInput: unknown): string {
  if (toolName === 'Bash') {
    const cmd = (toolInput as { command?: string })?.command ?? '';
    const display = cmd.length > 300 ? cmd.slice(0, 300) + '…' : cmd;
    return `Bash: \`${display}\``;
  }

  if (toolName === 'Write' || toolName === 'Edit') {
    const p = (toolInput as { file_path?: string })?.file_path ?? '';
    return `${toolName}: \`${p}\``;
  }

  const inputStr = JSON.stringify(toolInput ?? {});
  const display = inputStr.length > 200 ? inputStr.slice(0, 200) + '…' : inputStr;
  return `${toolName}: \`${display}\``;
}

// Bash commands that are safe to auto-approve without Telegram confirmation.
// These are read-only or low-risk operations inside the workspace.
const SAFE_BASH_RE = /^\s*(ls|cat|head|tail|grep|find|pwd|echo|date|which|wc|sort|uniq|diff|file|stat|du|df|env|printenv|git\s+(log|status|diff|show|branch|remote|fetch|stash list)|node\s+--version|bun\s+--version|npm\s+list|jq\b)\b/;

function isSafeBash(command: string): boolean {
  return SAFE_BASH_RE.test(command);
}

const ALLOW = {
  hookSpecificOutput: {
    hookEventName: 'PermissionRequest' as const,
    decision: { behavior: 'allow' as const },
  },
};

const DENY = {
  hookSpecificOutput: {
    hookEventName: 'PermissionRequest' as const,
    decision: { behavior: 'deny' as const, message: 'Denied via Telegram' },
  },
};

export function createPermissionRequestHook(groupFolder: string, chatJid: string): HookCallback {
  return async (input) => {
    const perm = input as PermissionInput;
    const toolName = perm.tool_name ?? 'unknown';
    const toolInput = perm.tool_input ?? {};

    // Auto-approve safe read-only Bash commands without bothering the user
    if (toolName === 'Bash') {
      const cmd = (toolInput as { command?: string })?.command ?? '';
      if (isSafeBash(cmd)) {
        return ALLOW;
      }
    }

    const reqId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const reqPath = path.join(PERM_DIR, `${reqId}.json`);
    const tmpPath = `${reqPath}.tmp`;

    fs.mkdirSync(PERM_DIR, { recursive: true });

    const requestData = {
      type: 'permission_request',
      requestId: reqId,
      groupFolder,
      chatJid,
      toolName,
      description: formatDescription(toolName, toolInput),
      timestamp: new Date().toISOString(),
    };

    fs.writeFileSync(tmpPath, JSON.stringify(requestData, null, 2));
    fs.renameSync(tmpPath, reqPath);

    // Poll for response file
    const responsePath = `${reqPath}.response`;
    const start = Date.now();

    while (Date.now() - start < TIMEOUT_MS) {
      if (fs.existsSync(responsePath)) {
        try {
          const response = JSON.parse(fs.readFileSync(responsePath, 'utf-8'));
          fs.unlinkSync(responsePath);
          try { fs.unlinkSync(reqPath); } catch { /* already renamed to .notified */ }
          try { fs.unlinkSync(`${reqPath}.notified`); } catch { /* may not exist */ }
          return response.approved ? ALLOW : DENY;
        } catch {
          // Response file not yet fully written — retry on next poll
        }
      }
      await new Promise<void>((r) => setTimeout(r, POLL_INTERVAL_MS));
    }

    // Timeout — deny by default
    try { fs.unlinkSync(reqPath); } catch { /* already renamed */ }
    try { fs.unlinkSync(`${reqPath}.notified`); } catch { /* may not exist */ }
    return DENY;
  };
}

