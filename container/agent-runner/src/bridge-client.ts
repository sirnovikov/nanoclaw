/**
 * MCP Bridge Client — runs inside container.
 * Connects to a host-side bridge (TCP or Unix socket) and
 * forwards stdin/stdout bidirectionally.
 *
 * Usage:
 *   node bridge-client.js host.docker.internal:12345   (TCP)
 *   node bridge-client.js /bridge/vercel.sock           (Unix socket)
 */
import net from 'node:net';

const target = process.argv[2];
if (!target) {
  process.stderr.write('Usage: bridge-client <host:port | socket-path>\n');
  process.exit(1);
}

// Detect TCP (host:port) vs Unix socket (path)
const tcpMatch = target.match(/^(.+):(\d+)$/);
const socket = tcpMatch
  ? net.createConnection({ host: tcpMatch[1], port: Number(tcpMatch[2]) })
  : net.createConnection(target);

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
