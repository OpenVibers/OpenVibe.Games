#!/usr/bin/env node
// End-to-end IPC smoke: boots the server-realm and client-realm ov-runtime
// hosts on real TCP ports, connects fake "game DLL" sockets to both (playing
// the C++ side), and drives the full message flow:
//   hello -> framework load -> player_connect -> PlayerSay -> net C->S -> net S->C
// Verifies the sandbox Q-menu spawn round-trips and the HUD/net wiring works
// across processes exactly as it will in-game (ov_js_backend node).
import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import url from "node:url";

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");
const RT = path.join(ROOT, "engine", "openvibe-js-runtime", "ov-runtime.js");

const SV_PORT = 46999, SV_CTRL = 46997, CL_PORT = 46998, CL_CTRL = 46996;

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

function startRuntime(realm, port, ctrl) {
  const p = spawn(process.execPath, [RT, "--realm", realm, "--mode", "sandbox",
    "--port", String(port), "--ctrl-port", String(ctrl), "--root", ROOT], { stdio: ["ignore", "pipe", "pipe"] });
  const lines = [];
  p.stdout.on("data", (d) => lines.push(...String(d).split("\n").filter(Boolean)));
  p.stderr.on("data", (d) => lines.push(...String(d).split("\n").filter(Boolean)));
  return { proc: p, lines };
}

function connectGame(port) {
  return new Promise((resolve, reject) => {
    const inbox = [];
    const sock = net.connect(port, "127.0.0.1", () => resolve({ sock, inbox, send: (o) => sock.write(JSON.stringify(o) + "\n") }));
    let buf = "";
    sock.on("data", (d) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
        if (line) { try { inbox.push(JSON.parse(line)); } catch {} }
      }
    });
    sock.on("error", reject);
  });
}

let failures = 0;
function ok(cond, label) {
  if (!cond) { failures++; console.error(`  FAIL ${label}`); }
  else console.log(`  ok   ${label}`);
}

const sv = startRuntime("server", SV_PORT, SV_CTRL);
const cl = startRuntime("client", CL_PORT, CL_CTRL);
await wait(1500);

try {
  // fake game DLL connections (what the C++ COpenVibeIPC does)
  const svGame = await connectGame(SV_PORT);
  const clGame = await connectGame(CL_PORT);

  svGame.send({ t: "hello", map: "ov_hub" });
  clGame.send({ t: "hello", map: "ov_hub" });
  await wait(700);

  svGame.send({ t: "player_connect", userId: 3, name: "Echo", steamId: "STEAM_0:1:3", entIndex: 1 });
  clGame.send({ t: "local_player", userId: 3, name: "Echo", steamId: "STEAM_0:1:3", entIndex: 1 });
  await wait(200);

  // PlayerSay routes chat commands: !q prints Q menu via {"t":"chat"} lines back
  svGame.send({ t: "say", userId: 3, playerName: "Echo", text: "!q" });
  await wait(300);
  ok(svGame.inbox.some((m) => m.t === "chat" && /Q Menu/.test(m.msg || "")), "server: !q chat command replied via IPC");

  // client -> server net: Q-menu spawn (client realm net.SendToServer -> game 'net' line)
  const evalRes = await fetch(`http://127.0.0.1:${CL_CTRL}/eval`, {
    method: "POST", body: JSON.stringify({ code: 'net.Start("OV_Sandbox_Spawn");net.WriteString("crate");net.SendToServer();"sent"' })
  }).then((r) => r.json());
  ok(evalRes.ok && evalRes.result === "sent", "client: eval net.SendToServer");
  await wait(200);
  const clNetOut = clGame.inbox.find((m) => m.t === "net" && m.toServer);
  ok(!!clNetOut, "client runtime emitted net line to game DLL (ov_net path)");

  // game DLL would forward that to the server as {"t":"net", userId, ...}
  svGame.send({ t: "net", userId: 3, name: clNetOut.name, payload: clNetOut.payload });
  await wait(300);
  ok(svGame.inbox.some((m) => m.t === "runcmd" && /ov_fortwars_spawn crate/.test(m.cmd || "")), "server: net.Receive validated + ran spawn command");

  // server -> client net: OV_Sandbox_Welcome on spawn
  svGame.send({ t: "event", name: "PlayerInitialSpawn", args: [{ __player: true, userId: 3 }] });
  await wait(300);
  const welcome = svGame.inbox.find((m) => m.t === "net" && !m.toServer);
  ok(!!welcome, "server: PlayerInitialSpawn pushed net message to client");
  if (welcome) {
    // game DLL delivers it to the client runtime via the OVNet usermessage path
    clGame.send({ t: "net", name: welcome.name, payload: welcome.payload });
    await wait(300);
    const state = await fetch(`http://127.0.0.1:${CL_CTRL}/eval`, {
      method: "POST", body: JSON.stringify({ code: "1" })
    }).then((r) => r.json());
    ok(state.ok, "client runtime alive after net delivery");
    ok(cl.lines.some((l) => /OV_Sandbox_Welcome/.test(l)), "client: net.Receive fired for OV_Sandbox_Welcome");
  }

  // hot-reload signal: server /state shows gamemode + hook events
  const st = await fetch(`http://127.0.0.1:${SV_CTRL}/state`).then((r) => r.json());
  ok(st.ok && st.gamemode && st.gamemode.mode === "sandbox" && st.gameConnected, "server /state reflects connected game + gamemode");
} catch (e) {
  failures++;
  console.error("  FAIL harness error:", e.message);
} finally {
  sv.proc.kill(); cl.proc.kill();
}

if (failures) { console.error(`[smoke-runtime-ipc] ${failures} FAILURES`); process.exit(1); }
console.log("[smoke-runtime-ipc] ALL PASS");
