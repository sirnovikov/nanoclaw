import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  MAX_PENDING_MESSAGES,
  appendPendingMessage,
  clearPendingProxyMessages,
  loadPendingProxyMessages,
  type PendingProxyMessage,
} from './pending-messages.js';

function makeEntry(id: number): PendingProxyMessage {
  return {
    messageId: id,
    chatJid: 'tg:123',
    requestId: `req-${id}`,
    ts: new Date().toISOString(),
  };
}

describe('pending-messages', () => {
  let filePath: string;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pending-msg-test-'));
    filePath = path.join(tmpDir, 'pending.jsonl');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('appends and loads a single message', () => {
    const entry = makeEntry(1);
    appendPendingMessage(filePath, entry);

    const loaded = loadPendingProxyMessages(filePath);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toEqual(entry);
  });

  it('appends multiple messages', () => {
    appendPendingMessage(filePath, makeEntry(1));
    appendPendingMessage(filePath, makeEntry(2));
    appendPendingMessage(filePath, makeEntry(3));

    const loaded = loadPendingProxyMessages(filePath);
    expect(loaded).toHaveLength(3);
    expect(loaded.map((e) => e.messageId)).toEqual([1, 2, 3]);
  });

  it('caps at MAX_PENDING_MESSAGES, keeping the most recent', () => {
    for (let i = 1; i <= MAX_PENDING_MESSAGES + 10; i++) {
      appendPendingMessage(filePath, makeEntry(i));
    }

    const loaded = loadPendingProxyMessages(filePath);
    expect(loaded).toHaveLength(MAX_PENDING_MESSAGES);
    // Should have entries 11..40 (dropped 1..10)
    expect(loaded[0]?.messageId).toBe(11);
    expect(loaded[loaded.length - 1]?.messageId).toBe(MAX_PENDING_MESSAGES + 10);
  });

  it('clearPendingProxyMessages empties the file', () => {
    appendPendingMessage(filePath, makeEntry(1));
    appendPendingMessage(filePath, makeEntry(2));

    clearPendingProxyMessages(filePath);

    const loaded = loadPendingProxyMessages(filePath);
    expect(loaded).toHaveLength(0);
  });

  it('loadPendingProxyMessages returns empty array for missing file', () => {
    const loaded = loadPendingProxyMessages(
      path.join(tmpDir, 'nonexistent.jsonl'),
    );
    expect(loaded).toEqual([]);
  });

  it('creates parent directories if they do not exist', () => {
    const nested = path.join(tmpDir, 'a', 'b', 'pending.jsonl');
    appendPendingMessage(nested, makeEntry(1));

    const loaded = loadPendingProxyMessages(nested);
    expect(loaded).toHaveLength(1);
  });
});
