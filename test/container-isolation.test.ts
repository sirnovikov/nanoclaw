/**
 * Integration tests for container isolation.
 *
 * These tests spawn real Docker containers on the nanoclaw-proxy network
 * to verify network isolation and mount access controls. They require
 * Docker to be running and the nanoclaw-proxy network to exist.
 *
 * If these tests fail, your containers can reach the internet — fix it.
 */
import { execSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const NETWORK = 'nanoclaw-proxy';
const IMAGE = 'alpine:latest';
const TIMEOUT_MS = 30_000;

function run(
  cmd: string,
  mounts: string[] = [],
): { stdout: string; exitCode: number } {
  const mountArgs = mounts.flatMap((m) => ['-v', m]);
  const args = [
    'run', '--rm',
    '--network', NETWORK,
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    ...mountArgs,
    IMAGE, 'sh', '-c', cmd,
  ];

  const result = spawnSync('docker', args, {
    encoding: 'utf-8',
    timeout: TIMEOUT_MS,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  return {
    stdout: (result.stdout ?? '').trim(),
    exitCode: result.status ?? 1,
  };
}

describe('container network isolation', () => {
  it('cannot reach external hosts via TCP', () => {
    const result = run(
      'wget -q -O /dev/null --timeout=3 http://1.1.1.1/ 2>&1; echo "exit:$?"',
    );
    expect(result.stdout).toContain('exit:1');
  }, TIMEOUT_MS);

  it('cannot resolve external DNS', () => {
    const result = run(
      'wget -q -O /dev/null --timeout=3 http://example.com/ 2>&1; echo "exit:$?"',
    );
    expect(result.stdout).toContain('exit:1');
  }, TIMEOUT_MS);

  it('cannot ping external hosts', () => {
    const result = run('ping -c 1 -W 3 1.1.1.1 2>&1; echo "exit:$?"');
    expect(result.stdout).toContain('exit:1');
  }, TIMEOUT_MS);

  it('has all capabilities dropped', () => {
    const result = run('cat /proc/self/status | grep CapEff');
    expect(result.stdout).toContain('0000000000000000');
  }, TIMEOUT_MS);
});

describe('container mount access', () => {
  let tmpDir: string;
  let rwDir: string;
  let roDir: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-mount-test-'));
    rwDir = path.join(tmpDir, 'rw');
    roDir = path.join(tmpDir, 'ro');
    fs.mkdirSync(rwDir, { recursive: true });
    fs.mkdirSync(roDir, { recursive: true });
    fs.writeFileSync(path.join(rwDir, 'existing.txt'), 'rw-content');
    fs.writeFileSync(path.join(roDir, 'existing.txt'), 'ro-content');
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('can read from read-only mount', () => {
    const result = run('cat /mnt/ro/existing.txt', [`${roDir}:/mnt/ro:ro`]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('ro-content');
  });

  it('cannot write to read-only mount', () => {
    const result = run(
      'echo "hacked" > /mnt/ro/new.txt 2>&1; echo "exit:$?"',
      [`${roDir}:/mnt/ro:ro`],
    );
    expect(result.stdout).toContain('exit:1');
    expect(fs.existsSync(path.join(roDir, 'new.txt'))).toBe(false);
  });

  it('cannot modify existing file on read-only mount', () => {
    const result = run(
      'echo "hacked" >> /mnt/ro/existing.txt 2>&1; echo "exit:$?"',
      [`${roDir}:/mnt/ro:ro`],
    );
    expect(result.stdout).toContain('exit:1');
    expect(fs.readFileSync(path.join(roDir, 'existing.txt'), 'utf-8')).toBe('ro-content');
  });

  it('cannot delete from read-only mount', () => {
    const result = run(
      'rm /mnt/ro/existing.txt 2>&1; echo "exit:$?"',
      [`${roDir}:/mnt/ro:ro`],
    );
    expect(result.stdout).toContain('exit:1');
    expect(fs.existsSync(path.join(roDir, 'existing.txt'))).toBe(true);
  });

  it('can read from read-write mount', () => {
    const result = run('cat /mnt/rw/existing.txt', [`${rwDir}:/mnt/rw`]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('rw-content');
  });

  it('can write to read-write mount', () => {
    const result = run('echo "written" > /mnt/rw/new.txt', [`${rwDir}:/mnt/rw`]);
    expect(result.exitCode).toBe(0);
    expect(fs.readFileSync(path.join(rwDir, 'new.txt'), 'utf-8').trim()).toBe('written');
  });

  it('cannot access unmounted host paths', () => {
    const result = run(`ls ${tmpDir} 2>&1; echo "exit:$?"`)
    expect(result.stdout).toContain('exit:1');
  });

  it('cannot access paths not explicitly mounted', () => {
    const result = run(
      'cat /mnt/ro/existing.txt 2>&1; echo "exit:$?"',
      [`${rwDir}:/mnt/rw`],
    );
    expect(result.stdout).toContain('exit:1');
  });
});
