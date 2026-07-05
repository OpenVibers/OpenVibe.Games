import { spawn } from 'node:child_process';
import net from 'node:net';

import { fileURLToPath } from 'node:url';
const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const PORT = 45998, CTRL = 45996;
const proc = spawn('node', [ROOT + '/engine/openvibe-js-runtime/ov-runtime.js', '--realm', 'client', '--port', String(PORT), '--ctrl-port', String(CTRL), '--root', ROOT + '/game/openvibe.games'], { stdio: ['ignore', 'pipe', 'pipe'] });
proc.stdout.on('data', () => {});
proc.stderr.on('data', (d) => process.stderr.write(d));
await new Promise(r => setTimeout(r, 2500));

const cmds = [];
const sock = net.connect(PORT, '127.0.0.1');
let buf = '';
sock.on('data', (d) => {
  buf += d.toString();
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx); buf = buf.slice(idx + 1);
    if (!line.trim()) continue;
    try { const m = JSON.parse(line); if (m.t === 'concmd') cmds.push(m.cmd); } catch {}
  }
});
await new Promise(r => sock.once('connect', r));
await new Promise(r => setTimeout(r, 300));

// Big script (~3KB) with quotes/semicolons like a real HUD layout push.
// Non-ASCII '·' included: the page decodes chunks via atob (Latin-1) +
// escape/decodeURIComponent, and this catches any UTF-8 mangling regression.
const inner = JSON.stringify({ visible: true, layout: Array.from({length: 12}, (_, i) => ({ id: 'el'+i, type: 'counter', anchor: 'bottom-right', x: 16, y: 16+28*i, bind: 'v'+i, text: 'Element · '+i, color: {r:255,g:200,b:60} })), values: { v0: 550 } }).replace(/\\/g,'\\\\').replace(/"/g,'\\"');
const script = 'window.OV&&OV.onHudLayout&&OV.onHudLayout(JSON.parse("' + inner + '"))';

const res = await fetch(`http://127.0.0.1:${CTRL}/eval`, { method: 'POST', body: JSON.stringify({ code: "OV.menuJS(" + JSON.stringify(script) + ")" }) });
await res.text();
await new Promise(r => setTimeout(r, 800));

let pass = true;
// The engine budget is 512 for BOTH the raw string and the argv buffer; the
// tokenizer splits on {}()': (no \" escape awareness) and argv adds a NUL per
// token — so assert length + special-char token splits stays under 510.
const argvLen = (c) => c.length + (c.match(/["'(){}:]/g) || []).length + 8;
const over = cmds.filter(c => c.length > 510 || argvLen(c) > 510);
if (over.length) { console.error('FAIL: %d commands exceed the 510 string/argv budget (max %d)', over.length, Math.max(...cmds.map(argvLen))); pass = false; }
const chunkCmds = cmds.filter(c => c.startsWith('ov_menu_js '));
if (chunkCmds.length < 3) { console.error('FAIL: expected chunked commands, got', chunkCmds.length); pass = false; }
for (const c of chunkCmds) if (c.includes(';')) { console.error('FAIL: semicolon in command:', c.slice(0,80)); pass = false; }
// Reassemble like the page would.
let acc = null, evaled = null;
for (const c of chunkCmds) {
  const body = c.slice('ov_menu_js '.length);
  if (body === 'window.__ovmjs=""') acc = '';
  else if (body.startsWith('window.__ovmjs=window.__ovmjs+"')) acc += body.slice('window.__ovmjs=window.__ovmjs+"'.length, -1);
  else if (body === 'eval(decodeURIComponent(escape(window.atob(window.__ovmjs))))') evaled = Buffer.from(acc, 'base64').toString('utf8');
}
if (evaled !== script) { console.error('FAIL: reassembled script mismatch (got %d chars, want %d)', evaled && evaled.length, script.length); pass = false; }

// Small script stays single-shot.
cmds.length = 0;
await fetch(`http://127.0.0.1:${CTRL}/eval`, { method: 'POST', body: JSON.stringify({ code: "OV.menuJS(\"window.x=1\")" }) });
await new Promise(r => setTimeout(r, 500));
const small = cmds.filter(c => c.startsWith('ov_menu_js '));
if (small.length !== 1 || small[0] !== 'ov_menu_js window.x=1') { console.error('FAIL: small script not single-shot:', small); pass = false; }

// Mid-size dense-JSON script (~380 raw chars): fits the old 440 single-shot
// cutoff but its token splits would overflow the engine's argv buffer — must
// take the chunked path now (regression for the second round of clamp spam).
cmds.length = 0;
const denseInner = JSON.stringify({ hp: 100, phase: 'build', t: 42, els: Array.from({length: 6}, (_, i) => ({ id: 'x'+i, v: i })) }).replace(/\\/g,'\\\\').replace(/"/g,'\\"');
const dense = 'window.OV&&OV.onHudState&&OV.onHudState(JSON.parse("' + denseInner + '"))';
await fetch(`http://127.0.0.1:${CTRL}/eval`, { method: 'POST', body: JSON.stringify({ code: "OV.menuJS(" + JSON.stringify(dense) + ")" }) });
await new Promise(r => setTimeout(r, 500));
const denseCmds = cmds.filter(c => c.startsWith('ov_menu_js '));
if (denseCmds.length < 3) { console.error('FAIL: dense mid-size script was not chunked:', denseCmds.length, 'cmds'); pass = false; }
const denseOver = denseCmds.filter(c => argvLen(c) > 510);
if (denseOver.length) { console.error('FAIL: dense chunk exceeds argv budget'); pass = false; }

proc.kill();
console.log(pass ? '[smoke-menujs-chunk] ALL PASS — %d chunked cmds, max len %d, byte-exact reassembly' : '[smoke-menujs-chunk] FAILED', chunkCmds.length, Math.max(0,...chunkCmds.map(c=>c.length)));
process.exit(pass ? 0 : 1);
