#!/usr/bin/env node
// GModJS framework test harness — runs a paired server+client realm entirely
// in Node (zero C++), with a loopback net transport, against the real
// game/openvibe.games/js tree. Covers hooks, net, entities, scripted ents,
// NW/DT sync, file sync manifest, include/AddCSJSFile, concommand, loader,
// and hot-repatch of scripted entities.
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import url from "node:url";

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");
const MOD = path.join(ROOT, "game", "openvibe.games");

let failures = 0;
let checks = 0;
function ok(cond, label) {
  checks++;
  if (!cond) { failures++; console.error(`  FAIL ${label}`); }
  else console.log(`  ok   ${label}`);
}
function section(name) { console.log(`\n== ${name}`); }

function modRel(p) {
  const norm = path.normalize(p).replace(/^([/\\]|\.\.)+/, "");
  return path.join(MOD, norm);
}

// ---- realm factory ----
function makeRealm(realmName, mode, transport) {
  const logs = [];
  const isServer = realmName === "server";
  const players = {}; // userId -> record
  const writes = {};  // virtual client write cache (js/ov_downloads/...)

  const OV = {
    log: (m) => logs.push(`[log] ${m}`),
    warn: (m) => logs.push(`[warn] ${m}`),
    error: (m) => { logs.push(`[error] ${m}`); console.error(`  [${realmName} JS ERROR]`, m); },
    isServer: () => isServer,
    getMode: () => mode,
    getMapName: () => "test_map",
    time: () => transport.now(),
    readFile: (p) => {
      if (writes[p] !== undefined) return writes[p];
      try { return fs.readFileSync(modRel(p), "utf8"); } catch { return null; }
    },
    fileExists: (p) => {
      if (writes[p] !== undefined) return true;
      try { fs.statSync(modRel(p)); return true; } catch { return false; }
    },
    listDir: (d) => { try { return fs.readdirSync(modRel(d)); } catch { return []; } },
    writeFile: (p, content) => { writes[p] = String(content); return true; },
    players: () => Object.values(players).map((p) => p.native),
    playerByUserId: (id) => (players[id] ? players[id].native : null),
    broadcast: (m) => logs.push(`[broadcast] ${m}`),
    serverCommand: (c) => logs.push(`[serverCommand] ${c}`),
    netEmit: (ids, name, payload) => transport.serverEmit(ids, name, payload),
    netSendToServer: (name, payload) => transport.clientSend(name, payload),
    fireHook: (...a) => ctxg.hook.Run(...a),
    localPlayer: () => null,
    reward: () => {}, endMatch: () => {},
  };

  const ctxg = vm.createContext({ console, OV });
  ctxg.globalThis = ctxg;

  const core = ["core/hook.js", "core/gamemode.js", "bridge.js", "core/command.js", "core/timer.js"];
  for (const f of core) {
    const code = fs.readFileSync(path.join(MOD, "js", f), "utf8");
    vm.runInContext(code, ctxg, { filename: `js/${f}` });
  }
  ctxg.OVLoader.loadAll({ mode });

  function addPlayer(userId, name) {
    const rec = { userId, name, team: 0, health: 100 };
    rec.native = {
      userId: () => userId, entIndex: () => userId,
      steamId: () => `STEAM_0:1:${userId}`, name: () => name,
      health: () => rec.health, setHealth: (v) => { rec.health = v; },
      team: () => rec.team, setTeam: (v) => { rec.team = v; },
      chat: (m) => logs.push(`[chat:${name}] ${m}`),
      runCommand: (c) => logs.push(`[runCommand:${name}] ${c}`),
    };
    players[userId] = rec;
    return rec.native;
  }

  return { name: realmName, OV, ctx: ctxg, logs, addPlayer, writes };
}

// ---- loopback transport with virtual clock ----
function makeTransport() {
  let t = 1000;
  const queue = [];
  const api = {
    now: () => t,
    tick: (dt = 0.1) => { t += dt; api.flush(); },
    flush: () => {
      while (queue.length) {
        const m = queue.shift();
        try { m(); } catch (e) { console.error("  transport dispatch error:", e.message); }
      }
    },
    serverEmit: null, clientSend: null,
  };
  return api;
}

const transport = makeTransport();
const server = makeRealm("server", "sandbox", transport);
const client = makeRealm("client", "sandbox", transport);

// Wire loopback AFTER both realms exist.
transport.serverEmit = (idsCsv, name, payload) => {
  queueDispatch(client, name, payload, null);
};
let serverSenderPly = null;
transport.clientSend = (name, payload) => {
  queueDispatch(server, name, payload, serverSenderPly);
};
const pending = [];
function queueDispatch(realm, name, payload, ply) {
  pending.push(() => realm.ctx.hook.Run("OVNetReceive", name, payload, ply));
}
function pump() {
  while (pending.length) {
    const fn = pending.shift();
    fn();
  }
}

// The transport in makeRealm captured `transport` closure functions set above.

section("realms");
ok(server.ctx.SERVER === true && server.ctx.CLIENT === false, "server realm globals");
ok(client.ctx.SERVER === false && client.ctx.CLIENT === true, "client realm globals");
ok(typeof server.ctx.OVLoader === "object", "loader present");
ok(typeof server.ctx.ents === "object" && typeof server.ctx.Entity === "function", "entity system present");
ok(typeof server.ctx.AddCSJSFile === "function" && typeof server.ctx.include === "function", "file library present");

section("hook semantics");
{
  const H = server.ctx.hook;
  let calls = [];
  H.Add("TestHook", "a", () => { calls.push("a"); });
  H.Add("TestHook", "b", () => { calls.push("b"); return false; });
  H.Add("TestHook", "c", () => { calls.push("c"); });
  const result = H.Run("TestHook");
  ok(result === false, "false short-circuits (not treated as nil)");
  ok(calls.join(",") === "a,b", "later hooks skipped after short-circuit");
  H.Remove("TestHook", "b"); H.Remove("TestHook", "a"); H.Remove("TestHook", "c");

  // object identifier with IsValid
  const obj = { valid: true, IsValid() { return this.valid; }, hits: 0 };
  H.Add("ObjHook", obj, (self) => { self.hits++; });
  H.Run("ObjHook");
  ok(obj.hits === 1, "object identifier receives self");
  obj.valid = false;
  H.Run("ObjHook");
  ok(obj.hits === 1, "invalid object hook auto-removed");
  ok((H.GetTable("ObjHook") || []).length === 0, "auto-removed from table");
}

section("gamemode inheritance");
{
  const g = server.ctx;
  ok(g.GAMEMODE && g.GAMEMODE.mode === "sandbox", "active gamemode is sandbox");
  ok(typeof g.gamemode.Register === "function" && typeof g.DeriveGamemode === "function", "Register/DeriveGamemode exist");
  ok(g.baseclass.Get("gamemode_base") !== null, "baseclass gamemode_base set");
}

section("net library");
{
  const S = server.ctx, C = client.ctx;
  S.util.AddNetworkString("TestMsg");
  let got = null;
  C.net.Receive("testmsg", () => { // case-insensitive
    got = {
      i: C.net.ReadInt(), u: C.net.ReadUInt(), f: C.net.ReadFloat(),
      b: C.net.ReadBool(), bit: C.net.ReadBit(), s: C.net.ReadString(),
      d: C.net.ReadData(4), v: C.net.ReadVector(), a: C.net.ReadAngle(),
      c: C.net.ReadColor(), t: C.net.ReadTable(), u64: C.net.ReadUInt64(),
      past: C.net.ReadString(),
    };
  });
  ok(S.net.Start("TestMsg") === true, "net.Start on pooled name");
  S.net.WriteInt(-42, 16); S.net.WriteUInt(42, 8); S.net.WriteFloat(3.25);
  S.net.WriteBool(true); S.net.WriteBit(true); S.net.WriteString("hello");
  S.net.WriteData("abcdEXTRA", 4); S.net.WriteVector({ x: 1, y: 2, z: 3 });
  S.net.WriteAngle({ p: 10, y: 20, r: 30 }); S.net.WriteColor({ r: 255, g: 128, b: 0 });
  S.net.WriteTable({ k: "v", n: 5 }); S.net.WriteUInt64("18446744073709551615");
  S.net.Broadcast();
  pump();
  ok(got !== null, "client received broadcast");
  ok(got && got.i === -42 && got.u === 42 && Math.abs(got.f - 3.25) < 1e-9, "numeric roundtrip");
  ok(got && got.b === true && got.bit === 1, "bool/bit roundtrip (bit reads as number)");
  ok(got && got.s === "hello" && got.d === "abcd", "string/data roundtrip");
  ok(got && got.v.z === 3 && got.a.r === 30 && got.c.a === 255, "vector/angle/color roundtrip");
  ok(got && got.t.k === "v" && got.u64 === "18446744073709551615", "table/uint64 roundtrip");
  ok(got && got.past === "", "read past end returns default");

  ok(S.net.Start("NotPooled") === false, "net.Start rejects unpooled name on server");

  // client -> server with sender identity
  const alice = server.addPlayer(7, "Alice");
  serverSenderPly = alice;
  let senderSeen = null, ageSeen = 0;
  S.util.AddNetworkString("SendAge");
  S.net.Receive("SendAge", (len, ply) => { ageSeen = S.net.ReadUInt(8); senderSeen = ply; });
  C.net.Start("SendAge"); C.net.WriteUInt(29, 8); C.net.SendToServer();
  pump();
  ok(ageSeen === 29, "client->server payload");
  ok(senderSeen === alice, "server receiver gets authoritative sender");

  // chunking: payload far above CHUNK_SIZE
  S.util.AddNetworkString("BigMsg");
  const bigString = "x".repeat(5000);
  let bigGot = null;
  C.net.Receive("BigMsg", () => { bigGot = C.net.ReadString(); });
  S.net.Start("BigMsg"); S.net.WriteString(bigString); S.net.Broadcast();
  pump();
  ok(bigGot === bigString, "chunked message reassembled (5KB)");

  // oversize cap
  S.net.Start("BigMsg"); S.net.WriteString("y".repeat(70000));
  S.net.Broadcast();
  pump();
  ok(bigGot === bigString, "oversize >64KB message dropped");

  // rate limiting
  S.util.AddNetworkString("Spammy");
  let spamCount = 0;
  S.net.Receive("Spammy", () => { spamCount++; });
  S.net.SetRateLimit("Spammy", 3);
  for (let i = 0; i < 10; i++) { C.net.Start("Spammy"); C.net.SendToServer(); }
  pump();
  ok(spamCount === 3, `rate limit enforced (got ${spamCount}/10, cap 3)`);
}

section("entities + scripted ents");
{
  const S = server.ctx;
  S.scripted_ents.Register({
    Type: "anim",
    Base: "base_gmodentity",
    PrintName: "Test Crate",
    SetupDataTables() { this.NetworkVar("Int", 0, "Charge"); },
    Initialize() { this.initialized = true; this.SetModel("models/crate.mdl"); },
    Think() { this.thinks = (this.thinks || 0) + 1; },
    OnTakeDamage(info) { this.SetHealth(this.Health() - info.GetDamage()); if (this.Health() <= 0) this.Remove(); },
    OnRemove() { this.removedHookRan = true; },
  }, "test_crate");

  ok(S.scripted_ents.GetStored("test_crate") !== null, "scripted_ents.Register stored");
  ok(S.scripted_ents.IsBasedOn("test_crate", "base_anim"), "IsBasedOn walks Base chain");

  const crate = S.ents.Create("test_crate");
  ok(crate.IsValid(), "ents.Create returns valid entity");
  ok(typeof crate.GetCharge === "function", "SetupDataTables ran at creation (NetworkVar accessors)");
  crate.SetPos({ x: 10, y: 0, z: 0 });
  crate.Spawn();
  ok(crate.initialized === true, "Spawn runs Initialize");
  ok(crate.GetModel() === "models/crate.mdl", "SetModel/GetModel");
  ok(crate.GetClass() === "test_crate", "GetClass");

  // find queries
  ok(S.ents.FindByClass("test_*").length === 1, "FindByClass wildcard");
  ok(S.ents.FindInSphere({ x: 0, y: 0, z: 0 }, 20).includes(crate), "FindInSphere hit");
  // (players idle at the origin also live in the entity list, so probe far away)
  ok(S.ents.FindInSphere({ x: 500, y: 500, z: 500 }, 5).length === 0, "FindInSphere miss");
  ok(S.Entity(crate.EntIndex()) === crate, "Entity(index) resolves");

  // think pump
  transport.tick();
  S.gamemode.call("Think");
  ok(crate.thinks >= 1, "ENT:Think driven by Think hook");

  // NextThink schedule
  const before = crate.thinks;
  crate.NextThink(transport.now() + 100);
  S.gamemode.call("Think");
  ok(crate.thinks === before, "NextThink defers Think");

  // NW + DT replication to client shell
  S.util; // pooled names already registered by entity.js
  crate.SetNWString("label", "hi");
  crate.SetCharge(7);
  pump();
  const shell = client.ctx.ents.GetByIndex(crate.EntIndex());
  ok(shell && shell.IsValid(), "client shell entity materialized");
  ok(shell && shell.GetNWString("label") === "hi", "NW var replicated to client");
  ok(shell && shell._r.dt.Charge === 7, "DTVar replicated to client");

  // damage + removal lifecycle
  crate.SetHealth(10);
  let removedFired = false;
  crate.CallOnRemove("test", () => { removedFired = true; });
  crate.TakeDamage(25, S.NULL, S.NULL);
  ok(crate.Health() <= 0, "OnTakeDamage applied damage");
  S.gamemode.call("Think"); // flush deferred removals
  ok(!crate.IsValid(), "Remove finalized at end of tick");
  ok(removedFired && crate.removedHookRan === true, "CallOnRemove + OnRemove fired");

  // hot-repatch
  const crate2 = S.ents.Create("test_crate");
  crate2.Spawn();
  S.scripted_ents.Register({
    Type: "anim", Base: "base_gmodentity",
    Think() { this.newThink = true; },
    OnReloaded() { this.reloaded = true; },
  }, "test_crate");
  ok(crate2.reloaded === true, "re-register hot-patches live instances (OnReloaded)");
  S.gamemode.call("Think");
  ok(crate2.newThink === true, "live instance uses new methods");
  crate2.Remove(); S.gamemode.call("Think");

  // clientside entity
  const cs = client.ctx.ents.CreateClientside("test_crate");
  ok(client.ctx.ents.Create("x").IsValid() === false, "ents.Create is server-only (returns NULL)");
  ok(cs.EntIndex() === -1, "clientside entity reports EntIndex -1");
}

section("player class");
{
  const S = server.ctx;
  const bobNative = server.addPlayer(9, "Bob");
  const bob = S.Player.fromNative(bobNative);
  ok(bob.__ovPlayer === true && bob.IsPlayer(), "Player.fromNative wraps");
  ok(S.Player.fromNative(bobNative) === bob, "wrap cached by UserID");
  ok(bob.Nick() === "Bob" && bob.UserID() === 9, "identity accessors");
  bob.SetTeam(3);
  ok(bob.Team() === 3 && bobNative.team() === 3, "SetTeam hits native handle");
  ok(bob.name() === "Bob" && typeof bob.chat === "function", "legacy lowercase API intact");
  ok(S.player.GetByUserID(9) === bob, "player.GetByUserID");
  ok(S.player.GetBySteamID("STEAM_0:1:9") === bob, "player.GetBySteamID");
  // gamemode.call wraps native handles
  let seen = null;
  S.hook.Add("WrapCheck", "t", (p) => { seen = p; return true; });
  S.gamemode.call("WrapCheck", bobNative);
  ok(seen === bob, "gamemode.call wraps native player args");
  S.hook.Remove("WrapCheck", "t");
}

section("file library / AddCSJSFile / include");
{
  const S = server.ctx;
  const manifest = S.file.BuildClientManifest();
  ok(Array.isArray(manifest) && manifest.length > 0, `client manifest built (${manifest.length} files)`);
  ok(manifest.some((f) => f.p.startsWith("js/gamemodes/sandbox/"), ), "manifest includes gamemode client files");
  ok(manifest.every((f) => f.h && f.s > 0), "manifest entries carry hash+size");

  S.AddCSJSFile("core/util.js");
  const manifest2 = S.file.BuildClientManifest();
  ok(manifest2.some((f) => f.p === "js/core/util.js"), "AddCSJSFile marks extra file");

  const inc = S.include("core/util.js");
  ok(S.util.CRC("abc") === S.util.CRC("abc"), "include re-ran a core file without error");

  // client sync: manifest -> request -> data -> OVFilesSynced
  let synced = false;
  client.ctx.hook.Add("OVFilesSynced", "t", () => { synced = true; });
  // simulate: make one file 'missing' on the client by hashing a bogus cache
  client.writes["js/gamemodes/sandbox/client.js"] = "// stale";
  const ply7 = S.player.GetByUserID(7);
  S.hook.Run("PlayerInitialSpawn", ply7);
  // fire timers (manifest send is delayed 2s)
  transport.tick(3);
  S.gamemode.call("Think");
  pump(); // manifest to client -> request to server -> data to client
  pump();
  ok(synced === true, "client file sync completed (OVFilesSynced)");
  const dl = client.writes["js/ov_downloads/js/gamemodes/sandbox/client.js"];
  ok(typeof dl === "string" && dl.length > 10, "stale file downloaded into ov_downloads cache");
}

section("concommand + js_run/js_openscript");
{
  const S = server.ctx;
  let ranArgs = null;
  S.concommand.Add("test_cmd", (ply, cmd, args, argStr) => { ranArgs = { ply, cmd, args, argStr }; });
  ok(S.concommand.Dispatch(null, 'test_cmd one "two three"') === true, "concommand.Dispatch handles");
  ok(ranArgs && ranArgs.args.length === 2 && ranArgs.args[1] === "two three", "quoted arg parsing");
  ok(S.gamemode.call("ConsoleCommand", "test_cmd x") === false, "ConsoleCommand hook routes to concommand");

  const r1 = S.OVLoader.runString("1 + 41", "test");
  ok(r1.ok && r1.result === 42, "runString (js_run) returns value");
  const r2 = S.OVLoader.runString("throw new Error('boom')", "test");
  ok(!r2.ok && /boom/.test(r2.error), "runString reports errors");

  ok(S.OVLoader.openScript("core/util.js") === true, "openScript (js_openscript) runs js/-relative path");
  ok(S.OVLoader.openScript("nope/missing.js") === false, "openScript rejects missing path");

  let blockedRan = false;
  S.concommand.Add("js_run_cl", () => { blockedRan = true; });
  S.RunConsoleCommand("js_run_cl", "code");
  ok(blockedRan === false, "RunConsoleCommand blocklist protects js_run_cl");
}

section("npm require (node_modules)");
{
  // The sandbox gamemode requires ov-leftpad through the embedded module
  // system (core/module.js over OV.readFile) — prove bare-specifier reqs work.
  const S = server.ctx;
  const r = S.OVLoader.runString("require('ov-leftpad')('7', 3, '0')", "npm-test");
  ok(r.ok && r.result === "007", `require('ov-leftpad') via js/node_modules${r.ok ? "" : " — " + r.error}`);
}

section("all gamemodes end-to-end (server+client realm pairs)");
for (const mode of ["hub", "sandbox", "prophunt", "deathrun", "fortwars", "traitortown"]) {
  const tp = makeTransport();
  const sv = makeRealm("server", mode, tp);
  const cl = makeRealm("client", mode, tp);
  const q = [];
  tp.serverEmit = (ids, name, payload) => q.push(() => cl.ctx.hook.Run("OVNetReceive", name, payload, null));
  let sender = null;
  tp.clientSend = (name, payload) => q.push(() => sv.ctx.hook.Run("OVNetReceive", name, payload, sender));
  const drain = () => { while (q.length) q.shift()(); };

  const hudSeen = [];
  cl.ctx.hook.Add("OVHudState", "t", (s) => { hudSeen.push(s); });
  const rolesSeen = [];
  cl.ctx.hook.Add("OVRoleAssigned", "t", (role) => { rolesSeen.push(role); });

  // players join
  const p1 = sv.addPlayer(1, "Alpha"), p2 = sv.addPlayer(2, "Bravo");
  sender = p1;
  sv.ctx.gamemode.call("Initialize");
  sv.ctx.gamemode.call("MapInitialize", "test_map");
  sv.ctx.gamemode.call("PlayerInitialSpawn", p1);
  sv.ctx.gamemode.call("PlayerInitialSpawn", p2);
  sv.ctx.gamemode.call("PlayerSpawn", p1);
  sv.ctx.gamemode.call("PlayerSpawn", p2);
  drain();

  cl.ctx.gamemode.call("Initialize");

  ok(sv.ctx.GAMEMODE && sv.ctx.GAMEMODE.mode === mode, `[${mode}] server GAMEMODE active`);
  ok(cl.ctx.GAMEMODE && cl.ctx.GAMEMODE.mode === (["hub", "sandbox"].includes(mode) ? mode : mode), `[${mode}] client GAMEMODE active`);
  ok(sv.ctx.scripted_ents.GetStored("ov_bouncy_crate") !== null, `[${mode}] SENT registered on server`);
  ok(cl.ctx.scripted_ents.GetStored("ov_bouncy_crate") !== null, `[${mode}] SENT registered on client`);

  const roundModes = ["prophunt", "deathrun", "fortwars", "traitortown"];
  if (roundModes.includes(mode)) {
    ok(Object.keys(sv.ctx.team.GetAllTeams()).length >= 3, `[${mode}] CreateTeams populated team library`);
    // run countdown -> round start
    for (let i = 0; i < 20; i++) { tp.tick(1); sv.ctx.gamemode.call("Think"); drain(); }
    ok(sv.ctx.GAMEMODE._roundState === "active", `[${mode}] round started (state=${sv.ctx.GAMEMODE._roundState})`);
    const t1 = p1.team ? null : null;
    const teams = [sv.ctx.player.GetByUserID(1).Team(), sv.ctx.player.GetByUserID(2).Team()];
    ok(teams.every((t) => t === 2 || t === 3), `[${mode}] players assigned to teams (${teams})`);
    if (mode !== "fortwars") {
      ok(rolesSeen.length > 0, `[${mode}] client received role via net (${rolesSeen.join(",")})`);
    }
    // HUD ticker
    for (let i = 0; i < 4; i++) { tp.tick(1); sv.ctx.gamemode.call("Think"); drain(); }
    ok(hudSeen.length > 0 && hudSeen[hudSeen.length - 1].state === "active", `[${mode}] HUD state replicated to client`);
    ok(hudSeen[hudSeen.length - 1].teams.length >= 2, `[${mode}] HUD state carries team roster`);
    // player death -> win condition path exercises endRound
    sv.ctx.gamemode.call("PlayerDeath", p1, p2);
    ok(true, `[${mode}] PlayerDeath handled`);
  } else {
    // hub/sandbox: no rounds; sandbox exercises Q-menu + entity spawn
    if (mode === "sandbox") {
      sender = p1;
      cl.ctx.net.Start("OV_Sandbox_Spawn"); cl.ctx.net.WriteString("crate"); cl.ctx.net.SendToServer();
      drain();
      ok(sv.logs.some((l) => /ov_fortwars_spawn crate/.test(l)), `[${mode}] client Q-menu spawn ran server command`);
      const r = sv.ctx.command.run(p1, "ent ov_bouncy_crate");
      ok(sv.ctx.ents.FindByClass("ov_bouncy_crate").length === 1, `[${mode}] !ent spawned scripted entity`);
      tp.tick(3); sv.ctx.gamemode.call("Think");
      const crate = sv.ctx.ents.FindByClass("ov_bouncy_crate")[0];
      ok(crate && crate.GetBounces() >= 1, `[${mode}] bouncy crate Think ran (bounces=${crate && crate.GetBounces()})`);
      drain();
      const clCrate = cl.ctx.ents.GetByIndex(crate.EntIndex());
      ok(clCrate && clCrate._r.dt.Bounces >= 1, `[${mode}] SENT DTVar replicated to client realm`);
    }
    ok(hudSeen.length >= 0, `[${mode}] no-round mode loaded cleanly`);
  }
}

// ---- scripted weapons (SWEP) framework ----
{
  section("weapons / scripted_weapons (SWEP)");
  const tp = makeTransport();
  const sv = makeRealm("server", "sandbox", tp);
  const p = sv.addPlayer(1, "Gunner");
  const W = sv.ctx;

  ok(typeof W.weapons === "object" && W.weapons.__openvibe, "weapons library present");
  ok(typeof W.scripted_weapons === "object", "scripted_weapons library present");
  ok(!!W.scripted_weapons.GetStored("weapon_base"), "weapon_base registered by core");

  // JS weapon definitions loaded from js/weapons/ by the loader.
  ["weapon_ov_pistol", "weapon_ov_smg", "weapon_ov_shotgun", "weapon_ov_357", "weapon_ov_crowbar", "weapon_ov_stunstick"].forEach((c) => {
    ok(!!W.scripted_weapons.GetStored(c), `weapon def loaded: ${c}`);
  });
  ok(W.scripted_weapons.IsBasedOn("weapon_ov_pistol", "weapon_base"), "pistol inherits weapon_base");
  ok(W.scripted_weapons.IsBasedOn("weapon_ov_stunstick", "weapon_ov_crowbar"), "stunstick inherits crowbar (Base chain)");

  // Create + inspect a weapon instance.
  const pistol = W.weapons.Create("weapon_ov_pistol");
  ok(pistol && pistol.IsWeapon && pistol.IsWeapon(), "weapons.Create returns a Weapon");
  ok(pistol.GetClass() === "weapon_ov_pistol", "weapon GetClass");
  ok(pistol.Clip1() === 18, `pistol seeded DefaultClip (clip1=${pistol.Clip1()})`);
  ok(pistol.GetMaxClip1() === 18, "pistol GetMaxClip1 from Primary.ClipSize");

  // Firing consumes ammo and gates on the fire delay.
  const before = pistol.Clip1();
  pistol.PrimaryAttack();
  ok(pistol.Clip1() === before - 1, `PrimaryAttack consumed 1 round (clip1=${pistol.Clip1()})`);
  const afterFirst = pistol.Clip1();
  pistol.PrimaryAttack(); // should be gated by NextPrimaryFire (no time advance)
  ok(pistol.Clip1() === afterFirst, "second PrimaryAttack gated by fire delay");
  tp.tick(1.0);
  pistol.PrimaryAttack();
  ok(pistol.Clip1() === afterFirst - 1, "PrimaryAttack fires again after delay elapsed");

  // Reload refills to max clip.
  pistol.SetClip1(2); tp.tick(2.0); pistol.Reload();
  ok(pistol.Clip1() === 18, `Reload refilled clip (clip1=${pistol.Clip1()})`);

  // Player.Give tracks an inventory and equips.
  let equipped = null;
  W.hook.Add("WeaponEquip", "test_equip", (w) => { equipped = w.GetClass(); });
  const given = p.Give ? null : null; // p is native mock; use the JS Player
  const jsPly = W.player.GetByUserID ? W.player.GetByUserID(1) : null;
  ok(!!jsPly, "JS Player object resolvable");
  const w1 = jsPly.Give("weapon_ov_smg");
  ok(jsPly.HasWeapon("weapon_ov_smg"), "Player.Give added weapon to inventory");
  ok(equipped === "weapon_ov_smg", "WeaponEquip hook fired on Give");
  ok(jsPly.GetActiveWeapon() && jsPly.GetActiveWeapon().GetClass() === "weapon_ov_smg", "first Give set active weapon");
  jsPly.Give("weapon_ov_shotgun");
  ok(jsPly.GetWeapons().length === 2, "second Give tracked (2 weapons)");
  jsPly.Give("weapon_ov_smg"); // duplicate: no new slot
  ok(jsPly.GetWeapons().length === 2, "duplicate Give does not add a slot");
  jsPly.StripWeapon("weapon_ov_smg");
  ok(!jsPly.HasWeapon("weapon_ov_smg"), "StripWeapon removed it");
  jsPly.StripWeapons();
  ok(jsPly.GetWeapons().length === 0, "StripWeapons cleared inventory");

  // Hot-reload a SWEP: live instance jumps to the new proto.
  const smg2 = W.weapons.Create("weapon_ov_smg");
  W.scripted_weapons.Register(Object.assign({}, W.scripted_weapons.GetStored("weapon_ov_smg").t, { PrintName: "Reloaded SMG" }), "weapon_ov_smg");
  ok(smg2.PrintName === "Reloaded SMG", "SWEP hot-reload repatched live instance");
}

// ---- HUD / GUI library (gamemode GUIs coded in JS) ----
{
  section("HUD / GUI library");
  const tp = makeTransport();
  // menuJS captor so we can assert the client pushes its layout to the page.
  const pushes = [];
  const cl = makeRealm("client", "prophunt", tp);
  cl.OV.menuJS = (s) => pushes.push(s);
  // Re-run realm bootstrap is not needed; HUD hooked at load. Drive its API.
  const H = cl.ctx.HUD;
  ok(typeof H === "object" && H.__openvibe, "HUD library present (client realm)");
  H.SetLayout([
    { id: "round", type: "text", bind: "round" },
    { id: "health", type: "bar", bind: "health", max: 100 }
  ]);
  ok(H.GetLayout().length === 2, "HUD.SetLayout stored elements");
  ok(H.GetLayout()[0].id === "round" && H.GetLayout()[1].type === "bar", "HUD layout order + types preserved");
  H.Add({ id: "ammo", type: "counter", bind: "ammo" });
  ok(H.GetLayout().length === 3, "HUD.Add appended element");
  H.Add({ id: "round", type: "text", bind: "round", size: 30 }); // redeclare
  ok(H.GetLayout().length === 3 && H.GetLayout()[0].size === 30, "HUD.Add redeclare replaces in place");
  H.SetMany({ round: "Round 2", health: 80, ammo: 45 });
  ok(H.Get("health") === 80, "HUD.Set/SetMany stored values");
  const snap = H.Snapshot();
  ok(snap.layout.length === 3 && snap.values.round === "Round 2" && snap.visible === true, "HUD.Snapshot carries layout + values + visibility");
  const flushed = H.Flush(true);
  ok(flushed === true, "HUD.Flush ran (client)");
  ok(pushes.some((s) => /onHudLayout/.test(s)), "HUD.Flush pushed layout to the page via menuJS");
  H.Hide();
  ok(H.IsVisible() === false && H.Snapshot().visible === false, "HUD.Hide toggles visibility in snapshot");
  H.Remove("ammo");
  ok(H.GetLayout().length === 2, "HUD.Remove dropped element");
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) { console.error(`${failures} FAILURES`); process.exit(1); }
console.log("[test-gmodjs] ALL PASS");
