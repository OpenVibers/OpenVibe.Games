#!/usr/bin/env node
// Smoke: addon npm dependency declarations + hot-reload watcher filtering.
//
// Boots a server-realm ov-runtime on scratch ports with a temporary addon that
// declares npm deps in addon.json ("ov-leftpad" file: + "is-odd" range — both
// already installed in js/node_modules) and asserts:
//   (a) the dep diff no-ops: NO npm process is spawned when deps are already
//       satisfied, and the addon can require() both packages (is-odd lives
//       ONLY in js/node_modules, exercising the runtime's resolve fallback);
//   (b) the watcher ignores README.md / extension-less editor scratch writes
//       (no reload) but does a single debounced reload on a .js write.
// The temp addon dir is removed afterward.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");
const RT = path.join(ROOT, "engine", "openvibe-js-runtime", "ov-runtime.js");
const MOD = path.join(ROOT, "game", "openvibe.games");
const ADDON = path.join(MOD, "addons", "zz-smoke-npmdeps-tmp");

const SV_PORT = 47099, SV_CTRL = 47097;

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }
function cleanup() { try { fs.rmSync(ADDON, { recursive: true, force: true }); } catch {} }

let failures = 0;
function ok(cond, label) {
  if (!cond) { failures++; console.error(`  FAIL ${label}`); }
  else console.log(`  ok   ${label}`);
}

async function evalCode(code) {
  return fetch(`http://127.0.0.1:${SV_CTRL}/eval`, {
    method: "POST", body: JSON.stringify({ code }),
  }).then((r) => r.json());
}

// ---- temp addon declaring already-satisfied npm deps ----
cleanup();
fs.mkdirSync(ADDON, { recursive: true });
fs.writeFileSync(path.join(ADDON, "addon.json"), JSON.stringify({
  name: "Smoke NPM Deps",
  entry: { server: "server.js" },
  npm: { "ov-leftpad": "file:vendor/ov-leftpad", "is-odd": "^3" },
}, null, 2) + "\n");
fs.writeFileSync(path.join(ADDON, "server.js"),
  'globalThis.__smokeNpmPad = require("ov-leftpad")("7", 3, "0");\n' +
  'globalThis.__smokeNpmOdd = require("is-odd")(3);\n');

const proc = spawn(process.execPath, [RT, "--realm", "server", "--mode", "sandbox",
  "--port", String(SV_PORT), "--ctrl-port", String(SV_CTRL), "--root", ROOT],
  { stdio: ["ignore", "pipe", "pipe"] });
const lines = [];
proc.stdout.on("data", (d) => lines.push(...String(d).split("\n").filter(Boolean)));
proc.stderr.on("data", (d) => lines.push(...String(d).split("\n").filter(Boolean)));

const reloads = () => lines.filter((l) => /hot-reload:/.test(l)).length;
const npmSpawns = () => lines.filter((l) => /npm-deps: installing|\bnpm install\b/.test(l)).length;

try {
  await wait(2000);

  // (a) deps declared + already installed -> diff no-ops, require() works
  const pad = await evalCode("globalThis.__smokeNpmPad");
  ok(pad.ok && pad.result === "007", `addon require('ov-leftpad') works (got ${JSON.stringify(pad.result)})`);
  const odd = await evalCode("globalThis.__smokeNpmOdd");
  ok(odd.ok && odd.result === true, "addon require('is-odd') resolves via js/node_modules fallback");
  ok(lines.some((l) => /npm-deps: .*satisfied/.test(l)), "dep diff ran and reported all deps satisfied");
  ok(npmSpawns() === 0, "no npm install spawned when deps already satisfied");

  // (b) watcher ignores non-code writes...
  const beforeNoise = reloads();
  fs.writeFileSync(path.join(ADDON, "README.md"), "# smoke\n");
  fs.writeFileSync(path.join(ADDON, "XXT8vqwZ"), "editor scratch\n");   // extension-less temp name
  fs.writeFileSync(path.join(ADDON, "server.js.bak"), "// backup\n");
  await wait(1400);
  ok(reloads() === beforeNoise, "README.md / scratch / .bak writes did NOT trigger a reload");

  // ...but a burst of .js writes triggers exactly ONE debounced reload
  const beforeJs = reloads();
  fs.writeFileSync(path.join(ADDON, "bump.js"), "// touch 1\n");
  fs.appendFileSync(path.join(ADDON, "bump.js"), "// touch 2\n");
  fs.writeFileSync(path.join(ADDON, "server.js"),
    'globalThis.__smokeNpmPad = require("ov-leftpad")("7", 3, "0");\n' +
    'globalThis.__smokeNpmOdd = require("is-odd")(3);\n' +
    'globalThis.__smokeReloaded = true;\n');
  await wait(1600);
  ok(reloads() === beforeJs + 1, `.js write burst triggered exactly one debounced reload (got ${reloads() - beforeJs})`);
  const re = await evalCode("globalThis.__smokeReloaded");
  ok(re.ok && re.result === true, "reload re-ran the addon entry (realm alive)");
  ok(npmSpawns() === 0, "still no npm install after the reload re-diff");
} catch (e) {
  failures++;
  console.error("  FAIL harness error:", e.message);
} finally {
  proc.kill();
  cleanup();
}

if (failures) { console.error(`[smoke-npm-deps] ${failures} FAILURES`); process.exit(1); }
console.log("[smoke-npm-deps] ALL PASS");
