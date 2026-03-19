/**
 * Maps container bridge IP addresses to group identity.
 *
 * When a container starts, its IP on the nanoclaw-proxy bridge is registered
 * here. The credential proxy calls resolveContainerGroup with
 * req.socket.remoteAddress to identify which group's container is making
 * a request, so it can send the Telegram approval message to the right chat.
 */

export interface ContainerGroupEntry {
  groupFolder: string;
  chatJid: string;
}

const registry = new Map<string, ContainerGroupEntry>();

export function registerContainerGroup(
  ip: string,
  entry: ContainerGroupEntry,
): void {
  registry.set(ip, entry);
}

export function deregisterContainerGroup(ip: string): void {
  registry.delete(ip);
}

/**
 * Look up the group for a connection's remote address.
 * Handles IPv4-mapped IPv6 addresses (::ffff:172.19.0.2 → 172.19.0.2).
 *
 * On Docker Desktop macOS, host.docker.internal traffic arrives as 127.0.0.1
 * (not the container's bridge IP), so IP-based lookup fails. When exactly one
 * container is registered, we fall back to returning it for loopback addresses.
 */
export function resolveContainerGroup(
  remoteAddress: string,
): ContainerGroupEntry | null {
  const ip = remoteAddress.replace(/^::ffff:/, '');
  const direct = registry.get(ip);
  if (direct) return direct;

  // Docker Desktop macOS fallback: loopback + single container
  if ((ip === '127.0.0.1' || ip === '::1') && registry.size === 1) {
    const [entry] = registry.values();
    return entry ?? null;
  }

  return null;
}

/** @internal — for tests only */
export function _clearRegistry(): void {
  registry.clear();
}
