# Fail-Closed Permission Architecture Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the fail-open permission system with a fail-closed architecture where all container traffic is gated by the credential proxy and remote MCP tools are mediated by a host-side bridge.

**Architecture:** Containers have zero network access except through the credential proxy. Remote MCP servers run on the host side, exposed to containers as stdio via Unix domain sockets. The proxy gates network requests by host; the bridge gates MCP tool calls by tool name. Both use Telegram approval with Haiku-shaped "always" rules.

**Tech Stack:** Node.js, TypeScript, Docker, Unix domain sockets, MCP JSON-RPC, Vitest

**Spec:** `docs/specs/2026-03-19-fail-closed-permission-architecture-design.md`

**Testing:** `npx vitest run --reporter=dot` (or `npx vitest run <file> --reporter=verbose` for single files)

**Build:** `npm run build` (TypeScript compilation)

**Container:** `./container/build.sh` (rebuild after agent-runner changes)

---

## File Structure

### New Files
| File | Responsibility |
|------|---------------|
| `src/mcp-bridge.ts` | Host-side MCP bridge: manages Unix socket, connects to remote MCP server over HTTP, forwards JSON-RPC, gates `tools/call` and `resources/read` via permission system |
| `src/mcp-bridge.test.ts` | Tests for MCP bridge |
| `container/agent-runner/src/bridge-client.ts` | Container-side stub: connects to Unix socket, forwards stdin/stdout |
| `test/mcp-bridge-integration.test.ts` | Integration test: bridge + permission system end-to-end |

### Modified Files
| File | Changes |
|------|---------|
| `src/container-runner.ts` | Remove `extractRemoteMcpHosts`, remove `syncAgentRunnerSource`, remove NO_PROXY MCP exemptions, remove `permissionApproval` conditional logic, add bridge spawning, add shadow `.mcp.json`, block until IP registered |
| `src/container-runner.test.ts` | Rewrite permission-related tests for always-locked-down model, add bridge spawning tests, add shadow `.mcp.json` tests |
| `src/credential-proxy.ts` | Make `approvalCallbacks` required (not optional), remove conditional CONNECT bypass |
| `src/credential-proxy.test.ts` | Update for required callbacks |
| `src/index.ts` | Remove `onPermissionRequest` callback, remove `writeMcpPermissionResponse` calls, remove file-based permission IPC, pass bridge configs to container |
| `src/ipc.ts` | Remove `onPermissionRequest` from `IpcDeps`, remove permission request scanning, remove `cleanupOrphanedPermissions` |
| `src/ipc-file-polling.test.ts` | Remove permission-related tests |
| `src/permission-rule-generator.ts` | Add `mcp` egress type examples, extend `generateRuleProposal` to accept optional `toolsList` context |
| `container/agent-runner/src/index.ts` | Remove permission hook, add `mcpBridges` to ContainerInput, configure bridge MCP servers, always `bypassPermissions`, always include Bash in allowedTools |
| `container/Dockerfile` | Add `bridge-client.ts` to source, add `/bridge` directory |

### Deleted Files
| File | Reason |
|------|--------|
| `container/agent-runner/src/permission-hook.ts` | Replaced by host-side bridge |
| `src/mcp-permission-response.ts` | No longer needed (no file-based IPC) |
| `src/mcp-permission-response.test.ts` | Tests for deleted file |
| `test/permission-hook.test.ts` | Tests for deleted file |
| `test/mcp-permission-cross-boundary.test.ts` | Tests old cross-boundary IPC |
| `test/mcp-permission-e2e.test.ts` | Tests old E2E flow (replaced by bridge integration test) |

---

## Chunk 1: Delete Old Permission System and Lock Down Containers

### Task 1: Delete file-based permission hook and IPC

Remove the old permission system entirely. This is pure deletion — no new functionality yet.

**Files:**
- Delete: `container/agent-runner/src/permission-hook.ts`
- Delete: `src/mcp-permission-response.ts`
- Delete: `src/mcp-permission-response.test.ts`
- Delete: `test/permission-hook.test.ts`
- Delete: `test/mcp-permission-cross-boundary.test.ts`
- Delete: `test/mcp-permission-e2e.test.ts`
- Modify: `container/agent-runner/src/index.ts` (remove hook import and registration)
- Modify: `src/index.ts` (remove writeMcpPermissionResponse import and calls)
- Modify: `src/ipc.ts` (remove onPermissionRequest from IpcDeps, remove permission scanning)
- Modify: `src/ipc-file-polling.test.ts` (remove permission-related tests)

- [ ] **Step 1: Delete the files**

```bash
rm container/agent-runner/src/permission-hook.ts
rm src/mcp-permission-response.ts
rm src/mcp-permission-response.test.ts
rm test/permission-hook.test.ts
rm test/mcp-permission-cross-boundary.test.ts
rm test/mcp-permission-e2e.test.ts
```

- [ ] **Step 2: Remove permission hook from agent runner**

In `container/agent-runner/src/index.ts`:
- Remove line 20: `import { createPermissionRequestHook } from './permission-hook.js';`
- Remove lines 434-436: the `PermissionRequest` hook registration in the `hooks` option
- Change line 418 `permissionMode`: always `'bypassPermissions'`
- Change line 404-416 `allowedTools`: always include `'Bash'`, remove the conditional spread
- Remove `permissionApproval` from the `ContainerInput` interface (line 31)

- [ ] **Step 3: Remove writeMcpPermissionResponse from index.ts**

In `src/index.ts`:
- Remove line 53: `import { writeMcpPermissionResponse } from './mcp-permission-response.js';`
- Remove line 568: the `writeMcpPermissionResponse` call in `onPermissionResponse`
- Remove line 679: the `writeMcpPermissionResponse` call in the `sendPermissionRequest` catch block
- Remove the entire `onPermissionRequest` callback from the IPC watcher deps (lines 651-687)

- [ ] **Step 4: Remove permission request handling from IPC watcher**

In `src/ipc.ts`:
- Remove `onPermissionRequest` from `IpcDeps` interface (lines 24-30)
- Remove `cleanupOrphanedPermissions` function (lines 37-97)
- Remove permission request file scanning in `startIpcWatcher` (lines 216-276)
- Remove the call to `cleanupOrphanedPermissions` at line 105

- [ ] **Step 5: Remove permission tests from ipc-file-polling.test.ts**

In `src/ipc-file-polling.test.ts`:
- Remove the `describe('cleanupOrphanedPermissions')` block (around line 114)
- Remove the `describe('startIpcWatcher — permission request forwarding')` block (around line 205)
- Remove `onPermissionRequest` from any remaining `makeDeps()` helpers

- [ ] **Step 6: Build and run tests**

```bash
npm run build
npx vitest run --reporter=dot
```

Expected: All tests pass. No references to deleted files remain.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor: remove file-based MCP permission system

Delete permission-hook.ts, mcp-permission-response.ts, and all
file-based permission IPC. Host-side MCP bridge will replace this."
```

---

### Task 2: Remove permissionApproval toggle — always lock down

Make every container use the locked-down network config. Remove all `permissionApproval` conditional branches.

**Files:**
- Modify: `src/container-runner.ts` (lines 189-207, 266-408, 479-496)
- Modify: `src/container-runner.test.ts`
- Modify: `src/credential-proxy.ts` (line 390)

- [ ] **Step 1: Write tests for always-locked-down containers**

In `src/container-runner.test.ts`, replace the existing permission-conditional tests. Every container should now have: nanoclaw-proxy network, cap-drop ALL, HTTP_PROXY/HTTPS_PROXY set, no-new-privileges.

Replace the `describe('container-runner spawn args')` tests that check `permissionApproval: true` vs `false`. All containers should behave like the old `permissionApproval: true`:

```typescript
it('always uses nanoclaw-proxy network', async () => {
  // Use a group WITHOUT containerConfig.permissionApproval
  const group = { ...testGroup, containerConfig: undefined };
  await spawnGroup(group);
  const args = vi.mocked(spawn).mock.calls[0]![1] as string[];
  expect(args).toContain('--network');
  expect(args).toContain('nanoclaw-proxy');
});

it('always drops all capabilities', async () => {
  const group = { ...testGroup, containerConfig: undefined };
  await spawnGroup(group);
  const args = vi.mocked(spawn).mock.calls[0]![1] as string[];
  expect(args).toContain('--cap-drop');
  expect(args).toContain('ALL');
});

it('always sets HTTP_PROXY to credential proxy', async () => {
  const group = { ...testGroup, containerConfig: undefined };
  await spawnGroup(group);
  const args = vi.mocked(spawn).mock.calls[0]![1] as string[];
  const joined = args.join(' ');
  expect(joined).toMatch(/HTTP_PROXY=http:\/\//);
  expect(joined).toMatch(/HTTPS_PROXY=http:\/\//);
});
```

- [ ] **Step 2: Run tests — expect failures**

```bash
npx vitest run src/container-runner.test.ts --reporter=verbose
```

Expected: New tests fail because `buildContainerArgs` still checks `permissionApproval`.

- [ ] **Step 3: Remove permissionApproval conditionals from container-runner.ts**

In `buildContainerArgs` (line 266):
- Remove `permissionApproval` parameter entirely
- Remove all `if (permissionApproval)` conditionals — make their body unconditional
- The function always drops caps, always uses nanoclaw-proxy, always sets proxy env vars

In `buildVolumeMounts` (line 64):
- Remove `if (group.containerConfig?.permissionApproval)` guard around permission mount dirs (lines 189-207) — but note: these mounts are for the OLD permission system. Since we deleted permission-hook.ts in Task 1, these mounts are no longer needed. **Remove the entire block.**

In `runContainerAgent` (line 424):
- Remove `group.containerConfig?.permissionApproval ?? false` from `buildContainerArgs` call (line 442) — just remove the parameter
- The IP registration block (lines 479-496) should become unconditional — always register, and **block** instead of fire-and-forget

- [ ] **Step 4: Make IP registration blocking**

In `runContainerAgent`, replace the fire-and-forget IP registration (line 481 `void (async () => {`) with a blocking await before writing stdin:

```typescript
// Register container IP — MUST succeed before agent starts
const containerIp = await getContainerNetworkIp(containerName);
if (!containerIp) {
  logger.error({ containerName }, 'Failed to get container IP — agent cannot use network');
  // Kill the container since it can't work without network identity
  try { execSync(`docker kill ${containerName}`, { stdio: 'ignore' }); } catch { /* ignore */ }
  throw new Error(`Container ${containerName} failed to register network IP`);
}
registerContainerGroup(containerIp, { groupFolder: group.folder, chatJid: input.chatJid });
container.once('close', () => deregisterContainerGroup(containerIp));
```

- [ ] **Step 5: Make approvalCallbacks required in credential-proxy.ts**

In `src/credential-proxy.ts`:
- Change `startCredentialProxy` signature: `approvalCallbacks` is no longer optional (line 245)
- Remove line 390 CONNECT bypass: `if (isAnthropicConnect || !approvalCallbacks)` → just `if (isAnthropicConnect)`
- Remove the `!approvalCallbacks` check in HTTP handler similarly

- [ ] **Step 6: Remove NO_PROXY MCP exemptions**

In `buildContainerArgs`:
- Remove `remoteMcpHosts` parameter
- Remove the logic that adds MCP hostnames to NO_PROXY (around lines 365-371)
- NO_PROXY should be just `localhost,127.0.0.1,host.docker.internal` (host.docker.internal must remain so containers can reach the credential proxy)

In `runContainerAgent`:
- Remove `extractRemoteMcpHosts` call (line 438)
- Remove `remoteMcpHosts` from `buildContainerArgs` call

- [ ] **Step 7: Delete extractRemoteMcpHosts and syncAgentRunnerSource**

These functions are no longer used:
- Delete `extractRemoteMcpHosts` (lines 243-264)
- Delete `syncAgentRunnerSource` and `SECURITY_CRITICAL_FILES` if still present

Remove their tests from `container-runner.test.ts`:
- Delete `describe('extractRemoteMcpHosts')` block
- Delete `describe('buildContainerArgs with remote MCP hosts in NO_PROXY')` block

- [ ] **Step 8: Update remaining container-runner tests**

Remove or update tests that reference:
- `permissionApproval: true` / `false` conditionals
- Permission volume mounts (old IPC dirs)
- `extractRemoteMcpHosts`
- NO_PROXY with MCP hosts

Add test: IP registration failure throws error:
```typescript
it('throws when container IP registration fails', async () => {
  vi.mocked(getContainerNetworkIp).mockResolvedValue(null);
  await expect(runContainerAgent(testGroup, testInput, () => {}))
    .rejects.toThrow('failed to register network IP');
});
```

- [ ] **Step 9: Build and run all tests**

```bash
npm run build
npx vitest run --reporter=dot
```

Expected: All tests pass.

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "refactor: remove permissionApproval toggle — all containers locked down

Every container now uses nanoclaw-proxy network, drops all caps,
routes through credential proxy. IP registration blocks startup.
No more per-group security opt-in."
```

---

## Chunk 2: Bridge Client and Host-Side MCP Bridge

### Task 3: Build the bridge client (container side)

Minimal stdio-to-Unix-socket forwarder. Baked into the container image.

**Files:**
- Create: `container/agent-runner/src/bridge-client.ts`
- Modify: `container/Dockerfile` (add `/bridge` dir)

- [ ] **Step 1: Write bridge-client.ts**

```typescript
/**
 * MCP Bridge Client — runs inside container.
 * Connects to a Unix domain socket (host-side bridge) and
 * forwards stdin/stdout bidirectionally.
 *
 * Usage: node bridge-client.js /bridge/vercel.sock
 */
import net from 'node:net';

const socketPath = process.argv[2];
if (!socketPath) {
  process.stderr.write('Usage: bridge-client <socket-path>\n');
  process.exit(1);
}

const socket = net.createConnection(socketPath);

socket.on('connect', () => {
  process.stdin.pipe(socket);
  socket.pipe(process.stdout);
});

socket.on('error', (err) => {
  process.stderr.write(`Bridge client error: ${err.message}\n`);
  process.exit(1);
});

socket.on('close', () => {
  process.exit(0);
});

process.stdin.on('end', () => {
  socket.end();
});
```

- [ ] **Step 2: Add /bridge directory to Dockerfile**

In `container/Dockerfile`, add after the existing directory creation:
```dockerfile
RUN mkdir -p /bridge
```

The `bridge-client.ts` is already in `container/agent-runner/src/` which gets compiled by the entrypoint's `npx tsc`. No additional COPY needed.

- [ ] **Step 3: Build container to verify**

```bash
./container/build.sh
```

Expected: Build succeeds. `bridge-client.js` exists in compiled output.

- [ ] **Step 4: Commit**

```bash
git add container/agent-runner/src/bridge-client.ts container/Dockerfile
git commit -m "feat: add MCP bridge client stub for container-side socket forwarding"
```

---

### Task 4: Build the host-side MCP bridge

Core new component. Manages Unix socket, connects to remote MCP server, forwards JSON-RPC with permission gating.

**Files:**
- Create: `src/mcp-bridge.ts`
- Create: `src/mcp-bridge.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/mcp-bridge.test.ts`. Test the bridge's permission gating logic without real network connections. Mock the HTTP MCP client and permission system.

```typescript
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

vi.mock('./permission-rule-engine/rule-engine.js', () => ({
  checkPermissionRule: vi.fn().mockReturnValue(undefined),
}));

import { checkPermissionRule } from './permission-rule-engine/rule-engine.js';
import {
  createMcpBridge,
  type McpBridgeDeps,
  type BridgeConfig,
} from './mcp-bridge.js';

function makeDeps(overrides?: Partial<McpBridgeDeps>): McpBridgeDeps {
  return {
    sendPermissionRequest: vi.fn().mockResolvedValue(42),
    onPermissionResponse: vi.fn(),
    groupFolder: 'test-group',
    chatJid: 'tg:123',
    ...overrides,
  };
}

const testConfig: BridgeConfig = {
  name: 'vercel',
  url: 'https://mcp.vercel.com',
  headers: { Authorization: 'Bearer test-token' },
};

describe('MCP bridge permission gating', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('auto-allows tools/list without permission check', async () => {
    const bridge = createMcpBridge(testConfig, makeDeps());
    const response = await bridge.handleJsonRpc({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: {},
    });
    expect(checkPermissionRule).not.toHaveBeenCalled();
    // Response should be forwarded from upstream (mocked)
  });

  it('auto-allows initialize without permission check', async () => {
    const bridge = createMcpBridge(testConfig, makeDeps());
    const response = await bridge.handleJsonRpc({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {},
    });
    expect(checkPermissionRule).not.toHaveBeenCalled();
  });

  it('checks permission for tools/call', async () => {
    vi.mocked(checkPermissionRule).mockReturnValue('allow');
    const bridge = createMcpBridge(testConfig, makeDeps());
    await bridge.handleJsonRpc({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'list_teams', arguments: {} },
    });
    expect(checkPermissionRule).toHaveBeenCalledWith(
      'mcp',
      'mcp__vercel__list_teams',
      'test-group',
    );
  });

  it('checks permission for resources/read', async () => {
    vi.mocked(checkPermissionRule).mockReturnValue('allow');
    const bridge = createMcpBridge(testConfig, makeDeps());
    await bridge.handleJsonRpc({
      jsonrpc: '2.0',
      id: 1,
      method: 'resources/read',
      params: { uri: 'file:///config.json' },
    });
    expect(checkPermissionRule).toHaveBeenCalled();
  });

  it('returns JSON-RPC error when permission denied by rule', async () => {
    vi.mocked(checkPermissionRule).mockReturnValue('deny');
    const bridge = createMcpBridge(testConfig, makeDeps());
    const response = await bridge.handleJsonRpc({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'deploy', arguments: {} },
    });
    expect(response).toEqual({
      jsonrpc: '2.0',
      id: 1,
      error: { code: -32600, message: expect.stringContaining('denied') },
    });
  });

  it('sends Telegram approval when no rule matches', async () => {
    vi.mocked(checkPermissionRule).mockReturnValue(undefined);
    const deps = makeDeps();
    const bridge = createMcpBridge(testConfig, deps);
    // Simulate approval in background
    vi.mocked(deps.sendPermissionRequest).mockImplementation(async (req) => {
      setTimeout(() => bridge.resolvePermission(req.requestId, 'once'), 10);
      return 42;
    });
    const response = await bridge.handleJsonRpc({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'list_teams', arguments: {} },
    });
    expect(deps.sendPermissionRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        egressType: 'mcp',
        subject: 'mcp__vercel__list_teams',
      }),
    );
  });

  it('constructs MCP tool subject as mcp__{server}__{tool}', async () => {
    vi.mocked(checkPermissionRule).mockReturnValue('allow');
    const bridge = createMcpBridge(
      { ...testConfig, name: 'github' },
      makeDeps(),
    );
    await bridge.handleJsonRpc({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'create_issue', arguments: { title: 'Bug' } },
    });
    expect(checkPermissionRule).toHaveBeenCalledWith(
      'mcp',
      'mcp__github__create_issue',
      'test-group',
    );
  });
});
```

- [ ] **Step 2: Run tests — expect failures**

```bash
npx vitest run src/mcp-bridge.test.ts --reporter=verbose
```

Expected: Cannot find module `./mcp-bridge.js`.

- [ ] **Step 3: Implement mcp-bridge.ts**

Create `src/mcp-bridge.ts`:

```typescript
/**
 * Host-side MCP Bridge.
 *
 * Manages a Unix domain socket for container communication and
 * an HTTP/SSE connection to the real remote MCP server.
 * Gates tools/call and resources/read via the permission system.
 */
import net from 'node:net';
import fs from 'node:fs';
import { logger } from './logger.js';
import { checkPermissionRule } from './permission-rule-engine/rule-engine.js';
import { generateRuleProposal } from './permission-rule-generator.js';
import type { PermissionRequest } from './credential-proxy.js';
// NOTE: Extend PermissionRequest in credential-proxy.ts to add:
//   toolInput?: unknown;  // MCP tool arguments, shown in Telegram message

export interface BridgeConfig {
  name: string;
  url: string;
  headers?: Record<string, string>;
}

export interface McpBridgeDeps {
  sendPermissionRequest: (req: PermissionRequest) => Promise<number | null>;
  onPermissionResponse: (requestId: string, decision: string) => void;
  groupFolder: string;
  chatJid: string;
}

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string };
}

interface PendingPermission {
  resolve: (decision: 'allow' | 'deny') => void;
  timeout: ReturnType<typeof setTimeout>;
}

const AUTO_ALLOW_METHODS = new Set([
  'initialize',
  'ping',
  'tools/list',
  'resources/list',
  'prompts/list',
  'prompts/get',
  'notifications/initialized',
]);

const GATED_METHODS = new Set(['tools/call', 'resources/read']);

const PERMISSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

export interface McpBridge {
  handleJsonRpc: (request: JsonRpcRequest) => Promise<JsonRpcResponse>;
  resolvePermission: (requestId: string, decision: string) => void;
  /** Start listening on a Unix socket. Returns cleanup function. */
  listen: (socketPath: string) => Promise<() => void>;
  /** Cached tools list from handshake (for Haiku context). Uses getter for live binding. */
  readonly toolsList: unknown[] | null;
}

export function createMcpBridge(
  config: BridgeConfig,
  deps: McpBridgeDeps,
): McpBridge {
  const pendingPermissions = new Map<string, PendingPermission>();
  let toolsList: unknown[] | null = null;

  function resolvePermission(requestId: string, decision: string): void {
    const pending = pendingPermissions.get(requestId);
    if (!pending) return;
    clearTimeout(pending.timeout);
    pendingPermissions.delete(requestId);
    pending.resolve(decision === 'deny' ? 'deny' : 'allow');
  }

  function buildSubject(method: string, params: Record<string, unknown>): string {
    if (method === 'tools/call') {
      const toolName = params.name as string;
      return `mcp__${config.name}__${toolName}`;
    }
    if (method === 'resources/read') {
      const uri = params.uri as string;
      return `mcp__${config.name}__resource:${uri}`;
    }
    return `mcp__${config.name}__${method}`;
  }

  async function checkPermission(
    method: string,
    params: Record<string, unknown>,
  ): Promise<'allow' | 'deny'> {
    const subject = buildSubject(method, params);

    // Check rule engine first
    const ruleDecision = checkPermissionRule('mcp', subject, deps.groupFolder);
    if (ruleDecision) return ruleDecision;

    // No rule match — send Telegram approval
    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    // Generate Haiku rule proposal eagerly (before sending Telegram message)
    const proposal = await generateRuleProposal('mcp', subject, toolsList);

    const decisionPromise = new Promise<'allow' | 'deny'>((resolve) => {
      const timeout = setTimeout(() => {
        pendingPermissions.delete(requestId);
        resolve('deny');
      }, PERMISSION_TIMEOUT_MS);
      pendingPermissions.set(requestId, { resolve, timeout });
    });

    try {
      await deps.sendPermissionRequest({
        requestId,
        egressType: 'mcp',
        subject,
        groupFolder: deps.groupFolder,
        chatJid: deps.chatJid,
        proposal,
        toolInput: method === 'tools/call' ? params.arguments : params,
      });
    } catch (err) {
      logger.error({ requestId, err }, 'Failed to send MCP permission request');
      resolvePermission(requestId, 'deny');
    }

    return decisionPromise;
  }

  async function forwardToUpstream(request: JsonRpcRequest): Promise<JsonRpcResponse> {
    // TODO Task 5: implement HTTP/SSE forwarding to remote MCP server
    // For now, return a placeholder error
    return {
      jsonrpc: '2.0',
      id: request.id,
      error: { code: -32603, message: 'Upstream forwarding not yet implemented' },
    };
  }

  async function handleJsonRpc(request: JsonRpcRequest): Promise<JsonRpcResponse> {
    const { method, params } = request;

    // Auto-allow safe methods
    if (AUTO_ALLOW_METHODS.has(method)) {
      const response = await forwardToUpstream(request);
      // Cache tools list for Haiku context
      if (method === 'tools/list' && response.result) {
        const result = response.result as { tools?: unknown[] };
        toolsList = result.tools ?? null;
      }
      return response;
    }

    // Gate tools/call and resources/read
    if (GATED_METHODS.has(method)) {
      const decision = await checkPermission(method, (params ?? {}) as Record<string, unknown>);
      if (decision === 'deny') {
        return {
          jsonrpc: '2.0',
          id: request.id,
          error: { code: -32600, message: `Permission denied: ${buildSubject(method, (params ?? {}) as Record<string, unknown>)}` },
        };
      }
      return forwardToUpstream(request);
    }

    // Unknown methods — forward without gating
    return forwardToUpstream(request);
  }

  async function listen(socketPath: string): Promise<() => void> {
    // Clean up stale socket
    try { fs.unlinkSync(socketPath); } catch { /* ignore */ }

    const server = net.createServer((conn) => {
      let buffer = '';
      let processing = false;
      const pendingLines: string[] = [];

      async function processLine(line: string): Promise<void> {
        try {
          const request = JSON.parse(line) as JsonRpcRequest;
          const response = await handleJsonRpc(request);
          conn.write(JSON.stringify(response) + '\n');
        } catch (err) {
          logger.error({ err }, 'Bridge: failed to process JSON-RPC message');
        }
      }

      async function drain(): Promise<void> {
        if (processing) return;
        processing = true;
        while (pendingLines.length > 0) {
          await processLine(pendingLines.shift()!);
        }
        processing = false;
      }

      conn.on('data', (chunk) => {
        buffer += chunk.toString();
        // JSON-RPC messages are newline-delimited
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.trim()) continue;
          pendingLines.push(line);
        }
        void drain();
      });
    });

    await new Promise<void>((resolve, reject) => {
      server.on('error', reject);
      server.listen(socketPath, resolve);
    });

    logger.info({ name: config.name, socketPath }, 'MCP bridge listening');

    return () => {
      server.close();
      try { fs.unlinkSync(socketPath); } catch { /* ignore */ }
      // Clear pending permissions
      for (const [id, pending] of pendingPermissions) {
        clearTimeout(pending.timeout);
        pending.resolve('deny');
      }
      pendingPermissions.clear();
    };
  }

  return {
    handleJsonRpc,
    resolvePermission,
    listen,
    get toolsList() { return toolsList; },
  };
}
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run src/mcp-bridge.test.ts --reporter=verbose
```

Expected: All tests pass.

- [ ] **Step 5: Add more edge case tests**

Add to `src/mcp-bridge.test.ts`:

```typescript
it('returns deny on permission timeout', async () => {
  vi.useFakeTimers();
  vi.mocked(checkPermissionRule).mockReturnValue(undefined);
  const deps = makeDeps();
  vi.mocked(deps.sendPermissionRequest).mockResolvedValue(42);
  const bridge = createMcpBridge(testConfig, deps);

  const resultPromise = bridge.handleJsonRpc({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'deploy', arguments: {} },
  });

  await vi.advanceTimersByTimeAsync(30 * 60 * 1000 + 1);
  const response = await resultPromise;
  expect(response.error?.message).toContain('denied');
  vi.useRealTimers();
});

it('returns deny when sendPermissionRequest throws', async () => {
  vi.mocked(checkPermissionRule).mockReturnValue(undefined);
  const deps = makeDeps();
  vi.mocked(deps.sendPermissionRequest).mockRejectedValue(
    new Error('Telegram API error'),
  );
  const bridge = createMcpBridge(testConfig, deps);
  const response = await bridge.handleJsonRpc({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'deploy', arguments: {} },
  });
  expect(response.error?.message).toContain('denied');
});

it('forwards unknown methods without permission check', async () => {
  const bridge = createMcpBridge(testConfig, makeDeps());
  const response = await bridge.handleJsonRpc({
    jsonrpc: '2.0',
    id: 1,
    method: 'custom/method',
    params: {},
  });
  expect(checkPermissionRule).not.toHaveBeenCalled();
});
```

- [ ] **Step 6: Run tests, build**

```bash
npx vitest run src/mcp-bridge.test.ts --reporter=verbose
npm run build
```

- [ ] **Step 7: Commit**

```bash
git add src/mcp-bridge.ts src/mcp-bridge.test.ts
git commit -m "feat: add host-side MCP bridge with permission gating

Gates tools/call and resources/read via rule engine + Telegram approval.
Auto-allows discovery methods. Upstream HTTP forwarding is a TODO."
```

---

### Task 5: Implement upstream HTTP/SSE forwarding in the bridge

Connect the bridge to the actual remote MCP server over HTTP.

**Files:**
- Modify: `src/mcp-bridge.ts` (replace `forwardToUpstream` placeholder)

- [ ] **Step 1: Write integration test with a fake MCP server**

Create `test/mcp-bridge-integration.test.ts`:

```typescript
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

vi.mock('../src/permission-rule-engine/rule-engine.js', () => ({
  checkPermissionRule: vi.fn().mockReturnValue('allow'),
}));

vi.mock('../src/permission-rule-generator.js', () => ({
  generateRuleProposal: vi.fn().mockResolvedValue(null),
}));

import { createMcpBridge, type McpBridgeDeps } from '../src/mcp-bridge.js';

let fakeServer: http.Server;
let fakePort: number;
let lastRequestBody: string;

beforeEach(async () => {
  lastRequestBody = '';
  fakeServer = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      lastRequestBody = Buffer.concat(chunks).toString();
      const parsed = JSON.parse(lastRequestBody);
      // Echo back a tools/list response or generic result
      if (parsed.method === 'tools/list') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          id: parsed.id,
          result: { tools: [{ name: 'list_teams' }, { name: 'deploy' }] },
        }));
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          id: parsed.id,
          result: { ok: true },
        }));
      }
    });
  });
  await new Promise<void>((resolve) =>
    fakeServer.listen(0, '127.0.0.1', resolve),
  );
  fakePort = (fakeServer.address() as AddressInfo).port;
});

afterEach(async () => {
  await new Promise<void>((r) => fakeServer?.close(() => r()));
});

describe('MCP bridge upstream forwarding', () => {
  it('forwards tools/list to upstream and returns result', async () => {
    const bridge = createMcpBridge(
      { name: 'test', url: `http://127.0.0.1:${fakePort}`, headers: {} },
      {
        sendPermissionRequest: vi.fn().mockResolvedValue(42),
        onPermissionResponse: vi.fn(),
        groupFolder: 'test',
        chatJid: 'tg:123',
      },
    );
    const response = await bridge.handleJsonRpc({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: {},
    });
    expect(response.result).toEqual({
      tools: [{ name: 'list_teams' }, { name: 'deploy' }],
    });
  });

  it('injects auth headers from config', async () => {
    let capturedHeaders: http.IncomingHttpHeaders = {};
    fakeServer.removeAllListeners('request');
    fakeServer.on('request', (req, res) => {
      capturedHeaders = { ...req.headers };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }));
    });

    const bridge = createMcpBridge(
      {
        name: 'test',
        url: `http://127.0.0.1:${fakePort}`,
        headers: { Authorization: 'Bearer secret-token' },
      },
      {
        sendPermissionRequest: vi.fn().mockResolvedValue(42),
        onPermissionResponse: vi.fn(),
        groupFolder: 'test',
        chatJid: 'tg:123',
      },
    );
    await bridge.handleJsonRpc({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {},
    });
    expect(capturedHeaders.authorization).toBe('Bearer secret-token');
  });

  it('caches tools list from tools/list response', async () => {
    const bridge = createMcpBridge(
      { name: 'test', url: `http://127.0.0.1:${fakePort}`, headers: {} },
      {
        sendPermissionRequest: vi.fn().mockResolvedValue(42),
        onPermissionResponse: vi.fn(),
        groupFolder: 'test',
        chatJid: 'tg:123',
      },
    );
    await bridge.handleJsonRpc({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: {},
    });
    expect(bridge.toolsList).toEqual([
      { name: 'list_teams' },
      { name: 'deploy' },
    ]);
  });

  it('returns 502-like error when upstream is unreachable', async () => {
    const bridge = createMcpBridge(
      { name: 'test', url: 'http://127.0.0.1:59999', headers: {} },
      {
        sendPermissionRequest: vi.fn().mockResolvedValue(42),
        onPermissionResponse: vi.fn(),
        groupFolder: 'test',
        chatJid: 'tg:123',
      },
    );
    const response = await bridge.handleJsonRpc({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {},
    });
    expect(response.error).toBeDefined();
    expect(response.error?.code).toBe(-32603);
  });
});
```

- [ ] **Step 2: Run tests — expect some failures**

```bash
npx vitest run test/mcp-bridge-integration.test.ts --reporter=verbose
```

Expected: Fails because `forwardToUpstream` returns placeholder error.

- [ ] **Step 3: Implement forwardToUpstream**

In `src/mcp-bridge.ts`, replace the placeholder `forwardToUpstream` function with real HTTP forwarding:

```typescript
async function forwardToUpstream(request: JsonRpcRequest): Promise<JsonRpcResponse> {
  const url = new URL(config.url);
  const body = JSON.stringify(request);

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body).toString(),
    ...config.headers,
  };

  return new Promise<JsonRpcResponse>((resolve) => {
    // Import both at top of file: import http from 'node:http'; import https from 'node:https';
    const proto = url.protocol === 'https:' ? https : http;
    const req = proto.request(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname,
        method: 'POST',
        headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          try {
            const responseBody = Buffer.concat(chunks).toString();
            resolve(JSON.parse(responseBody) as JsonRpcResponse);
          } catch (err) {
            resolve({
              jsonrpc: '2.0',
              id: request.id,
              error: { code: -32603, message: `Invalid upstream response` },
            });
          }
        });
      },
    );
    req.on('error', (err: Error) => {
      resolve({
        jsonrpc: '2.0',
        id: request.id,
        error: { code: -32603, message: `Upstream error: ${err.message}` },
      });
    });
    req.write(body);
    req.end();
  });
}
```

Note: Use dynamic require for `http`/`https` based on protocol. In the actual implementation, use proper imports and handle this cleanly.

- [ ] **Step 4: Run all bridge tests**

```bash
npx vitest run src/mcp-bridge.test.ts test/mcp-bridge-integration.test.ts --reporter=verbose
```

Expected: All pass.

- [ ] **Step 5: Commit**

```bash
git add src/mcp-bridge.ts test/mcp-bridge-integration.test.ts
git commit -m "feat: implement upstream HTTP forwarding in MCP bridge

Bridge now forwards JSON-RPC to remote MCP servers over HTTP,
injects auth headers, and caches tools list for Haiku context."
```

---

## Chunk 3: Wire Bridge Into Container Runner

### Task 6: Extend generateRuleProposal for MCP with tools list context

**Files:**
- Modify: `src/permission-rule-generator.ts`

- [ ] **Step 1: Write failing test**

Add test in existing test file or create `src/permission-rule-generator.test.ts` if none exists. Test that the MCP prompt includes tools list context when provided.

- [ ] **Step 2: Extend generateRuleProposal signature**

Change from `generateRuleProposal(egressType, subject)` to `generateRuleProposal(egressType, subject, toolsList?)`.

When `toolsList` is provided, append it to the Haiku prompt:
```
Available tools on this MCP server:
- list_teams (read-only)
- list_deployments (read-only)
- deploy (creates deployment)
- delete_project (destructive)
```

- [ ] **Step 3: Run tests, build, commit**

```bash
npx vitest run --reporter=dot
npm run build
git add src/permission-rule-generator.ts
git commit -m "feat: extend Haiku rule generator with MCP tools list context"
```

---

### Task 7: Wire bridges into container-runner.ts

Read `.mcp.json`, spawn bridges, generate shadow config, pass bridge configs to container.

**Files:**
- Modify: `src/container-runner.ts`
- Modify: `src/container-runner.test.ts`
- Modify: `container/agent-runner/src/index.ts`

- [ ] **Step 1: Write failing tests for .mcp.json splitting**

```typescript
describe('MCP bridge setup', () => {
  it('identifies remote servers from .mcp.json', () => {
    // Test that parseGroupMcpConfig correctly splits remote vs local servers
  });

  it('generates shadow .mcp.json with only local servers', () => {
    // Test shadow generation
  });

  it('passes bridge configs through container input', () => {
    // Test that stdin JSON includes mcpBridges array
  });
});
```

- [ ] **Step 2: Implement parseGroupMcpConfig**

Add to `src/container-runner.ts`:

```typescript
interface McpServerConfig {
  command?: string;
  args?: string[];
  url?: string;
  type?: string;
  headers?: Record<string, string>;
}

interface McpConfig {
  mcpServers?: Record<string, McpServerConfig>;
}

interface ParsedMcpConfig {
  localServers: Record<string, McpServerConfig>;
  remoteServers: Record<string, { url: string; headers?: Record<string, string> }>;
}

export function parseGroupMcpConfig(groupDir: string): ParsedMcpConfig {
  const mcpJsonPath = path.join(groupDir, '.mcp.json');
  const result: ParsedMcpConfig = { localServers: {}, remoteServers: {} };

  try {
    if (!fs.existsSync(mcpJsonPath)) return result;
    const config = JSON.parse(fs.readFileSync(mcpJsonPath, 'utf-8')) as McpConfig;
    if (!config.mcpServers) return result;

    for (const [name, server] of Object.entries(config.mcpServers)) {
      if (server.url || server.type === 'http') {
        result.remoteServers[name] = {
          url: server.url!,
          headers: server.headers,
        };
      } else {
        result.localServers[name] = server;
      }
    }
  } catch (err) {
    logger.warn({ groupDir, err }, 'Failed to parse .mcp.json');
  }

  return result;
}
```

- [ ] **Step 3: Implement shadow .mcp.json generation and bridge mount**

In `buildVolumeMounts`, after parsing MCP config:
- Write shadow `.mcp.json` (local servers only) to a temp file
- Mount shadow over `/workspace/group/.mcp.json` (read-only)
- Mount `/bridge` directory for socket files

- [ ] **Step 4: Wire bridge spawning in runContainerAgent**

Before spawning the container:
1. Parse MCP config
2. For each remote server, create bridge via `createMcpBridge`
3. Call `bridge.listen(socketPath)` for each
4. Pass bridge configs in container input:
   ```typescript
   input.mcpBridges = Object.keys(remoteServers).map(name => ({
     name,
     command: 'node',
     args: ['/tmp/dist/bridge-client.js', `/bridge/${name}.sock`],
   }));
   ```

- [ ] **Step 5: Update agent runner to configure bridge MCP servers**

In `container/agent-runner/src/index.ts`:
- Add `mcpBridges` to `ContainerInput` interface
- In `runQuery`, add bridge servers to `mcpServers` option:
  ```typescript
  mcpServers: {
    nanoclaw: { command: 'node', args: [mcpServerPath], env: {...} },
    ...(containerInput.mcpBridges ?? []).reduce((acc, b) => {
      acc[b.name] = { command: b.command, args: b.args };
      return acc;
    }, {} as Record<string, { command: string; args: string[] }>),
  },
  ```

- [ ] **Step 6: Run all tests**

```bash
npm run build
npx vitest run --reporter=dot
```

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: wire MCP bridges into container runner

Parse .mcp.json, spawn host-side bridges for remote servers,
shadow .mcp.json to hide remote configs, pass bridge stdio
configs to container agent runner."
```

---

### Task 8: Wire bridge permission responses to Telegram

Connect the bridge's `resolvePermission` to the Telegram callback system. This is the critical integration glue — Telegram callbacks need to find the right bridge for a given `requestId`.

**Files:**
- Modify: `src/index.ts`
- Modify: `src/credential-proxy.ts` (extend `handleProxyPermissionResponse` to also check bridge registry)
- Modify: `src/container-runner.ts` (pass bridge deps, return bridge handles)

- [ ] **Step 1: Create a unified permission response registry**

The proxy already has `pendingPermissions` (Map keyed by requestId). Bridges each have their own `pendingPermissions`. When a Telegram callback fires, we need to route to the right one.

**Approach:** Create a simple registry in `src/credential-proxy.ts` that both the proxy and bridges register into:

```typescript
// In credential-proxy.ts — add a global registry
const permissionResolvers = new Map<string, (decision: string) => void>();

export function registerPermissionResolver(
  requestId: string,
  resolver: (decision: string) => void,
): void {
  permissionResolvers.set(requestId, resolver);
}

export function handlePermissionResponse(requestId: string, decision: string): void {
  const resolver = permissionResolvers.get(requestId);
  if (!resolver) {
    logger.warn({ requestId }, 'No resolver found for permission response');
    return;
  }
  permissionResolvers.delete(requestId);

  // If 'always', persist rule (same logic as existing handleProxyPermissionResponse)
  if (decision === 'always') {
    // Retrieve pending request metadata to build the rule
    // (stored when registerPermissionResolver was called)
    persistAlwaysRule(requestId, decision);
  }

  resolver(decision);
}
```

Both the proxy's `checkWithApproval` and the bridge's `checkPermission` register their resolvers here using `registerPermissionResolver`. The existing `handleProxyPermissionResponse` becomes a thin wrapper around `handlePermissionResponse`.

- [ ] **Step 2: Update bridge to use the registry**

In `src/mcp-bridge.ts`, instead of managing its own `pendingPermissions` Map, import and use `registerPermissionResolver`:

```typescript
import { registerPermissionResolver } from './credential-proxy.js';

// In checkPermission:
const decisionPromise = new Promise<'allow' | 'deny'>((resolve) => {
  const timeout = setTimeout(() => {
    resolve('deny');
  }, PERMISSION_TIMEOUT_MS);

  registerPermissionResolver(requestId, (decision) => {
    clearTimeout(timeout);
    resolve(decision === 'deny' ? 'deny' : 'allow');
  });
});
```

Remove the bridge's internal `pendingPermissions` Map and `resolvePermission` method — they're replaced by the global registry.

- [ ] **Step 3: Wire sendPermissionRequest through container runner**

In `src/container-runner.ts`, the bridge deps need `sendPermissionRequest`. This should be passed from `src/index.ts`:

```typescript
// In runContainerAgent, add a bridgeDeps parameter:
export interface BridgePermissionDeps {
  sendPermissionRequest: (req: PermissionRequest) => Promise<number | null>;
}

// When creating bridges:
const bridge = createMcpBridge(
  { name, url, headers },
  {
    sendPermissionRequest: bridgeDeps.sendPermissionRequest,
    groupFolder: group.folder,
    chatJid: input.chatJid,
  },
);
```

In `src/index.ts`, pass the channel's `sendPermissionRequest` through:

```typescript
const output = await runContainerAgent(
  group,
  { prompt, sessionId, ... },
  (proc, containerName) => queue.registerProcess(...),
  wrappedOnOutput,
  {
    sendPermissionRequest: async (req) => {
      const channel = findChannel(channels, chatJid);
      if (!channel?.sendPermissionRequest) return null;
      return channel.sendPermissionRequest(req);
    },
  },
);
```

- [ ] **Step 4: Update Telegram callback to use unified handler**

In `src/index.ts`, the `onPermissionResponse` callback (currently in `channelOpts`) should call `handlePermissionResponse` instead of separate proxy and MCP response handlers:

```typescript
onPermissionResponse: (requestId: string, decision: string) => {
  handlePermissionResponse(requestId, decision);
},
```

This single call routes to whichever resolver registered that requestId — proxy or bridge.

- [ ] **Step 5: Write tests**

Test the unified registry:

```typescript
describe('unified permission response routing', () => {
  it('routes response to proxy resolver', () => {
    let resolved = '';
    registerPermissionResolver('proxy-req-1', (d) => { resolved = d; });
    handlePermissionResponse('proxy-req-1', 'once');
    expect(resolved).toBe('once');
  });

  it('routes response to bridge resolver', () => {
    let resolved = '';
    registerPermissionResolver('bridge-req-1', (d) => { resolved = d; });
    handlePermissionResponse('bridge-req-1', 'deny');
    expect(resolved).toBe('deny');
  });

  it('logs warning for unknown requestId', () => {
    handlePermissionResponse('unknown-id', 'once');
    // expect logger.warn to have been called
  });
});
```

- [ ] **Step 6: Add bridge cleanup test**

Test that bridge cleanup is called when container exits:

```typescript
it('calls bridge cleanup when container exits', async () => {
  const cleanupFn = vi.fn();
  // Mock bridge.listen to return cleanup function
  // Verify cleanupFn is called when container process emits 'close'
});
```

- [ ] **Step 7: Run all tests, build**

```bash
npm run build
npx vitest run --reporter=dot
```

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat: wire MCP bridge permissions to Telegram approval flow

Unified permission response registry routes Telegram callbacks to
both proxy and bridge resolvers. Bridge permission requests appear
in Telegram with Once/Always/Deny buttons.
Haiku shapes 'Always' rules with full tools list context."
```

---

## Chunk 4: Cleanup and Rebuild

### Task 9: Final cleanup and rebuild

- [ ] **Step 1: Remove any remaining references to old permission system**

Search for and remove:
```bash
grep -r 'permissionApproval' src/ container/ --include='*.ts' -l
grep -r 'permission-hook' src/ container/ --include='*.ts' -l
grep -r 'mcp-permission-response' src/ --include='*.ts' -l
grep -r 'onPermissionRequest' src/ --include='*.ts' -l
```

- [ ] **Step 2: Run full test suite**

```bash
npm run build
npx vitest run --reporter=dot
```

Expected: All tests pass, no broken imports.

- [ ] **Step 3: Rebuild container**

```bash
./container/build.sh
```

- [ ] **Step 4: Restart service**

```bash
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

- [ ] **Step 5: Manual verification**

1. Send a message that triggers agent in Telegram
2. First request: Anthropic API → Telegram approval appears → tap "Always"
3. Agent starts responding
4. Agent tries Vercel tool → Telegram shows "Tool: mcp__vercel__list_teams" → tap "Once"
5. Tool result appears in agent response
6. Verify no direct container→Vercel traffic in logs

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore: final cleanup of old permission system references"
```
