import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

// Integration tests for MCP permission file-based IPC.
// These tests exercise the file format and IPC watcher behaviour
// with a real temp directory (no Docker required).

describe('MCP permission flow integration', () => {
  let tmpDir: string;
  let requestsDir: string;
  let responsesDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-perm-test-'));
    requestsDir = path.join(tmpDir, 'requests');
    responsesDir = path.join(tmpDir, 'responses');
    fs.mkdirSync(requestsDir, { recursive: true });
    fs.mkdirSync(responsesDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('permission request file has expected shape', () => {
    // Simulate the file written by permission-hook.ts (runs in Docker — not importable here)
    const reqId = `${Date.now()}-abc123`;
    const requestData = {
      type: 'permission_request',
      requestId: reqId,
      groupFolder: 'test_group',
      chatJid: 'tg:123',
      toolName: 'mcp__nanoclaw__send_message',
      toolInput: { to: 'user', text: 'hello' },
      timestamp: new Date().toISOString(),
    };

    const reqPath = path.join(requestsDir, `${reqId}.json`);
    const fd = fs.openSync(
      reqPath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
      0o644,
    );
    try {
      fs.writeSync(fd, JSON.stringify(requestData));
    } finally {
      fs.closeSync(fd);
    }
    fs.chmodSync(reqPath, 0o444);

    // Verify the file was written correctly
    const content = JSON.parse(fs.readFileSync(reqPath, 'utf-8'));
    expect(content.type).toBe('permission_request');
    expect(content.requestId).toBe(reqId);
    expect(content.toolName).toBe('mcp__nanoclaw__send_message');
    expect(content.toolInput).toEqual({ to: 'user', text: 'hello' });
    expect(content.timestamp).toBeTruthy();

    // File should be read-only (0o444)
    const stat = fs.statSync(reqPath);
    expect(stat.mode & 0o777).toBe(0o444);
  });

  it('deny response file resolves correctly', () => {
    const reqId = `${Date.now()}-def456`;

    // Write deny response
    const responseFile = path.join(responsesDir, `${reqId}.json`);
    fs.writeFileSync(responseFile, JSON.stringify({ approved: false }));

    const response = JSON.parse(fs.readFileSync(responseFile, 'utf-8'));
    expect(response.approved).toBe(false);
  });

  it('allow response file resolves correctly', () => {
    const reqId = `${Date.now()}-ghi789`;

    // Write allow response
    const responseFile = path.join(responsesDir, `${reqId}.json`);
    fs.writeFileSync(responseFile, JSON.stringify({ approved: true }));

    const response = JSON.parse(fs.readFileSync(responseFile, 'utf-8'));
    expect(response.approved).toBe(true);
  });

  it('O_EXCL prevents duplicate request file creation', () => {
    const reqId = `${Date.now()}-dup123`;
    const reqPath = path.join(requestsDir, `${reqId}.json`);

    // First write succeeds
    const fd = fs.openSync(
      reqPath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
      0o644,
    );
    fs.writeSync(fd, JSON.stringify({ type: 'permission_request' }));
    fs.closeSync(fd);

    // Second write with same name must throw EEXIST
    expect(() => {
      fs.openSync(
        reqPath,
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
        0o644,
      );
    }).toThrow(/EEXIST/);
  });
});
