#!/usr/bin/env node
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';

const root = resolve(process.env.OPENVIBE_ROOT || join(process.env.HOME || '.', 'src/openvibe-source'));
const launcherRoot = join(root, 'launcher');
const host = process.env.OPENVIBE_CLIENT_UI_HOST || '127.0.0.1';
const port = Number(process.env.OPENVIBE_CLIENT_UI_PORT || 5173);

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
};

function send(res, status, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

function sendHeaders(res, status, type) {
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end();
}

function fileForUrl(url) {
  const parsed = new URL(url, `http://${host}:${port}`);
  let pathname = decodeURIComponent(parsed.pathname);

  if (pathname === '/' || pathname === '/client' || pathname === '/client/') {
    return join(launcherRoot, 'index.html');
  }

  if (!pathname.startsWith('/client/')) {
    if (pathname === '/styles.css' || pathname === '/renderer.js' || pathname === '/preload.js') {
      return join(launcherRoot, pathname.slice(1));
    }
    if (pathname.startsWith('/assets/')) {
      const asset = normalize(join(launcherRoot, pathname.slice(1)));
      return asset.startsWith(launcherRoot + sep) ? asset : null;
    }
    return null;
  }

  pathname = pathname.slice('/client/'.length);
  const file = normalize(join(launcherRoot, pathname));
  if (!file.startsWith(launcherRoot + sep)) {
    return null;
  }

  return file;
}

const server = createServer((req, res) => {
  if (!req.url || (req.method !== 'GET' && req.method !== 'HEAD')) {
    send(res, 405, 'Method not allowed');
    return;
  }

  if (req.url === '/health') {
    if (req.method === 'HEAD') {
      sendHeaders(res, 200, 'application/json; charset=utf-8');
      return;
    }
    send(res, 200, JSON.stringify({ ok: true, service: 'openvibe-client-ui' }), 'application/json; charset=utf-8');
    return;
  }

  const file = fileForUrl(req.url);
  if (!file || !existsSync(file) || !statSync(file).isFile()) {
    send(res, 404, 'Not found');
    return;
  }

  if (req.method === 'HEAD') {
    sendHeaders(res, 200, mime[extname(file).toLowerCase()] || 'application/octet-stream');
    return;
  }

  res.writeHead(200, {
    'Content-Type': mime[extname(file).toLowerCase()] || 'application/octet-stream',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  createReadStream(file).pipe(res);
});

server.listen(port, host, () => {
  console.log(`[openvibe-ui] serving ${launcherRoot} at http://${host}:${port}/client`);
});
