// OpenVibe economy — server realm.
// Fetches per-player economy state from the OpenVibe backend, pushes it to
// the owning client ("OVEcon_State"), grants equipped perma weapons on
// spawn (mapped to HL2DM classes) and gates cade buying on the synced state.
//
// Backend HTTP requires Node's http module (ov_js_backend node). The embedded
// QuickJS backend has no http — the addon degrades gracefully: one warning,
// sync skipped, everything else (loadout hooks, cade validation with defaults)
// still runs.
(function () {
  var OV = globalThis.OV;
  var D = globalThis.OVEconomy;
  if (!D) { OV && OV.error && OV.error("[ov-econ] shared.js did not load; server disabled"); return; }

  function log(m) { if (OV && OV.log) OV.log("[ov-econ] " + m); }
  function warn(m) { if (OV && OV.warn) OV.warn("[ov-econ] " + m); }

  // ---- config ----
  // Default backend base; override with the OVECON_API_BASE env var when the
  // Node runtime host has one (the embedded backend has no process/env at all).
  var API_BASE = "http://127.0.0.1:3000";
  try {
    if (typeof process !== "undefined" && process.env && process.env.OVECON_API_BASE) {
      API_BASE = String(process.env.OVECON_API_BASE).replace(/\/+$/, "");
    }
  } catch (e) { /* no env access */ }

  // Server identity for server-authenticated economy calls (charge/reward).
  // Defaults pair with backend/.env OPENVIBE_DEFAULT_SERVER_SECRET=dev-secret.
  var SERVER_ID = "local-dev";
  var SERVER_SECRET = "dev-secret";
  try {
    if (typeof process !== "undefined" && process.env) {
      if (process.env.OPENVIBE_SERVER_ID) SERVER_ID = String(process.env.OPENVIBE_SERVER_ID);
      if (process.env.OPENVIBE_SERVER_SECRET) SERVER_SECRET = String(process.env.OPENVIBE_SERVER_SECRET);
    }
  } catch (e) { /* no env access */ }

  // ---- Node http feature detection (embedded QuickJS: require('http') throws) ----
  var http = null;
  try { http = require("http"); } catch (e) { /* not the node backend */ }
  if (!http || typeof http.get !== "function") {
    http = null;
    warn("Node http unavailable (embedded backend?) — backend economy sync disabled");
  }

  // ---- net strings ----
  util.AddNetworkString(D.NET_STATE);
  util.AddNetworkString(D.NET_REFRESH);
  util.AddNetworkString(D.NET_CADE_BUY);
  net.SetRateLimit(D.NET_REFRESH, 2);
  net.SetRateLimit(D.NET_CADE_BUY, 5);

  // ---- per-player caches ----
  var stateBySteam64 = Object.create(null); // steamId64 -> backend EconomyStateView
  var warnedClasses = Object.create(null);  // devolved class -> true (once-per-class log)
  var cadeCounts = Object.create(null);     // userId -> cades placed this life
  var cadeLastPlace = Object.create(null);  // userId -> OV.time() of last placement

  function steam64Of(ply) {
    if (!ply) return null;
    if (typeof ply.SteamID64 === "function") return ply.SteamID64();
    var sid = typeof ply.SteamID === "function" ? ply.SteamID() : (typeof ply.steamId === "function" ? ply.steamId() : null);
    return util.SteamIDTo64 ? util.SteamIDTo64(sid) : null;
  }

  // ---- tiny promise helper over http.get ----
  function httpGetJson(url) {
    return new Promise(function (resolve, reject) {
      if (!http) return reject(new Error("http unavailable"));
      var req = http.get(url, function (res) {
        var buf = "";
        res.setEncoding("utf8");
        res.on("data", function (c) { buf += c; });
        res.on("end", function () {
          var json;
          try { json = JSON.parse(buf); }
          catch (e) { return reject(new Error("bad JSON from " + url)); }
          if (res.statusCode !== 200) return reject(new Error((json && json.error) || ("HTTP " + res.statusCode)));
          resolve(json);
        });
      });
      req.on("error", reject);
      req.setTimeout(5000, function () { req.destroy(new Error("timeout")); });
    });
  }

  function httpPostJson(pathname, body) {
    return new Promise(function (resolve, reject) {
      if (!http) return reject(new Error("http unavailable"));
      var base = /^http:\/\/([^/:]+)(?::(\d+))?/.exec(API_BASE);
      if (!base) return reject(new Error("unsupported API base " + API_BASE));
      var payload = JSON.stringify(body);
      var req = http.request({
        host: base[1],
        port: base[2] ? base[2] | 0 : 80,
        path: pathname,
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": typeof Buffer !== "undefined" ? Buffer.byteLength(payload) : payload.length
        }
      }, function (res) {
        var buf = "";
        res.setEncoding("utf8");
        res.on("data", function (c) { buf += c; });
        res.on("end", function () {
          var json;
          try { json = JSON.parse(buf); }
          catch (e) { return reject(new Error("bad JSON from " + pathname)); }
          if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error((json && json.error) || ("HTTP " + res.statusCode)));
          resolve(json);
        });
      });
      req.on("error", reject);
      req.setTimeout(5000, function () { req.destroy(new Error("timeout")); });
      req.end(payload);
    });
  }

  // Test seam: the harness has no Node http, so it injects a fake POST here.
  var postJsonOverride = null;
  function postJson(pathname, body) { return (postJsonOverride || httpPostJson)(pathname, body); }
  function canReachBackend() { return !!http || !!postJsonOverride; }

  // ---- one-time server registration (charge/reward 403 until registered) ----
  var VALID_MODES = ["hub", "prophunt", "deathrun", "fortwars", "traitortown"];
  var registerRetries = 0;
  var registered = false;
  function ensureRegistered() {
    if (!canReachBackend() || registered) return;
    var mode = OV && OV.getMode ? String(OV.getMode()) : "hub";
    if (VALID_MODES.indexOf(mode) < 0) mode = "hub"; // register schema enum
    postJson("/v1/servers/register", {
      serverId: SERVER_ID,
      serverSecret: SERVER_SECRET,
      mode: mode,
      mapName: String((OV && OV.getMapName && OV.getMapName()) || "unknown"),
      publicHost: "127.0.0.1",
      port: 27015,
      maxPlayers: 48
    }).then(function () {
      registered = true;
      log("registered server '" + SERVER_ID + "' with backend");
    }).catch(function (e) {
      // Backend may still be starting (game and API race at boot): keep
      // retrying with backoff so charges/rewards work once it's up.
      registerRetries++;
      var delay = Math.min(60, 5 * registerRetries);
      if (registerRetries === 1) {
        warn("server register failed: " + (e && e.message) + " — retrying every " + delay + "s+ until the backend is reachable");
      }
      if (globalThis.timer && timer.Simple) timer.Simple(delay, ensureRegistered);
    });
  }

  // ---- state -> client payload (equipped-only subset, HUD-sized) ----
  function buildClientState(view) {
    var weps = {};
    var lw = (view.loadout && view.loadout.weps) || {};
    for (var name in lw) {
      var e = lw[name];
      if (e && e.equipped) weps[name] = { class: e.class, slot: e.slot == null ? null : e.slot };
    }
    return {
      bucks: view.player.bucks | 0,
      lvl: view.player.lvl | 0,
      xp: view.player.xp | 0,
      xpInLevel: view.player.xpInLevel | 0,
      xpNext: view.player.xpNext | 0,
      weps: weps,
      equippedCosmetics: (view.loadout && view.loadout.equipped) || {}
    };
  }

  function pushState(ply) {
    var sid = steam64Of(ply);
    var view = sid && stateBySteam64[sid];
    if (!view) return false;
    try {
      net.Start(D.NET_STATE);
      net.WriteTable(buildClientState(view));
      net.Send(ply);
    } catch (e) { warn("push failed: " + (e && e.message)); return false; }
    // Mirror onto the shared Player economy accessors (NW-var replicated),
    // so GetMoney()/GetLevel() agree with the backend everywhere.
    if (typeof ply.SetMoney === "function") ply.SetMoney(view.player.bucks | 0);
    if (typeof ply.SetLevel === "function") ply.SetLevel(view.player.lvl | 0);
    return true;
  }

  function syncPlayer(ply, andPush) {
    var sid = steam64Of(ply);
    if (!sid) return; // bot / unresolved SteamID
    if (!http) return; // embedded backend — warned once at load
    httpGetJson(API_BASE + "/v1/economy/state?steamId=" + encodeURIComponent(sid))
      .then(function (view) {
        if (!view || !view.player) throw new Error((view && view.error) || "malformed state");
        stateBySteam64[sid] = view;
        log("synced " + sid + " (bucks=" + view.player.bucks + " lvl=" + view.player.lvl + ")");
        if (andPush !== false) pushState(ply);
      })
      .catch(function (e) { warn("state fetch failed for " + sid + ": " + (e && e.message)); });
  }

  // ---- hooks ----
  hook.Add("PlayerInitialSpawn", "OVEconomy.Sync", function (ply) {
    syncPlayer(ply, true);
    return undefined;
  });

  // Perma weapon grant: base GM.PlayerSpawn runs hook.Run("PlayerLoadout", ply).
  hook.Add("PlayerLoadout", "OVEconomy.Loadout", function (ply) {
    if (ply && typeof ply.UserID === "function") cadeCounts[ply.UserID()] = 0; // new life
    var sid = steam64Of(ply);
    var view = sid && stateBySteam64[sid];
    if (!view) return undefined;
    var lw = (view.loadout && view.loadout.weps) || {};
    for (var name in lw) {
      var entry = lw[name];
      if (!entry || !entry.equipped || !entry.class) continue;
      var mapped = D.MapWeaponClass(entry.class);
      if (!mapped) {
        if (!warnedClasses[entry.class]) {
          warnedClasses[entry.class] = true;
          log("no HL2DM mapping for '" + entry.class + "' (" + name + ") — skipped");
        }
        continue;
      }
      if (typeof ply.Give === "function") ply.Give(mapped);
    }
    return undefined; // never override other loadout hooks
  });

  // Client-requested refresh (bound client-side to ov_econ_refresh).
  net.Receive(D.NET_REFRESH, function (len, ply) {
    if (ply) syncPlayer(ply, true);
  });

  // Server console: ov_econ_refresh [userId] — re-fetch one or all players.
  concommand.Add("ov_econ_refresh", function (_ply, _cmd, args) {
    var uid = args && args[0] ? args[0] | 0 : 0;
    var targets = uid ? [player.GetByUserID(uid)].filter(Boolean) : player.GetAll();
    log("refresh requested for " + targets.length + " player(s)");
    targets.forEach(function (p) { syncPlayer(p, true); });
  }, null, "Re-fetch OpenVibe economy state from the backend (optionally for one userId)");

  // ---- cade buy/placement, gated on the synced economy state ----
  // Ownership/level/balance/cap/cooldown are enforced HERE from the cached
  // backend state (fast path); the bucks charge is then persisted through
  // POST /v1/economy/server/charge. If the backend disagrees
  // (insufficient_bucks) the placement is revoked; on network hiccups we fall
  // back to the old local soft-debit so gameplay never blocks on the backend.
  function cadeVerdict(ply, name) {
    if (!globalThis.cades) return { ok: false, reason: "cades library missing" };
    var def = cades.Get(name);
    if (!def) return { ok: false, reason: "unknown cade '" + name + "'" };
    var sid = steam64Of(ply);
    var view = sid ? stateBySteam64[sid] : null;
    var lvl = view ? view.player.lvl | 0 : 0;
    var bucks = view ? view.player.bucks | 0 : 0;
    var owned = !!(view && view.loadout && view.loadout.cades && view.loadout.cades[def.name]);
    if (def.hidden && !owned) return { ok: false, reason: "not owned" };
    if ((def.level | 0) > lvl) return { ok: false, reason: "requires level " + def.level };
    if ((def.cost | 0) > bucks) return { ok: false, reason: "needs " + def.cost + " bucks" };
    var uid = typeof ply.UserID === "function" ? ply.UserID() : -1;
    var cap = (def.perPlayerMax | 0) || cades.GLOBAL_CAP || D.CADE_CAP;
    if (cap > D.CADE_CAP_MAX) cap = D.CADE_CAP_MAX;
    if ((cadeCounts[uid] | 0) >= cap) return { ok: false, reason: "cade cap (" + cap + ") reached" };
    var now = OV && OV.time ? OV.time() : 0;
    var cd = cades.COOLDOWN || 1.0;
    if (cadeLastPlace[uid] != null && now - cadeLastPlace[uid] < cd) return { ok: false, reason: "cooldown" };
    return { ok: true, def: def, view: view, uid: uid, now: now };
  }

  // Persist a cade spend against the backend. The verdict already passed the
  // cached-balance fast path; the backend stays authoritative.
  var chargeFailWarned = false;
  function chargeCade(ply, ent, def, v) {
    var cost = def.cost | 0;
    var sid = steam64Of(ply);
    function softDebit() {
      // Old behavior: local soft-debit keeps the HUD honest until the next sync.
      if (v.view) {
        v.view.player.bucks = Math.max(0, (v.view.player.bucks | 0) - cost);
        pushState(ply);
      }
    }
    if (!canReachBackend() || !sid) return softDebit();
    postJson("/v1/economy/server/charge", {
      serverId: SERVER_ID,
      serverSecret: SERVER_SECRET,
      steamId: sid,
      amount: cost,
      reason: "cade:" + def.name
    }).then(function (res) {
      if (v.view && res && typeof res.bucks === "number") {
        v.view.player.bucks = res.bucks | 0;
        pushState(ply);
      }
    }).catch(function (e) {
      var msg = e && e.message;
      if (msg === "insufficient_bucks") {
        // Backend truth beat the cached fast path: revoke the placement.
        if (ent && ent.IsValid && ent.IsValid() && typeof ent.Remove === "function") ent.Remove();
        cadeCounts[v.uid] = Math.max(0, (cadeCounts[v.uid] | 0) - 1);
        if (typeof ply.ChatPrint === "function") ply.ChatPrint("[OpenVibe] Can't place cade: needs " + cost + " bucks");
        syncPlayer(ply, true); // restore the stale cached balance
        return;
      }
      if (!chargeFailWarned) {
        chargeFailWarned = true;
        warn("cade charge failed (" + msg + ") — falling back to local soft-debit");
      }
      softDebit();
    });
  }

  function placeCade(ply, name) {
    var v = cadeVerdict(ply, name);
    if (!v.ok) {
      if (typeof ply.ChatPrint === "function") ply.ChatPrint("[OpenVibe] Can't place cade: " + v.reason);
      return null;
    }
    var def = v.def;
    var ent = ents.Create("ov_prop_cade");
    if (!ent || !ent.IsValid || !ent.IsValid()) { warn("ov_prop_cade create failed"); return null; }
    ent._r.cadeModel = def.model;
    ent._r.cadeHP = def.hp | 0;
    // No eye-trace bridge yet: drop the cade just ahead of the player.
    var pos = (typeof ply.GetPos === "function" && ply.GetPos()) || { x: 0, y: 0, z: 0 };
    ent.SetPos({ x: pos.x + 48, y: pos.y, z: pos.z + 8 });
    ent.Spawn();
    if (typeof ent.SetCadeOwner === "function") ent.SetCadeOwner(typeof ply.EntIndex === "function" ? ply.EntIndex() : 0);
    if (typeof ent.SetOwner === "function") ent.SetOwner(ply);
    cadeCounts[v.uid] = (cadeCounts[v.uid] | 0) + 1;
    cadeLastPlace[v.uid] = v.now;
    if ((def.cost | 0) > 0) chargeCade(ply, ent, def, v);
    if (globalThis.hook) { try { hook.Run("OVEconCadePlaced", ply, ent, def); } catch (e) {} }
    log((typeof ply.Nick === "function" ? ply.Nick() : "player") + " placed cade '" + def.name + "' (" + (cadeCounts[v.uid] | 0) + " this life)");
    return ent;
  }

  net.Receive(D.NET_CADE_BUY, function (len, ply) {
    if (!ply) return;
    var name = net.ReadString();
    if (!name) return;
    placeCade(ply, name);
  });

  // ---- kill reward (AddEXP-equivalent seed, not the full Devolved formula) ----
  var KILL_REWARD_BUCKS = 5;
  var KILL_REWARD_XP = 15;
  var rewardFailWarned = false;
  hook.Add("PlayerDeath", "OVEconomy.KillReward", function (victim, attacker) {
    if (!attacker || attacker === victim) return undefined;
    if (typeof attacker.IsPlayer === "function" && !attacker.IsPlayer()) return undefined;
    var sid = steam64Of(attacker);
    if (!sid || sid === steam64Of(victim)) return undefined; // world/bot/self kill
    if (!canReachBackend()) return undefined;
    postJson("/v1/economy/server/reward", {
      serverId: SERVER_ID,
      serverSecret: SERVER_SECRET,
      steamId: sid,
      bucks: KILL_REWARD_BUCKS,
      xp: KILL_REWARD_XP,
      reason: "kill"
    }).then(function (res) {
      var view = stateBySteam64[sid];
      if (view && res) {
        if (typeof res.bucks === "number") view.player.bucks = res.bucks | 0;
        if (typeof res.xp === "number") view.player.xp = res.xp | 0;
        if (typeof res.lvl === "number") view.player.lvl = res.lvl | 0;
        pushState(attacker);
      }
    }).catch(function (e) {
      if (!rewardFailWarned) {
        rewardFailWarned = true;
        warn("kill reward failed: " + (e && e.message));
      }
    });
    return undefined;
  });

  // Exposed for tooling/tests (the harness injects fake backend state here).
  D.server = {
    apiBase: API_BASE,
    serverId: SERVER_ID,
    hasHttp: !!http,
    ensureRegistered: ensureRegistered,
    syncPlayer: syncPlayer,
    pushState: pushState,
    cadeVerdict: cadeVerdict,
    placeCade: placeCade,
    buildClientState: buildClientState,
    _setState: function (steamId64, view) { stateBySteam64[String(steamId64)] = view; },
    _getState: function (steamId64) { return stateBySteam64[String(steamId64)] || null; },
    _cadeCount: function (uid) { return cadeCounts[uid | 0] | 0; },
    _setPostJson: function (fn) { postJsonOverride = typeof fn === "function" ? fn : null; }
  };

  ensureRegistered();
  log("server loaded (api=" + API_BASE + ", serverId=" + SERVER_ID + ", http=" + (http ? "node" : "unavailable") + ")");
})();
