# Fail-Closed Permission Architecture

**Date:** 2026-03-19
**Status:** Approved design
**Project:** NanoClaw

## Problem

The permission approval system fails open in multiple ways:

1. **Remote MCP servers bypass the proxy entirely** — `extractRemoteMcpHosts` adds them to NO_PROXY so the SDK can connect. Every tool call goes directly container → remote server, completely outside the permission system.
2. **`permissionApproval` is a per-group toggle** — groups without it have unrestricted network access.
3. **TOCTOU race** — even if we gate MCP tools with a hook, approving a tool doesn't prevent a malicious background process from injecting its own request to the same host in the approval window.
4. **File-based IPC is complex and fragile** — request/response files, polling, read-only mounts, stale cache bugs.

The system should be fail-closed: zero access by default, permissions explicitly grant access.

## Design

### 1. Container Network Model

Every container gets the same locked-down network. No more `permissionApproval: true/false` toggle — security is always on.

- All containers run on `nanoclaw-proxy` bridge with `--cap-drop ALL --security-opt no-new-privileges`
- `HTTP_PROXY` / `HTTPS_PROXY` point to credential proxy — the only network exit
- `NO_PROXY` contains only `localhost,127.0.0.1` — no exemptions for MCP hosts or anything else
- iptables DROP rules block everything except DNS and the proxy port
- Container startup **blocks** until IP is registered in the proxy's group registry — fail the spawn if registration fails after retries

**Accepted risk: DNS exfiltration.** DNS queries (UDP/TCP port 53) are allowed because name resolution is required for the proxy to work. A malicious agent could encode data in DNS queries to a controlled domain. This is inherent to any system that allows DNS — blocking it breaks all networking. Acceptable for a personal assistant with sandboxed agents.

**Accepted risk: CONNECT tunnel opacity.** Once a CONNECT tunnel is approved, traffic inside is end-to-end encrypted. The proxy cannot inspect it. An approved host could theoretically relay traffic to unapproved destinations. Mitigated by Haiku's rule shaping (patterns are specific, not universal) and the fact that agents don't choose which hosts to connect to — MCP servers and SDK endpoints are predefined.

The credential proxy gates ALL outbound traffic. First request to any new host triggers Telegram approval. Anthropic API, npm registry, GitHub — all the same flow. Approve once with "always" and the rule is persisted.

### 2. Host-Side MCP Bridge

Remote MCP servers (those with `"type": "http"` or `"url"` in `.mcp.json`) never run inside the container. The host mediates all remote MCP traffic.

**On container spawn:**

1. Host reads the group's `.mcp.json` (read-only, never modified)
2. Splits it: remote servers → spawn bridges on host, local/command servers → keep as-is
3. Generates a **shadow** `.mcp.json` containing only local/command servers (temp file)
4. Mounts the shadow over the original in the container — original untouched on disk
5. Bridge configs passed through **container input** (stdin JSON) — agent runner adds them to the SDK's `mcpServers` option programmatically (same pattern as the existing `nanoclaw` MCP server)

**Bridge implementation:**

Each bridge is an in-process async function (not a separate child process) that:

- Manages a stdio pipe to the container and an HTTP/SSE connection to the real remote MCP server
- Forwards JSON-RPC messages bidirectionally
- Injects auth headers (from `.mcp.json`) on the host side — credentials never enter the container

**Permission gating in the bridge:**

- `initialize`, `ping`, `tools/list` — **auto-allow** (discovery/handshake, no side effects)
- `tools/call` — check permission rule engine:
  - Rule match → allow or deny immediately
  - No match → send Telegram message with tool name + input → block until user responds → return result or JSON-RPC error
- `resources/read` — **gated** (same as `tools/call`) — remote servers may expose sensitive data through resources
- Other read-only methods (`resources/list`, `prompts/list`, `prompts/get`) — auto-allow (metadata only, no side effects)

**Lifecycle:** Bridges are tied to the container. Spawned before container starts, torn down when container exits.

**Bridge-to-container transport:**

The SDK's `mcpServers` config expects `{ command, args }` — it spawns a child process inside the container and talks to it over stdio. The bridge runs on the host. To connect them:

- Host creates a **Unix domain socket** for each bridge, placed in a mounted directory (e.g., `/bridge/<server-name>.sock`)
- Container-side stub: a minimal script (`bridge-client.js`, baked into the container image) that connects to the socket and forwards stdin/stdout. The agent runner configures it as: `{ command: 'node', args: ['/app/bridge-client.js', '/bridge/vercel.sock'] }`
- Host-side bridge listens on the socket, forwards JSON-RPC to the remote MCP server over HTTP

This is a simple, well-understood pattern. The socket mount is the only new volume — no network access to MCP servers exists inside the container.

**Error handling:**

- Remote MCP server unreachable at spawn time: bridge logs warning, container still starts. Tool calls to that server return JSON-RPC errors. Agent sees "MCP server unavailable" — same UX as a down server.
- Remote MCP server disconnects mid-session: bridge attempts reconnect with backoff. If reconnect fails, subsequent tool calls return errors.
- Multiple containers for same group: each gets its own bridge instances (bridges are tied to container lifecycle, not group).

**Scale assumption:** Designed for single-user, low concurrency (1-3 active containers). Bridge functions run in the host's event loop. If scaling beyond ~10 concurrent groups with multiple remote MCP servers each, bridges should move to worker threads.

**Security property:** The container has zero network access to remote MCP servers. The only path for MCP tool execution is through the host-side bridge, which checks permissions before forwarding. No TOCTOU race is possible because the permission check and the execution are the same operation on the trusted side.

### 3. Credential Proxy Simplification

With remote MCP traffic removed from the container's network, the proxy's job becomes simpler.

**What the proxy does:**

- Gates HTTP and CONNECT requests by host
- `resolveGroup` maps container IP to group (blocks startup until registered — no race)
- Permission flow: rule engine check → match returns allow/deny → no match sends Telegram → blocks until response
- Auth injection: API key or OAuth token onto Anthropic API requests
- Hop-by-hop header stripping

**What gets removed:**

- `extractRemoteMcpHosts` function — no more NO_PROXY exemptions for MCP
- The entire file-based MCP permission hook (`container/agent-runner/src/permission-hook.ts`)
- Permission IPC directories, request/response file mounts
- `PermissionRequest` hook registration in the agent runner
- `writeMcpPermissionResponse` helper
- `onPermissionRequest` callback in IPC watcher
- `syncAgentRunnerSource` / `SECURITY_CRITICAL_FILES` — permission hook no longer exists in agent runner

**What stays:**

- Proxy auth injection (API key / OAuth)
- Hop-by-hop header stripping
- Container IP registration + group registry
- Permission rule engine + Telegram approval flow
- "always" / "once" / "deny" responses with rule persistence

### 4. Container Startup Sequence

Sequential, no race conditions:

1. **Read group's `.mcp.json`** — identify remote vs local MCP servers
2. **Spawn bridge functions** for each remote MCP server — each manages a stdio pipe
3. **Generate shadow `.mcp.json`** — only local/command servers, written to temp file
4. **Spawn container** on `nanoclaw-proxy` bridge with locked-down args, shadow mounted over original
5. **Register container IP** in group registry — retry with backoff, **fail the spawn** if registration fails (no silent continue)
6. **Write container input to stdin** (includes bridge MCP server configs) — agent starts

**On container exit:**

- Deregister IP from group registry
- Tear down bridge functions
- Clean up shadow `.mcp.json` temp file

### 5. Telegram Approval UX

Two types of approval, unified interface:

**Network request** (from proxy):
```
[General] Network: CONNECT registry.npmjs.org:443
[Once] [Always] [Deny]
```

**MCP tool call** (from bridge):
```
[General] Tool: mcp__vercel__list_teams
Input: {"teamId": "team_abc123"}
[Once] [Always] [Deny]
```

**"Always" uses Haiku-shaped rules (computed eagerly):**

Haiku runs **before** the Telegram message is sent, so the "Always" button shows the shaped rule on first view:

1. Permission check fires → no rule match
2. Haiku is called **immediately** with full context:
   - Egress type (`connect`, `http`, or `mcp`)
   - The specific request (host, tool name, input)
   - For MCP: the **full `tools/list`** from that server (cached from handshake) — so Haiku can see all available tools and make informed groupings
3. Haiku proposes a rule pattern:
   - Network: `*.npmjs.org:443` instead of literal `registry.npmjs.org:443`
   - MCP: `mcp__vercel__list_*` because it sees `list_teams`, `list_deployments`, `list_projects` are all read-only, vs `deploy` which is destructive
   - Scope: `global` or `group`-scoped based on context
4. Telegram message is sent with the proposal baked into the button:
   ```
   [Once] [Always: mcp__vercel__list_*] [Deny]
   ```
5. Tapping "Always" persists the pre-computed proposal — no additional delay
6. Safeguards:
   - 10s Haiku timeout — falls back to exact literal in the button label
   - Rejects near-universal wildcards (`*`, `**`, `*:*`)
   - Validates pattern still matches the original request

Both network and tool rules stored in the same `permission_rules` table, distinguished by `egress_type`.

### 6. What Changes in the Agent Runner

The agent runner (`container/agent-runner/src/index.ts`) becomes simpler:

- Remove `import { createPermissionRequestHook }` and all hook registration
- Remove `permissionApproval` from `ContainerInput` — security is always on
- Add `mcpBridges` to `ContainerInput` — array of `{ name, command, args }` for bridge stdio servers
- Agent runner adds bridge servers to `query()` options alongside the existing `nanoclaw` server
- `permissionMode` is always `'bypassPermissions'` — the SDK's built-in permission prompts are not useful in a headless container. All permission enforcement happens on the host side (proxy for network, bridge for MCP tools)
- `allowedTools` includes all SDK tools including `Bash` — Bash execution is safe because the container sandbox + proxy enforces the security boundary, not the SDK's permission system
- `mcp__nanoclaw__*` tools remain in `allowedTools` — these are the agent's own communication channel (send messages, create tasks). They write IPC files to host-monitored directories, not network calls. Gating them would break the agent's ability to communicate results. The IPC directories are already validated by the host.

## Security Properties

| Attack | Mitigation |
|--------|------------|
| Agent bypasses SDK, uses curl/fetch directly | Traffic goes through proxy → Telegram approval |
| Agent modifies hook code | No hook exists. Permission checks run on host. |
| Agent forges permission response | No response files exist. Decisions made on host. |
| Evil background process races approved request | Container has no network route to MCP servers. Bridge is only path. |
| Agent reads credentials from env/files | Credentials injected by proxy (API key) and bridge (MCP auth). Never in container. |
| Container escapes network sandbox | `--cap-drop ALL`, `--security-opt no-new-privileges`, iptables DROP |
| New group without permissionApproval | Toggle removed. All groups locked down by default. |
| Agent abuses nanoclaw MCP tools (send_message, schedule_task) | These write IPC files to host-monitored dirs, not network calls. Host validates all IPC input. |
| DNS exfiltration | Accepted risk. Blocking DNS breaks all networking. Low-value channel for sandboxed agents. |
| Approved CONNECT host relays to unapproved destination | Accepted risk. Mitigated by specific Haiku-shaped patterns and predefined server endpoints. |

## Files Affected

| File | Change |
|------|--------|
| `src/container-runner.ts` | Remove NO_PROXY exemptions, add bridge spawning, shadow .mcp.json, block until IP registered |
| `src/credential-proxy.ts` | Remove `extractRemoteMcpHosts` dependency, simplify (no tool awareness needed) |
| `src/mcp-bridge.ts` | **New:** Host-side MCP bridge with permission gating |
| `src/permission-rule-generator.ts` | Add `mcp` egress type, extend `generateRuleProposal(egressType, subject, context?)` to accept optional tools list for MCP rules |
| `src/index.ts` | Remove `onPermissionRequest`, remove file-based permission IPC |
| `src/ipc.ts` | Remove permission request handling from IPC watcher |
| `container/agent-runner/src/index.ts` | Remove permission hook, add bridge MCP server configs from input |
| `container/agent-runner/src/bridge-client.ts` | **New:** Minimal stub that connects to Unix socket and forwards stdio. Baked into container image. |
| `container/agent-runner/src/permission-hook.ts` | **Delete** |
| `src/mcp-permission-response.ts` | **Delete** |

## Migration

1. Deploy new code — all containers automatically get locked-down networking
2. The `containerConfig.permissionApproval` field in group registrations is ignored (all groups are locked down). Field can remain in DB without harm — no migration needed.
3. First run: Anthropic API triggers approval → tap "always" once
4. First MCP tool use: bridge sends approval → tap "always" with Haiku-shaped rule
5. Existing `permission_rules` for `connect`/`http` types continue to work
6. Old file-based permission IPC dirs can be cleaned up
7. Shadow `.mcp.json` mount path must exactly match the group folder mount point (e.g., `/workspace/group/.mcp.json`) — derived from the existing group folder mount, not hardcoded
