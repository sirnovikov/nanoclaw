# Ephemeral Status Messages Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show real-time container lifecycle and agent activity as a silent, auto-updating Telegram message that is deleted when the real response arrives.

**Architecture:** The agent-runner emits tool-use events via an optional `toolUse` field on `ContainerOutput`. The host streams these through the existing sentinel-based parser and uses them to send/edit/delete an ephemeral Telegram message in `processGroupMessages()`.

**Tech Stack:** Node.js, TypeScript, grammY (Telegram bot framework), Claude Agent SDK, Vitest

**Spec:** `docs/superpowers/specs/2026-03-21-ephemeral-status-messages-design.md`

---

## File Structure

| File | Responsibility | Change |
|------|---------------|--------|
| `src/format-tool-status.ts` | Pure function: tool name + input → italic Markdown status string | Create |
| `src/format-tool-status.test.ts` | Tests for `formatToolStatus` | Create |
| `src/types.ts` | Channel interface | Add optional `sendSilentMessage`, `editMessage`, `deleteMessage` |
| `src/channels/telegram.ts` | Telegram channel | Add 3 new methods |
| `src/container-runner.ts` | Container output type | Add `toolUse` to `ContainerOutput` |
| `container/agent-runner/src/index.ts` | Agent runner | Emit `toolUse` events from assistant messages |
| `src/index.ts` | Orchestrator | Status message lifecycle in `processGroupMessages` |

---

## Chunk 1: formatToolStatus + Channel Interface

### Task 1: formatToolStatus — Pure Formatting Function

**Files:**
- Create: `src/format-tool-status.ts`
- Create: `src/format-tool-status.test.ts`

- [ ] **Step 1: Write the tests**

```typescript
// src/format-tool-status.test.ts
import { describe, expect, it } from 'vitest';

import { formatToolStatus } from './format-tool-status.js';

describe('formatToolStatus', () => {
  it('formats Read with file path', () => {
    expect(formatToolStatus('Read', 'src/index.ts')).toBe(
      '_Reading_ `src/index.ts`',
    );
  });

  it('formats Bash with command', () => {
    expect(formatToolStatus('Bash', 'npm run build')).toBe(
      '_Running_ `npm run build`',
    );
  });

  it('formats Edit with file path', () => {
    expect(formatToolStatus('Edit', 'src/types.ts')).toBe(
      '_Editing_ `src/types.ts`',
    );
  });

  it('formats Write with file path', () => {
    expect(formatToolStatus('Write', 'src/new-file.ts')).toBe(
      '_Writing_ `src/new-file.ts`',
    );
  });

  it('formats Grep without input', () => {
    expect(formatToolStatus('Grep')).toBe('_Searching..._');
  });

  it('formats Grep with pattern', () => {
    expect(formatToolStatus('Grep', 'TODO')).toBe('_Searching_ `TODO`');
  });

  it('formats Glob without input', () => {
    expect(formatToolStatus('Glob')).toBe('_Searching files..._');
  });

  it('formats WebSearch with query', () => {
    expect(formatToolStatus('WebSearch', 'node streams')).toBe(
      '_Searching the web_ `node streams`',
    );
  });

  it('formats WebFetch with URL', () => {
    expect(formatToolStatus('WebFetch', 'https://example.com')).toBe(
      '_Fetching_ `https://example.com`',
    );
  });

  it('formats Agent tool', () => {
    expect(formatToolStatus('Agent')).toBe('_Delegating to subagent..._');
  });

  it('formats unknown tool without input', () => {
    expect(formatToolStatus('SomeNewTool')).toBe('_Using SomeNewTool..._');
  });

  it('formats unknown tool with input', () => {
    expect(formatToolStatus('SomeNewTool', 'arg')).toBe(
      '_Using SomeNewTool_ `arg`',
    );
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test --dots src/format-tool-status.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```typescript
// src/format-tool-status.ts

const TOOL_VERBS: Record<string, string> = {
  Read: 'Reading',
  Write: 'Writing',
  Edit: 'Editing',
  Bash: 'Running',
  Grep: 'Searching',
  Glob: 'Searching files',
  WebSearch: 'Searching the web',
  WebFetch: 'Fetching',
  Agent: 'Delegating to subagent',
};

export function formatToolStatus(toolName: string, input?: string): string {
  const verb = TOOL_VERBS[toolName] ?? `Using ${toolName}`;

  if (input) {
    return `_${verb}_ \`${input}\``;
  }
  return `_${verb}..._`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test --dots src/format-tool-status.test.ts`
Expected: PASS — all 13 tests

- [ ] **Step 5: Commit**

```bash
git add src/format-tool-status.ts src/format-tool-status.test.ts
git commit -m "feat: add formatToolStatus for ephemeral status messages"
```

---

### Task 2: Extend Channel Interface

**Files:**
- Modify: `src/types.ts:82-110`

- [ ] **Step 1: Add optional methods to Channel interface**

After line 109 (`): Promise<number | null>;`), before the closing `}` on line 110, add:

```typescript
  // Optional: send a silent message (no notification). Returns message ID for later edit/delete.
  sendSilentMessage?(jid: string, text: string): Promise<number>;
  // Optional: edit a previously sent message by ID.
  editMessage?(jid: string, messageId: number, text: string): Promise<void>;
  // Optional: delete a previously sent message by ID.
  deleteMessage?(jid: string, messageId: number): Promise<void>;
```

- [ ] **Step 2: Verify build**

Run: `npm run build`
Expected: Clean compile

- [ ] **Step 3: Commit**

```bash
git add src/types.ts
git commit -m "feat: add sendSilentMessage, editMessage, deleteMessage to Channel interface"
```

---

### Task 3: Implement Telegram Channel Methods

**Files:**
- Modify: `src/channels/telegram.ts:545-554` (after `setTyping`, before closing brace)

- [ ] **Step 1: Add three methods after `setTyping` method (after line 554)**

Insert before the closing `}` of the class (before line 555):

```typescript
  async sendSilentMessage(jid: string, text: string): Promise<number> {
    if (!this.bot) {
      throw new Error('Telegram bot not initialized');
    }
    const numericId = jid.replace(/^tg:/, '');
    const msg = await this.bot.api.sendMessage(numericId, text, {
      parse_mode: 'Markdown',
      disable_notification: true,
    });
    return msg.message_id;
  }

  async editMessage(
    jid: string,
    messageId: number,
    text: string,
  ): Promise<void> {
    if (!this.bot) return;
    try {
      const numericId = jid.replace(/^tg:/, '');
      await this.bot.api.editMessageText(numericId, messageId, text, {
        parse_mode: 'Markdown',
      });
    } catch {
      // Message may have been deleted or text is unchanged — ignore
    }
  }

  async deleteMessage(jid: string, messageId: number): Promise<void> {
    if (!this.bot) return;
    try {
      const numericId = jid.replace(/^tg:/, '');
      await this.bot.api.deleteMessage(numericId, messageId);
    } catch {
      // Message may already be deleted — ignore
    }
  }
```

- [ ] **Step 2: Verify build**

Run: `npm run build`
Expected: Clean compile

- [ ] **Step 3: Commit**

```bash
git add src/channels/telegram.ts
git commit -m "feat: add sendSilentMessage, editMessage, deleteMessage to TelegramChannel"
```

---

## Chunk 2: ContainerOutput Extension + Agent Runner

### Task 4: Extend ContainerOutput with toolUse Field

**Files:**
- Modify: `src/container-runner.ts:55-60`
- Modify: `container/agent-runner/src/index.ts:33-38`

- [ ] **Step 1: Add toolUse to host-side ContainerOutput**

In `src/container-runner.ts`, after line 59 (`error?: string;`), add:

```typescript
  /** Tool-use status event — name of tool being called and optional input summary. */
  toolUse?: { name: string; input?: string };
```

- [ ] **Step 2: Add toolUse to container-side ContainerOutput**

In `container/agent-runner/src/index.ts`, after line 37 (`error?: string;`), add:

```typescript
  toolUse?: { name: string; input?: string };
```

- [ ] **Step 3: Verify build**

Run: `npm run build`
Expected: Clean compile

- [ ] **Step 4: Commit**

```bash
git add src/container-runner.ts container/agent-runner/src/index.ts
git commit -m "feat: add toolUse field to ContainerOutput interface"
```

---

### Task 5: Emit toolUse Events from Agent Runner

**Files:**
- Modify: `container/agent-runner/src/index.ts:440-468` (the `for await` message handler)

- [ ] **Step 1: Add tool_use detection after the assistant UUID check**

After line 447 (`}`) — the end of the `if (message.type === 'assistant' && 'uuid' in message)` block — insert:

```typescript
    // Emit tool-use status events for the host to display
    if (message.type === 'assistant' && 'message' in message) {
      const msg = message as {
        message: {
          content: Array<{
            type: string;
            name?: string;
            input?: Record<string, unknown>;
          }>;
        };
      };
      for (const block of msg.message.content) {
        if (block.type === 'tool_use' && block.name) {
          const inputSummary = block.input
            ? ((block.input.file_path ??
                block.input.command ??
                block.input.pattern ??
                block.input.query ??
                block.input.url) as string | undefined)?.slice(0, 120)
            : undefined;
          writeOutput({
            status: 'success',
            result: null,
            toolUse: { name: block.name, input: inputSummary },
          });
        }
      }
    }
```

- [ ] **Step 2: Rebuild container to verify**

Run: `./container/build.sh`
Expected: Build succeeds (tsc inside container compiles clean)

- [ ] **Step 3: Commit**

```bash
git add container/agent-runner/src/index.ts
git commit -m "feat: emit toolUse status events from agent-runner"
```

---

## Chunk 3: Status Message Lifecycle in processGroupMessages

### Task 6: Wire Up Status Messages in processGroupMessages

**Files:**
- Modify: `src/index.ts:216-247` (processGroupMessages function)

This is the core integration. Replace `setTyping` with the ephemeral status message lifecycle.

- [ ] **Step 1: Add import for formatToolStatus**

At the top of `src/index.ts`, add to the imports:

```typescript
import { formatToolStatus } from './format-tool-status.js';
```

- [ ] **Step 2: Replace setTyping and add status message lifecycle**

Replace lines 216-247 (from `await channel.setTyping?.(chatJid, true);` through `await channel.setTyping?.(chatJid, false);` and `if (idleTimer) clearTimeout(idleTimer);`) with:

```typescript
  // Send ephemeral status message (silent — no notification)
  let statusMsgId: number | undefined;
  try {
    statusMsgId = await channel.sendSilentMessage?.(
      chatJid,
      '_Starting container..._',
    );
  } catch {
    // Telegram API down — proceed without status messages
  }

  let hadError = false;
  let outputSentToUser = false;
  let lastStatusEdit = 0;
  const STATUS_THROTTLE_MS = 2000;

  const output = await runAgent(group, prompt, chatJid, async (result) => {
    // Tool-use status update — edit the ephemeral message
    if (result.toolUse && statusMsgId && !outputSentToUser) {
      const now = Date.now();
      if (now - lastStatusEdit >= STATUS_THROTTLE_MS) {
        lastStatusEdit = now;
        const label = formatToolStatus(result.toolUse.name, result.toolUse.input);
        await channel.editMessage?.(chatJid, statusMsgId, label);
      }
      return;
    }

    // Session-update marker (result: null, no toolUse) — show "thinking"
    if (!result.toolUse && !result.result && statusMsgId && !outputSentToUser) {
      const now = Date.now();
      if (now - lastStatusEdit >= STATUS_THROTTLE_MS) {
        lastStatusEdit = now;
        await channel.editMessage?.(chatJid, statusMsgId, '_Agent thinking..._');
      }
      return;
    }

    // Streaming output callback — called for each agent result
    if (result.result) {
      // Delete status message before sending real output
      if (statusMsgId && !outputSentToUser) {
        await channel.deleteMessage?.(chatJid, statusMsgId);
        statusMsgId = undefined;
      }

      const raw =
        typeof result.result === 'string'
          ? result.result
          : JSON.stringify(result.result);
      // Strip <internal>...</internal> blocks — agent uses these for internal reasoning
      const text = raw.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
      logger.info({ group: group.name }, `Agent output: ${raw.slice(0, 200)}`);
      if (text) {
        await channel.sendMessage(chatJid, text);
        outputSentToUser = true;
      }
      // Only reset idle timer on actual results, not session-update markers (result: null)
      resetIdleTimer();
    }

    if (result.status === 'success') {
      queue.notifyIdle(chatJid);
    }

    if (result.status === 'error') {
      hadError = true;
    }
  });

  // Cleanup: delete status message if still present (error/no output paths)
  if (statusMsgId) {
    try {
      await channel.deleteMessage?.(chatJid, statusMsgId);
    } catch {
      // Non-critical
    }
  }
  if (idleTimer) clearTimeout(idleTimer);
```

Note: The `await channel.setTyping?.(chatJid, true)` (line 216) and `await channel.setTyping?.(chatJid, false)` (line 247) are both removed — the status message replaces them.

- [ ] **Step 3: Verify build**

Run: `npm run build`
Expected: Clean compile

- [ ] **Step 4: Run all tests**

Run: `bun test --dots`
Expected: All existing tests pass + new format-tool-status tests pass

- [ ] **Step 5: Commit**

```bash
git add src/index.ts
git commit -m "feat: ephemeral status messages in processGroupMessages"
```

---

### Task 7: Rebuild Container and Test End-to-End

- [ ] **Step 1: Rebuild the container image**

Run: `./container/build.sh`
Expected: Build succeeds

- [ ] **Step 2: Restart the service**

Run: `launchctl kickstart -k gui/$(id -u)/com.nanoclaw`
Expected: Service restarts

- [ ] **Step 3: Send a test message via Telegram**

Send a message to the bot that triggers an agent run. Verify:
1. A silent italic status message appears ("Starting container...")
2. It updates as the agent works ("Reading...", "Running...", etc.)
3. It disappears when the real response is sent
4. The real response arrives with normal notification

- [ ] **Step 4: Commit any fixes from testing**

```bash
git add -A
git commit -m "fix: adjustments from end-to-end testing"
```
