import { createServer } from 'node:http';
import path from 'node:path';
import { createServer as createViteServer } from 'vite';
import { WebSocketServer } from 'ws';

const port = Number(process.env.AGORA_API_PORT || 8787);
const webPort = Number(process.env.AGORA_WEB_PORT || 5173);
const apiOrigin = `http://127.0.0.1:${port}`;
const webOrigin = `http://127.0.0.1:${webPort}`;
const maxBodyBytes = 1_000_000;

function resolveLocalRequestUrl(requestTarget) {
  if (typeof requestTarget !== 'string' || !requestTarget.startsWith('/')) return null;
  try {
    const resolved = new URL(requestTarget, apiOrigin);
    return resolved.origin === apiOrigin ? resolved : null;
  } catch {
    return null;
  }
}

function rejectUpgrade(socket, status = 403) {
  const message = status === 400 ? 'Bad Request' : 'Forbidden';
  socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}
const vite = await createViteServer({
  root: process.cwd(),
  configFile: false,
  appType: 'custom',
  logLevel: 'error',
  server: { middlewareMode: true, hmr: false },
});
const { createAgoraWorkerApp, createLocalCloudflareEnv } = await vite.ssrLoadModule(
  '/apps/worker/src/index.ts',
);
const env = createLocalCloudflareEnv({
  persistDir: path.resolve('.agora-local'),
  adminToken: process.env.AGORA_ADMIN_TOKEN || 'agora-admin-secret-token',
});
const app = createAgoraWorkerApp({ adminToken: env.ADMIN_TOKEN, allowedOrigins: [webOrigin] });
const sockets = new WebSocketServer({ noServer: true });

const server = createServer(async (incoming, outgoing) => {
  try {
    const requestUrl = resolveLocalRequestUrl(incoming.url);
    if (!requestUrl) {
      outgoing.writeHead(400, { 'Content-Type': 'application/json' });
      outgoing.end(JSON.stringify({ error: 'Invalid local request URL' }));
      return;
    }
    const chunks = [];
    let bodySize = 0;
    let tooLarge = false;
    for await (const chunk of incoming) {
      bodySize += chunk.length;
      if (bodySize > maxBodyBytes) {
        tooLarge = true;
        chunks.length = 0;
      } else if (!tooLarge) {
        chunks.push(chunk);
      }
    }
    if (tooLarge) {
      outgoing.writeHead(413, { 'Content-Type': 'application/json' });
      outgoing.end(JSON.stringify({ error: 'Request body too large' }));
      return;
    }
    const body = Buffer.concat(chunks);
    const request = new Request(requestUrl, {
      method: incoming.method,
      headers: incoming.headers,
      ...(body.length ? { body, duplex: 'half' } : {}),
    });
    const response = await app.fetch(request, env);
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    console.error('Local API error:', error);
    outgoing.writeHead(500, { 'Content-Type': 'application/json' });
    outgoing.end(JSON.stringify({ error: 'Local API error' }));
  }
});

server.on('upgrade', async (incoming, socket, head) => {
  const requestUrl = resolveLocalRequestUrl(incoming.url);
  if (!requestUrl) {
    rejectUpgrade(socket, 400);
    return;
  }
  if (incoming.headers.origin !== webOrigin) {
    rejectUpgrade(socket);
    return;
  }
  const url = requestUrl;
  const match = url.pathname.match(/^\/api\/v1\/sessions\/([^/]+)\/ws$/);
  if (!match) {
    rejectUpgrade(socket, 400);
    return;
  }
  let sessionId;
  try {
    sessionId = decodeURIComponent(match[1]);
  } catch {
    rejectUpgrade(socket, 400);
    return;
  }
  try {
    const response = await app.fetch(
      new Request(`${apiOrigin}/api/v1/sessions/${encodeURIComponent(sessionId)}`),
      env,
    );
    if (!response.ok) {
      rejectUpgrade(socket, 400);
      return;
    }
    sockets.handleUpgrade(incoming, socket, head, (client) => {
      app
        .getCoordinator(sessionId)
        .handleConnection(client, webOrigin, url.searchParams.get('token'));
    });
  } catch {
    rejectUpgrade(socket, 400);
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Agora emulated API: http://127.0.0.1:${port}`);
});

async function stop() {
  for (const client of sockets.clients) client.terminate();
  sockets.close();
  server.close();
  env.close();
  await vite.close();
}
process.once('SIGINT', () => void stop());
process.once('SIGTERM', () => void stop());
