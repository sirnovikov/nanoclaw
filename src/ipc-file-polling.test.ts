import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

import { _initTestDatabase, setRegisteredGroup } from './db.js';
import { type IpcDeps, startIpcWatcher } from './ipc.js';
import type { RegisteredGroup } from './types.js';

const MAIN: RegisteredGroup = {
  name: 'Main',
  folder: 'main-group',
  trigger: 'always',
  added_at: '2024-01-01T00:00:00.000Z',
  isMain: true,
};

const OTHER: RegisteredGroup = {
  name: 'Other',
  folder: 'other-group',
  trigger: '@bot',
  added_at: '2024-01-01T00:00:00.000Z',
};

let ipcBaseDir: string;
let deps: IpcDeps;

beforeEach(() => {
  _initTestDatabase();
  setRegisteredGroup('main@g.us', MAIN);
  setRegisteredGroup('other@g.us', OTHER);
  ipcBaseDir = path.join(
    os.tmpdir(),
    `ipc-poll-test-${process.pid}-${Date.now()}`,
  );
  fs.mkdirSync(ipcBaseDir, { recursive: true });
  vi.useFakeTimers();
  deps = {
    sendMessage: vi.fn().mockResolvedValue(undefined),
    registeredGroups: () => ({
      'main@g.us': MAIN,
      'other@g.us': OTHER,
    }),
    registerGroup: vi.fn(),
    syncGroups: vi.fn().mockResolvedValue(undefined),
    getAvailableGroups: vi.fn().mockReturnValue([]),
    writeGroupsSnapshot: vi.fn(),
  };
});

afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(ipcBaseDir, { recursive: true, force: true });
});

describe('startIpcWatcher — message forwarding', () => {
  it('sends a message when an authorized IPC message file is present', async () => {
    const messagesDir = path.join(ipcBaseDir, 'other-group', 'messages');
    fs.mkdirSync(messagesDir, { recursive: true });
    fs.writeFileSync(
      path.join(messagesDir, '001.json'),
      JSON.stringify({ type: 'message', chatJid: 'other@g.us', text: 'hello' }),
    );

    startIpcWatcher(deps, ipcBaseDir);
    await vi.advanceTimersByTimeAsync(10);

    expect(deps.sendMessage).toHaveBeenCalledWith('other@g.us', 'hello');
    expect(fs.existsSync(path.join(messagesDir, '001.json'))).toBe(false);
  });

  it('blocks unauthorized IPC message (non-main sending to another group)', async () => {
    const messagesDir = path.join(ipcBaseDir, 'other-group', 'messages');
    fs.mkdirSync(messagesDir, { recursive: true });
    fs.writeFileSync(
      path.join(messagesDir, '002.json'),
      JSON.stringify({
        type: 'message',
        chatJid: 'main@g.us',
        text: 'infiltrate',
      }),
    );

    startIpcWatcher(deps, ipcBaseDir);
    await vi.advanceTimersByTimeAsync(10);

    expect(deps.sendMessage).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(messagesDir, '002.json'))).toBe(false);
  });

  it('main group can send to any group', async () => {
    const messagesDir = path.join(ipcBaseDir, 'main-group', 'messages');
    fs.mkdirSync(messagesDir, { recursive: true });
    fs.writeFileSync(
      path.join(messagesDir, '003.json'),
      JSON.stringify({
        type: 'message',
        chatJid: 'other@g.us',
        text: 'broadcast',
      }),
    );

    startIpcWatcher(deps, ipcBaseDir);
    await vi.advanceTimersByTimeAsync(10);

    expect(deps.sendMessage).toHaveBeenCalledWith('other@g.us', 'broadcast');
  });
});
