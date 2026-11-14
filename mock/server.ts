import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import { MockDevice } from './device.ts';
import type { MockAction } from './device.ts';

const root = resolve('dist');
const port = Number(process.env.PORT || 4173);
// A wildcard bind is used only inside the private Compose network. Compose
// publishes this port to 127.0.0.1; local npm run mock is loopback by default.
const host = process.env.MOCK_BIND || '127.0.0.1';
const mime: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
};
const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://mock.invalid');
  if (url.pathname === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"simulation":true,"ok":true}');
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405);
    res.end();
    return;
  }
  try {
    const pathname = decodeURIComponent(url.pathname);
    const path = resolve(root, '.' + pathname + (pathname.endsWith('/') ? 'index.html' : ''));
    if (!path.startsWith(root + sep) || !(await stat(path)).isFile()) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, {
      'content-type': mime[extname(path)] || 'application/octet-stream',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'permissions-policy': 'bluetooth=()',
    });
    res.end(req.method === 'HEAD' ? undefined : await readFile(path));
  } catch {
    res.writeHead(404);
    res.end();
  }
});
const sockets = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
server.on('upgrade', (req, socket, head) => {
  // Same-origin only. No live device is attached, but arbitrary web pages
  // should not be able to drive a developer's local mock.
  let validOrigin = false;
  try {
    validOrigin = new URL(req.headers.origin || '').host === req.headers.host;
  } catch {
    /* deny */
  }
  if (!validOrigin || req.url !== '/__mock/gatt') {
    socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  sockets.handleUpgrade(req, socket, head, (ws) => sockets.emit('connection', ws));
});
sockets.on('connection', (socket) => {
  const device = new MockDevice();
  device.onDisconnect(() => {
    if (socket.readyState === WebSocket.OPEN) socket.close();
  });
  device.connect();
  // One simulated appliance per connection keeps concurrent UI tests isolated.
  socket.on('message', async (data) => {
    let id: number | undefined;
    const send = (value: unknown) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value));
    };
    try {
      const message = JSON.parse(data.toString()) as {
        id: number;
        operation: string;
        service: string;
        characteristic: string;
        bytes: number[];
        action: MockAction;
      };
      id = message.id;
      if (!Number.isSafeInteger(id)) throw new Error('Invalid request ID.');
      let bytes: Uint8Array | undefined;
      if (message.operation === 'read')
        bytes = device.read(message.service, message.characteristic);
      else if (message.operation === 'write') {
        if (
          !Array.isArray(message.bytes) ||
          message.bytes.length > 4096 ||
          message.bytes.some((x) => !Number.isInteger(x) || x < 0 || x > 255)
        )
          throw new Error('Invalid GATT bytes.');
        await device.write(message.service, message.characteristic, new Uint8Array(message.bytes));
      } else if (message.operation === 'subscribe') {
        device.subscribe(message.service, message.characteristic, (value) =>
          send({ characteristic: message.characteristic, bytes: Array.from(value) }),
        );
      } else if (message.operation === 'action') device.action(message.action);
      else throw new Error('Unknown mock operation.');
      send({ id, bytes: bytes ? Array.from(bytes) : [] });
    } catch (error) {
      send({ id, error: error instanceof Error ? error.message : 'Invalid mock request.' });
    }
  });
  socket.on('close', () => device.disconnect());
});
server.listen(port, host, () => {
  console.log(
    `Joule simulation listening on ${host}:${port}. Open /?mock=server. No physical device is connected.`,
  );
});
for (const signal of ['SIGTERM', 'SIGINT'] as const)
  process.on(signal, () => {
    sockets.clients.forEach((socket) => socket.close());
    server.close(() => process.exit(0));
  });
