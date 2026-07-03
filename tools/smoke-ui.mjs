#!/usr/bin/env node
// Smoke test for the unified OpenVibe GUI (client/).
//
// 1. Starts tools/serve-client-ui.mjs on an ephemeral port and asserts:
//      - GET /health        → { ok: true }
//      - GET /client/       → unified HTML with markers for every route
//      - GET /client/ui-sync.js → the shared sync layer serves
// 2. Verifies the backend path mapping (backend/src/index.ts serves the
//    repo-root client/ directory at /client/) by reading client/index.html
//    straight from disk — no backend start needed — and asserting it is the
//    same unified app.
//
// Exits non-zero on any failure.

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const serverScript = join(__dirname, 'serve-client-ui.mjs');
const clientIndex = join(root, 'client', 'index.html');

const ROUTE_MARKERS = [
  'route-portal',
  'route-servers',
  'route-leaderboard',
  'route-inventory',
  'route-shop',
  'route-settings',
  'route-options',
  'route-console',
];

let failures = 0;
function check(name, ok, detail = '') {
  if (ok) {
    console.log(`  ok   ${name}`);
  } else {
    failures += 1;
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function ephemeralPort() {
  return new Promise((resolvePort, reject) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolvePort(port));
    });
    srv.on('error', reject);
  });
}

async function waitForHealth(base, timeoutMs = 8000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(`${base}/health`);
      if (res.ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

function assertUnifiedHtml(label, html) {
  for (const marker of ROUTE_MARKERS) {
    check(`${label}: contains ${marker}`, html.includes(marker));
  }
  check(`${label}: contains HUD overlay (ov-hud)`, html.includes('ov-hud'));
  check(`${label}: loads ui-sync.js`, html.includes('ui-sync.js'));
  check(`${label}: openvibe:// bridge present`, html.includes('openvibe://'));
  check(`${label}: console eval wiring (41997)`, html.includes('41997'));
  check(`${label}: client runtime wiring (41996)`, html.includes('41996'));
}

async function main() {
  const port = await ephemeralPort();
  const base = `http://127.0.0.1:${port}`;

  console.log(`[smoke-ui] starting serve-client-ui.mjs on :${port}`);
  const child = spawn(process.execPath, [serverScript], {
    cwd: root,
    env: {
      ...process.env,
      OPENVIBE_ROOT: root,
      OPENVIBE_CLIENT_UI_PORT: String(port),
      OPENVIBE_CLIENT_UI_HOST: '127.0.0.1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (d) => process.stderr.write(`[serve] ${d}`));

  try {
    check('server: /health reachable', await waitForHealth(base));

    // /health payload
    try {
      const health = await (await fetch(`${base}/health`)).json();
      check('server: /health ok:true', health && health.ok === true, JSON.stringify(health));
    } catch (e) {
      check('server: /health ok:true', false, e.message);
    }

    // /client/ serves the unified app
    try {
      const res = await fetch(`${base}/client/`);
      check('server: GET /client/ → 200', res.status === 200, `status ${res.status}`);
      check('server: /client/ is HTML', (res.headers.get('content-type') || '').includes('text/html'));
      const html = await res.text();
      assertUnifiedHtml('server: /client/', html);
    } catch (e) {
      check('server: GET /client/', false, e.message);
    }

    // /client/ui-sync.js serves
    try {
      const res = await fetch(`${base}/client/ui-sync.js`);
      check('server: GET /client/ui-sync.js → 200', res.status === 200, `status ${res.status}`);
      const js = await res.text();
      check('server: ui-sync storage key', js.includes('openvibe.ui.state.v1'));
      check('server: ui-sync channel', js.includes('openvibe-ui-sync-v1'));
      check('server: ui-sync routes include console/options/hud',
        js.includes("'console'") && js.includes("'options'") && js.includes("'hud'"));
      check('server: ui-sync exposes OpenVibeShell', js.includes('OpenVibeShell'));
    } catch (e) {
      check('server: GET /client/ui-sync.js', false, e.message);
    }

    // Backend path mapping: backend serves the same repo-root client/ dir at
    // /client/ — assert the on-disk file is the unified app.
    try {
      const html = readFileSync(clientIndex, 'utf8');
      assertUnifiedHtml('backend(disk): client/index.html', html);
    } catch (e) {
      check('backend(disk): read client/index.html', false, e.message);
    }
  } finally {
    child.kill();
  }

  if (failures > 0) {
    console.error(`[smoke-ui] FAILED — ${failures} assertion(s) failed`);
    process.exit(1);
  }
  console.log('[smoke-ui] PASS — all assertions succeeded');
}

main().catch((e) => {
  console.error('[smoke-ui] fatal:', e);
  process.exit(1);
});
