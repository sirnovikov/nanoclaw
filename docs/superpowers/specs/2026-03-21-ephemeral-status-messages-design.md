# Ephemeral Status Messages — Design Spec

## Goal

Show real-time container lifecycle and agent activity as a silent, auto-updating Telegram message that is deleted when the agent's first real response arrives.

## Architecture

The agent-runner inside the container emits tool-use status events via a new output type alongside existing result outputs. The host-side container-runner parses these and calls a new `onToolUse` callback. `processGroupMessages()` in `index.ts` uses this callback to send/update/delete an ephemeral Telegram message.

## Components

### 1. Container Output Extension

**File:** `container/agent-runner/src/index.ts`

Add a new `ContainerOutput` variant for tool-use status:

```typescript
interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
  /** Tool-use status event (no result, just activity indicator) */
  toolUse?: { name: string; input?: string };
}
```

In the `for await (const message of query(...))` loop, detect `assistant` messages with tool_use content blocks and emit status updates:

```typescript
if (message.type === 'assistant' && 'message' in message) {
  const assistantMsg = message as { message: { content: Array<{ type: string; name?: string; input?: Record<string, unknown> }> } };
  for (const block of assistantMsg.message.content) {
    if (block.type === 'tool_use' && block.name) {
      const inputSummary = block.input
        ? (block.input.file_path as string)
          ?? (block.input.command as string)?.slice(0, 80)
          ?? (block.input.pattern as string)
          ?? undefined
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

### 2. Host-Side Callback

**File:** `src/container-runner.ts`

Extend `ContainerOutput` with the same optional `toolUse` field. No other changes needed — the existing streaming parser already calls `onOutput(parsed)` for every output marker, including ones with `result: null`.

### 3. Ephemeral Message Lifecycle

**File:** `src/index.ts` — `processGroupMessages()`

Before calling `runAgent`, send a silent status message. Track its message ID. Update it on tool-use events. Delete it when the first real result arrives.

Replace `setTyping` with the status message — having both a typing indicator and a status message is redundant.

```typescript
// Send initial status (silent) — replaces setTyping
let statusMsgId: number | undefined;
try {
  statusMsgId = await channel.sendSilentMessage?.(chatJid, '_Starting container..._');
} catch {
  // Telegram API down — proceed without status messages
}

let lastStatusEdit = 0;
const STATUS_THROTTLE_MS = 2000;

const output = await runAgent(group, prompt, chatJid, async (result) => {
  // Session-update marker (result: null, no toolUse) — agent is thinking
  if (!result.toolUse && !result.result && statusMsgId && !outputSentToUser) {
    const now = Date.now();
    if (now - lastStatusEdit >= STATUS_THROTTLE_MS) {
      lastStatusEdit = now;
      await channel.editMessage?.(chatJid, statusMsgId, '_Agent thinking..._');
    }
    return;
  }

  // Tool-use status update
  if (result.toolUse && statusMsgId && !outputSentToUser) {
    const now = Date.now();
    if (now - lastStatusEdit >= STATUS_THROTTLE_MS) {
      lastStatusEdit = now;
      const label = formatToolStatus(result.toolUse.name, result.toolUse.input);
      await channel.editMessage?.(chatJid, statusMsgId, label);
    }
    return; // Don't process further
  }

  // Real result — delete status message first
  if (result.result) {
    if (statusMsgId && !outputSentToUser) {
      await channel.deleteMessage?.(chatJid, statusMsgId);
      statusMsgId = undefined;
    }
    // ... existing send logic ...
  }
});

// Cleanup: delete status if still present (error/no output paths)
if (statusMsgId) {
  await channel.deleteMessage?.(chatJid, statusMsgId);
}
```

**Note:** The `setTyping` calls (lines 216, 247 in current code) are removed when status messages are active. The status message replaces the typing indicator.

### 4. Tool Status Formatting

**File:** `src/index.ts` (helper function)

```typescript
function formatToolStatus(toolName: string, input?: string): string {
  const labels: Record<string, string> = {
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
  const verb = labels[toolName] ?? `Using ${toolName}`;

  if (input) {
    return `_${verb}_ \`${input}\``;
  }
  return `_${verb}..._`;
}
```

Stages shown to user:
1. `_Starting container..._` — sent immediately
2. `_Agent thinking..._` — on first `result: null` with no `toolUse` (session init)
3. `_Reading_ \`src/index.ts\`` — on tool_use events
4. Deleted — when first real text result is sent

### 5. Telegram Channel Methods

**File:** `src/channels/telegram.ts`

Add three new methods to `TelegramChannel`:

```typescript
async sendSilentMessage(jid: string, text: string): Promise<number> {
  const numericId = parseInt(jid.replace('tg:', ''), 10);
  const msg = await this.bot.api.sendMessage(numericId, text, {
    parse_mode: 'Markdown',
    disable_notification: true,
  });
  return msg.message_id;
}

async editMessage(jid: string, messageId: number, text: string): Promise<void> {
  const numericId = parseInt(jid.replace('tg:', ''), 10);
  try {
    await this.bot.api.editMessageText(numericId, messageId, text, {
      parse_mode: 'Markdown',
    });
  } catch {
    // Message may have been deleted or is unchanged — ignore
  }
}

async deleteMessage(jid: string, messageId: number): Promise<void> {
  const numericId = parseInt(jid.replace('tg:', ''), 10);
  try {
    await this.bot.api.deleteMessage(numericId, messageId);
  } catch {
    // Message may already be deleted — ignore
  }
}
```

### 6. Channel Interface Extension

**File:** `src/types.ts`

Add optional methods to the `Channel` interface:

```typescript
sendSilentMessage?(jid: string, text: string): Promise<number>;
editMessage?(jid: string, messageId: number, text: string): Promise<void>;
deleteMessage?(jid: string, messageId: number): Promise<void>;
```

These are optional so non-Telegram channels don't need to implement them.

## Data Flow

```
Container (agent-runner)
  │
  ├─ assistant message with tool_use blocks
  │   → writeOutput({ status: 'success', result: null, toolUse: { name, input } })
  │
  ├─ result message (text output)
  │   → writeOutput({ status: 'success', result: 'text...' })
  │
  ▼
Host (container-runner) — sentinel-based streaming parser
  │
  ├─ onOutput({ toolUse: { name: 'Read', input: 'src/index.ts' } })
  │   → editMessage(chatJid, statusMsgId, '_Reading_ `src/index.ts`')
  │
  ├─ onOutput({ result: 'Here is the code...' })
  │   → deleteMessage(chatJid, statusMsgId)
  │   → sendMessage(chatJid, 'Here is the code...')
  │
  ▼
Telegram API → User sees ephemeral status → replaced by real response
```

## Edge Cases

- **No tool calls before result:** Status goes directly from "Starting container..." to deleted. User sees status briefly.
- **Error/timeout:** Status message deleted in cleanup after `runAgent` returns.
- **Rapid tool calls:** Throttled to one edit per 2 seconds. Latest tool name wins.
- **Channel without support:** `sendSilentMessage?.()` returns undefined → no status message sent → feature silently disabled.
- **Container fails to start:** Status message deleted in post-runAgent cleanup.
- **Multiple concurrent groups:** Each `processGroupMessages` call has its own `statusMsgId` — no cross-talk.
- **Race between edit and delete:** If a result arrives while an `editMessage` is in-flight, `deleteMessage` may arrive first. The `try/catch` in `editMessage` handles the "message not found" error — this is intentional.
- **Multiple results from one agent run:** Status message is deleted on the first result. Subsequent tool-use events between results have no status message to update (`statusMsgId` is set to `undefined` after delete). This is acceptable — the user already has a response.
- **Telegram API failure on sendSilentMessage:** Wrapped in try/catch. If it fails, `statusMsgId` is undefined and all edit/delete calls are skipped via optional chaining. Feature degrades gracefully.
- **NanoClaw restart with orphaned status message:** Status messages are short-lived (seconds to minutes) and contain no actionable content. Unlike permission keyboards, they don't need restart cleanup — stale italic text is harmless.

## Known Limitations (v1)

- **Piped messages not covered:** When follow-up messages are piped to an already-running container via `queue.sendMessage`, there is no status message lifecycle. Only the initial `processGroupMessages` path gets status updates.
- **Increased container stdout volume:** Each tool call emits an extra sentinel-wrapped JSON output. For agents making hundreds of tool calls, this adds I/O overhead and consumes more of the `CONTAINER_MAX_OUTPUT_SIZE` budget.

## Testing

- **Unit: `formatToolStatus`** — verify formatting for known tools, unknown tools, with/without input
- **Unit: agent-runner tool_use emission** — mock SDK messages, verify `writeOutput` called with `toolUse` field
- **Integration: status message lifecycle** — mock channel, verify send → edit → delete sequence

## Files Changed

| File | Change |
|------|--------|
| `container/agent-runner/src/index.ts` | Emit `toolUse` events from assistant messages |
| `src/container-runner.ts` | Extend `ContainerOutput` type with `toolUse` field |
| `src/index.ts` | Status message lifecycle in `processGroupMessages` + `formatToolStatus` helper |
| `src/channels/telegram.ts` | `sendSilentMessage`, `editMessage`, `deleteMessage` methods |
| `src/types.ts` | Optional channel interface methods |
