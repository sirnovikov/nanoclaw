import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Sentinel markers must match container-runner.ts
const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

// Mock config
vi.mock('./config.js', () => ({
  CONTAINER_IMAGE: 'nanoclaw-agent:latest',
  CONTAINER_MAX_OUTPUT_SIZE: 10485760,
  CONTAINER_TIMEOUT: 1800000, // 30min
  CREDENTIAL_PROXY_PORT: 3001,
  DATA_DIR: '/tmp/nanoclaw-test-data',
  GROUPS_DIR: '/tmp/nanoclaw-test-groups',
  IDLE_TIMEOUT: 1800000, // 30min
  TIMEZONE: 'America/Los_Angeles',
}));

// Mock logger
vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock fs
vi.mock('fs', () => ({
  default: {
    existsSync: vi.fn(() => false),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    readFileSync: vi.fn(() => ''),
    readdirSync: vi.fn(() => []),
    statSync: vi.fn(() => ({ isDirectory: () => false })),
    copyFileSync: vi.fn(),
    cpSync: vi.fn(),
  },
}));

// Mock mount-security
vi.mock('./mount-security.js', () => ({
  validateAdditionalMounts: vi.fn(() => []),
}));

// Create a controllable fake ChildProcess
function createFakeProcess() {
  const proc = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
    pid: number;
  };
  proc.stdin = new PassThrough();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.kill = vi.fn();
  proc.pid = 12345;
  return proc;
}

let fakeProc: ReturnType<typeof createFakeProcess>;

// Mock child_process.spawn
vi.mock('child_process', () => ({
  spawn: vi.fn(() => fakeProc),
  execSync: vi.fn((cmd: string) => {
    if (cmd.includes('network inspect nanoclaw-proxy')) return '172.20.0.1\n';
    return '';
  }),
  exec: vi.fn(
    (
      cmd: string,
      optsOrCb?: unknown,
      cb?: (err: Error | null, stdout: string, stderr: string) => void,
    ) => {
      // exec(cmd, callback) or exec(cmd, opts, callback)
      const callback =
        typeof optsOrCb === 'function'
          ? (optsOrCb as (
              err: Error | null,
              stdout: string,
              stderr: string,
            ) => void)
          : cb;
      if (callback) {
        // Return a fake IP for docker inspect calls
        const stdout = cmd.includes('inspect') ? '172.19.0.2\n' : '';
        callback(null, stdout, '');
      }
      return new EventEmitter();
    },
  ),
}));

// Mock the group registry so we can assert registrations
vi.mock('./container-group-registry.js', () => ({
  registerContainerGroup: vi.fn(),
  deregisterContainerGroup: vi.fn(),
  resolveContainerGroup: vi.fn().mockReturnValue(null),
  _clearRegistry: vi.fn(),
}));

import { exec, spawn } from 'node:child_process';
import fs from 'node:fs';
import {
  deregisterContainerGroup,
  registerContainerGroup,
} from './container-group-registry.js';
import { type ContainerOutput, runContainerAgent } from './container-runner.js';
import type { RegisteredGroup } from './types.js';

const testGroup: RegisteredGroup = {
  name: 'Test Group',
  folder: 'test-group',
  trigger: '@Andy',
  added_at: new Date().toISOString(),
};

const testInput = {
  prompt: 'Hello',
  groupFolder: 'test-group',
  chatJid: 'test@g.us',
  isMain: false,
};

function emitOutputMarker(
  proc: ReturnType<typeof createFakeProcess>,
  output: ContainerOutput,
) {
  const json = JSON.stringify(output);
  proc.stdout.push(`${OUTPUT_START_MARKER}\n${json}\n${OUTPUT_END_MARKER}\n`);
}

describe('container-runner spawn args (always locked down)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Spawn the container and return the spawn args. */
  async function spawnGroup(group: RegisteredGroup): Promise<void> {
    vi.mocked(spawn).mockClear();
    const resultPromise = runContainerAgent(group, testInput, () => {});
    // Let IP registration resolve
    await vi.advanceTimersByTimeAsync(10);
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'ok',
      newSessionId: 's1',
    });
    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
    await resultPromise;
  }

  /** Run the container to completion and return the spawn args. */
  async function spawnArgsFor(group: RegisteredGroup): Promise<string[]> {
    await spawnGroup(group);
    return [...(vi.mocked(spawn).mock.calls[0]?.[1] ?? [])];
  }

  /** Pull all `-e KEY=VALUE` entries from spawn args. */
  function envArgs(args: string[]): Record<string, string> {
    const result: Record<string, string> = {};
    for (let i = 0; i < args.length - 1; i++) {
      const nextArg = args[i + 1];
      if (args[i] === '-e' && nextArg !== undefined) {
        const eq = nextArg.indexOf('=');
        if (eq !== -1) {
          result[nextArg.slice(0, eq)] = nextArg.slice(eq + 1);
        }
      }
    }
    return result;
  }

  it('always uses nanoclaw-proxy network', async () => {
    const group = { ...testGroup, containerConfig: undefined };
    const args = await spawnArgsFor(group);
    expect(args).toContain('--network');
    expect(args).toContain('nanoclaw-proxy');
  });

  it('always drops all capabilities', async () => {
    const group = { ...testGroup, containerConfig: undefined };
    const args = await spawnArgsFor(group);
    expect(args).toContain('--cap-drop');
    expect(args).toContain('ALL');
  });

  it('always sets no-new-privileges', async () => {
    const group = { ...testGroup, containerConfig: undefined };
    const args = await spawnArgsFor(group);
    expect(args).toContain('--security-opt');
    expect(args).toContain('no-new-privileges');
  });

  it('always sets HTTP_PROXY to credential proxy', async () => {
    const group = { ...testGroup, containerConfig: undefined };
    const args = await spawnArgsFor(group);
    const joined = args.join(' ');
    expect(joined).toMatch(/HTTP_PROXY=http:\/\//);
    expect(joined).toMatch(/HTTPS_PROXY=http:\/\//);
  });

  it('always adds host.docker.internal host entry', async () => {
    const group = { ...testGroup, containerConfig: undefined };
    const args = await spawnArgsFor(group);
    const addHostIdx = args.indexOf('--add-host');
    expect(addHostIdx).not.toBe(-1);
    expect(args[addHostIdx + 1]).toBe('host.docker.internal:host-gateway');
  });

  it('NO_PROXY is localhost,127.0.0.1,host.docker.internal', async () => {
    const group = { ...testGroup, containerConfig: undefined };
    const args = await spawnArgsFor(group);
    const env = envArgs(args);
    expect(env.NO_PROXY).toBe('localhost,127.0.0.1,host.docker.internal');
    expect(env.no_proxy).toBe('localhost,127.0.0.1,host.docker.internal');
  });

  it('does not include permission mounts (old IPC removed)', async () => {
    const args = await spawnArgsFor(testGroup);
    const argsStr = args.join(' ');
    expect(argsStr).not.toContain('/ipc/permissions/requests');
    expect(argsStr).not.toContain('/ipc/permissions/responses');
  });
});

describe('container-runner IP registration', () => {
  /** Store the original exec mock so we can restore after overriding */
  let originalExecImpl: typeof exec;

  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
    vi.mocked(registerContainerGroup).mockClear();
    vi.mocked(deregisterContainerGroup).mockClear();
    originalExecImpl = vi.mocked(exec).getMockImplementation() as typeof exec;
  });

  afterEach(() => {
    // Restore the default exec mock so other describe blocks aren't affected
    if (originalExecImpl) {
      vi.mocked(exec).mockImplementation(originalExecImpl);
    }
    vi.useRealTimers();
  });

  it('always registers container IP in group registry', async () => {
    const resultPromise = runContainerAgent(testGroup, testInput, () => {});
    await vi.advanceTimersByTimeAsync(10);
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'ok',
      newSessionId: 's1',
    });
    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
    await resultPromise;

    expect(registerContainerGroup).toHaveBeenCalledWith(
      '172.19.0.2',
      expect.objectContaining({ groupFolder: testGroup.folder }),
    );
  });

  it('deregisters container IP when container exits', async () => {
    const resultPromise = runContainerAgent(testGroup, testInput, () => {});
    await vi.advanceTimersByTimeAsync(10);
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'ok',
      newSessionId: 's1',
    });
    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
    await resultPromise;

    // The close listener registered by runContainerAgent deregisters the IP
    expect(deregisterContainerGroup).toHaveBeenCalledWith('172.19.0.2');
  });

  it('throws when container IP registration fails', async () => {
    // Make exec return null IP (error on every attempt)
    vi.mocked(exec).mockImplementation(((
      _cmd: string,
      optsOrCb?: unknown,
      cb?: (err: Error | null, stdout: string, stderr: string) => void,
    ) => {
      const callback =
        typeof optsOrCb === 'function'
          ? (optsOrCb as (
              err: Error | null,
              stdout: string,
              stderr: string,
            ) => void)
          : cb;
      if (callback) {
        callback(new Error('not found'), '', '');
      }
      return new EventEmitter();
    }) as typeof exec);

    // Capture the promise and prevent unhandled rejection warnings
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
    ).catch((e: unknown) => e);
    // getContainerNetworkIp retries 5 times with increasing delays (300ms * attempt).
    // Advance timers enough to exhaust all retry delays: 0 + 300 + 600 + 900 + 1200 = 3000ms
    for (let i = 0; i < 10; i++) {
      await vi.advanceTimersByTimeAsync(500);
    }
    const error = await resultPromise;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('failed to register network IP');
  });
});

describe('container-runner timeout behavior', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('timeout after output resolves as success', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // Let IP registration resolve
    await vi.advanceTimersByTimeAsync(10);

    // Emit output with a result
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Here is my response',
      newSessionId: 'session-123',
    });

    // Let output processing settle
    await vi.advanceTimersByTimeAsync(10);

    // Fire the hard timeout (IDLE_TIMEOUT + 30s = 1830000ms)
    await vi.advanceTimersByTimeAsync(1830000);

    // Emit close event (as if container was stopped by the timeout)
    fakeProc.emit('close', 137);

    // Let the promise resolve
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(result.newSessionId).toBe('session-123');
    expect(onOutput).toHaveBeenCalledWith(
      expect.objectContaining({ result: 'Here is my response' }),
    );
  });

  it('timeout with no output resolves as error', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // Let IP registration resolve
    await vi.advanceTimersByTimeAsync(10);

    // No output emitted — fire the hard timeout
    await vi.advanceTimersByTimeAsync(1830000);

    // Emit close event
    fakeProc.emit('close', 137);

    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('error');
    expect(result.error).toContain('timed out');
    expect(onOutput).not.toHaveBeenCalled();
  });

  it('normal exit after output resolves as success', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // Let IP registration resolve
    await vi.advanceTimersByTimeAsync(10);

    // Emit output
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Done',
      newSessionId: 'session-456',
    });

    await vi.advanceTimersByTimeAsync(10);

    // Normal exit (no timeout)
    fakeProc.emit('close', 0);

    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(result.newSessionId).toBe('session-456');
  });
});

describe('agent-runner source mount', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
    vi.mocked(fs.existsSync).mockReturnValue(false);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function spawnGroup(group: RegisteredGroup): Promise<void> {
    vi.mocked(spawn).mockClear();
    const resultPromise = runContainerAgent(group, testInput, () => {});
    await vi.advanceTimersByTimeAsync(10);
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'ok',
      newSessionId: 's1',
    });
    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
    await resultPromise;
  }

  it('mounts canonical agent-runner source read-only (no per-group copy)', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);

    await spawnGroup(testGroup);

    const args = vi.mocked(spawn).mock.calls[0]?.[1] as string[];
    const joined = args.join(' ');
    // Must mount from container/agent-runner/src, not from data/sessions/*/agent-runner-src
    expect(joined).toContain('container/agent-runner/src');
    expect(joined).not.toContain('agent-runner-src:');
    // Mount must be read-only
    expect(joined).toMatch(/agent-runner\/src:[^:]*:ro/);
  });

  it('does not create per-group agent-runner-src directory', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);

    await spawnGroup(testGroup);

    // No cpSync or copyFileSync calls for agent-runner-src
    const cpCalls = vi.mocked(fs.cpSync).mock.calls;
    const runnerCopy = cpCalls.find((call) =>
      String(call[1]).includes('agent-runner-src'),
    );
    expect(runnerCopy).toBeUndefined();
  });
});
