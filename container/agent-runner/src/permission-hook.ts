import fs from 'fs';
import path from 'path';

import { HookCallback } from '@anthropic-ai/claude-agent-sdk';

const REQUESTS_DIR = '/ipc/permissions/requests';
const RESPONSES_DIR = '/ipc/permissions/responses';
const POLL_INTERVAL_MS = 500;
const TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

interface PermissionInput {
  tool_name?: string;
  tool_input?: unknown;
}

interface PermissionRequestFile {
  type: 'permission_request';
  requestId: string; // "<13-digit-ms>-<6-char-random>"
  groupFolder: string;
  chatJid: string;
  toolName: string; // 'mcp__nanoclaw__*'
  toolInput: unknown; // raw JSON from SDK — host formats display from this
  timestamp: string;
}

interface PermissionResponseFile {
  approved: boolean;
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
    decision: { behavior: 'deny' as const, message: 'Permission denied' },
  },
};

function writeRequestFile(reqPath: string, data: PermissionRequestFile): void {
  const fd = fs.openSync(
    reqPath,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
    0o644,
  );
  try {
    fs.writeSync(fd, JSON.stringify(data));
  } finally {
    fs.closeSync(fd);
  }
  // Make immutable after write — prevents any future writes to this file
  fs.chmodSync(reqPath, 0o444);
}

export function createPermissionRequestHook(
  groupFolder: string,
  chatJid: string,
): HookCallback {
  return async (input) => {
    const perm = input as PermissionInput;
    const toolName = perm.tool_name ?? 'unknown';

    // Only intercept MCP calls. All other tools (Bash, Write, Edit, etc.) are
    // governed by the container sandbox — no Telegram approval needed.
    if (!toolName.startsWith('mcp__')) {
      return ALLOW;
    }

    const toolInput = perm.tool_input ?? {};

    fs.mkdirSync(REQUESTS_DIR, { recursive: true });
    fs.mkdirSync(RESPONSES_DIR, { recursive: true });

    const reqId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const reqPath = path.join(REQUESTS_DIR, `${reqId}.json`);

    const requestData: PermissionRequestFile = {
      type: 'permission_request',
      requestId: reqId,
      groupFolder,
      chatJid,
      toolName,
      toolInput,
      timestamp: new Date().toISOString(),
    };

    writeRequestFile(reqPath, requestData);

    // Poll for response file
    const responsePath = path.join(RESPONSES_DIR, `${reqId}.json`);
    const start = Date.now();

    while (Date.now() - start < TIMEOUT_MS) {
      if (fs.existsSync(responsePath)) {
        try {
          const response = JSON.parse(
            fs.readFileSync(responsePath, 'utf-8'),
          ) as PermissionResponseFile;
          fs.unlinkSync(responsePath);
          return response.approved ? ALLOW : DENY;
        } catch {
          // Response file not yet fully written — retry on next poll
        }
      }
      await new Promise<void>((r) => setTimeout(r, POLL_INTERVAL_MS));
    }

    // Timeout — deny by default
    return DENY;
  };
}
