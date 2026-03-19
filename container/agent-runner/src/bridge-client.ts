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
