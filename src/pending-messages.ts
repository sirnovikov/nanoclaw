import fs from 'node:fs';
import path from 'node:path';

export interface PendingProxyMessage {
  messageId: number;
  chatJid: string;
  requestId: string;
  ts: string;
}

export const MAX_PENDING_MESSAGES = 30;

export function appendPendingMessage(
  filePath: string,
  entry: PendingProxyMessage,
): void {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const existing = loadPendingProxyMessages(filePath);
    const trimmed = [...existing.slice(-(MAX_PENDING_MESSAGES - 1)), entry];
    fs.writeFileSync(
      filePath,
      `${trimmed.map((e) => JSON.stringify(e)).join('\n')}\n`,
      'utf-8',
    );
  } catch {
    // Non-critical — do not let logging failures break the proxy
  }
}

export function clearPendingProxyMessages(filePath: string): void {
  try {
    fs.writeFileSync(filePath, '', 'utf-8');
  } catch {
    /* ignore */
  }
}

export function loadPendingProxyMessages(
  filePath: string,
): PendingProxyMessage[] {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    return content
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as PendingProxyMessage);
  } catch {
    return [];
  }
}
