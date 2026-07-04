// OpenVibe Player class — GMod Player semantics over the native player bridge.
// https://wiki.facepunch.com/gmod/Player
//
// Player extends Entity. Native player handles (from the C++ bridge or the
// Node runtime) are wrapped once via Player.fromNative and cached by UserID;
// gamemode.call wraps hook arguments automatically, so gamemode code always
// sees framework Player objects. The legacy lowercase API (ply.chat(),
// ply.setTeam(), ...) is kept for existing gamemode code.
(function () {
  if (globalThis.Player && globalThis.Player.__openvibe) return;

  var OV = globalThis.OV;
  var isServer = OV && OV.isServer ? !!OV.isServer() : true;
  var Entity = globalThis.Entity;

  var byUserId = Object.create(null); // userId -> Player

  function Player(userId, entIndex) {
    Entity.call(this, entIndex || (100000 + userId));
    this.__ovPlayer = true;
    this._userId = userId | 0;
    this._native = null;      // native bridge handle (lowercase methods)
    this._r.class = "player";
    this._r.health = 100;
    this._r.maxHealth = 100;
    this._r.team = 0;
    this._r.frags = 0;
    this._r.deaths = 0;
    this._r.alive = true;
    this._r.spawned = true;
    this._r.playerName = "";
    this._r.steamId = "";
  }
  Player.__openvibe = true;
  Player.prototype = Object.create(Entity.prototype);
  Player.prototype.constructor = Player;
  var P = Player.prototype;

  function nat(self, method, args) {
    var h = self._native;
    if (h && typeof h[method] === "function") {
      try { return h[method].apply(h, args || []); } catch (e) { OV && OV.warn && OV.warn("player." + method + ": " + (e && e.message)); }
    }
    return undefined;
  }

  // ---- identity ----
  P.IsPlayer = function () { return true; };
  P.UserID = function () { return this._userId; };
  P.Nick = function () { var v = nat(this, "name"); return v !== undefined ? v : (this._r.playerName || "Player" + this._userId); };
  P.Name = P.Nick;
  P.SteamID = function () { var v = nat(this, "steamId"); return v !== undefined ? v : this._r.steamId; };
  P.EntIndex = function () { var v = nat(this, "entIndex"); return v !== undefined ? v : this._key; };
  P.entIndex = P.EntIndex;
  P.IsBot = function () { return /^BOT/.test(this.SteamID() || ""); };
  P.IsValid = function () { return !this._r.removed && byUserId[this._userId] === this; };
  P.isValid = P.IsValid;

  // ---- team / score ----
  P.Team = function () { var v = nat(this, "team"); return v !== undefined ? v : this._r.team; };
  P.SetTeam = function (t) { this._r.team = t | 0; nat(this, "setTeam", [t | 0]); };
  P.Frags = function () { return this._r.frags; };
  P.AddFrags = function (n) { this._r.frags += n | 0; };
  P.Deaths = function () { return this._r.deaths; };
  P.AddDeaths = function (n) { this._r.deaths += n | 0; };

  // ---- life ----
  P.Health = function () { var v = nat(this, "health"); return v !== undefined ? v : this._r.health; };
  P.SetHealth = function (v) { this._r.health = v | 0; nat(this, "setHealth", [v | 0]); };
  P.Alive = function () { return this._r.alive && this.Health() > 0; };
  P.Kill = function () {
    if (!isServer) return;
    if (nat(this, "kill") === undefined) {
      // no native kill — emulate for the logical backend
      this._r.alive = false;
      this._r.health = 0;
      if (globalThis.hook) { try { hook.Run("PlayerDeath", this, globalThis.NULL, globalThis.NULL); } catch {} }
    }
  };
  P.KillSilent = P.Kill;
  P.Spawn = function () {
    this._r.alive = true;
    if (this._r.health <= 0) this._r.health = 100;
    nat(this, "respawn");
  };
  P.Armor = function () { return this._r.armor | 0; };
  P.SetArmor = function (v) { this._r.armor = v | 0; nat(this, "setArmor", [v | 0]); };

  // ---- movement / state ----
  P.Freeze = function (b) { this._r.frozen = !!b; nat(this, "freeze", [!!b]); };
  P.IsFrozen = function () { return !!this._r.frozen; };
  P.GetPos = function () { var v = nat(this, "getPos"); return v || Entity.prototype.GetPos.call(this); };
  P.SetPos = function (v) { Entity.prototype.SetPos.call(this, v); nat(this, "setPos", [v.x, v.y, v.z]); };

  // ---- chat / console ----
  P.ChatPrint = function (msg) { nat(this, "chat", [String(msg)]); };
  P.PrintMessage = function (type, msg) { this.ChatPrint(msg); };
  P.ConCommand = function (cmd) { nat(this, "runCommand", [String(cmd)]); };
  P.SendNet = function (name, fn) { /* convenience: net.Start(name); fn(); net.Send(this) */ };

  // ---- weapons ----
  // Give a weapon by class: creates the scripted-weapon instance, backs it with
  // a real engine weapon via the native (if present), equips + tracks it.
  P.Give = function (cls) {
    cls = String(cls);
    this._r.weapons = this._r.weapons || [];
    // Already carrying it? GMod refills ammo instead of duplicating.
    for (var i = 0; i < this._r.weapons.length; i++) {
      if (this._r.weapons[i].GetClass() === cls) { nat(this, "give", [cls]); return this._r.weapons[i]; }
    }
    var wep = globalThis.weapons ? weapons.Create(cls) : globalThis.NULL;
    nat(this, "give", [cls]); // engine-side create + equip (real body / clip sync)
    if (wep && wep !== globalThis.NULL) {
      wep.SetOwner(this);
      this._r.weapons.push(wep);
      if (!this._r.activeWeapon) this._r.activeWeapon = wep;
      if (typeof wep.Equip === "function") { try { wep.Equip(this); } catch (e) {} }
      if (globalThis.hook) { try { hook.Run("WeaponEquip", wep, this); } catch (e) {} }
    }
    return wep;
  };
  P.StripWeapons = function () {
    (this._r.weapons || []).forEach(function (w) { if (w.OnRemove) { try { w.OnRemove(); } catch (e) {} } });
    this._r.weapons = [];
    this._r.activeWeapon = null;
    nat(this, "stripWeapons");
  };
  P.StripWeapon = function (cls) {
    cls = String(cls);
    this._r.weapons = (this._r.weapons || []).filter(function (w) { return w.GetClass() !== cls; });
    if (this._r.activeWeapon && this._r.activeWeapon.GetClass() === cls) this._r.activeWeapon = this._r.weapons[0] || null;
    nat(this, "stripWeapon", [cls]);
  };
  P.GetWeapons = function () { return (this._r.weapons || []).slice(); };
  P.HasWeapon = function (cls) { cls = String(cls); return (this._r.weapons || []).some(function (w) { return w.GetClass() === cls; }); };
  P.GetWeapon = function (cls) { cls = String(cls); return (this._r.weapons || []).filter(function (w) { return w.GetClass() === cls; })[0] || globalThis.NULL; };
  P.GetActiveWeapon = function () {
    var n = nat(this, "getActiveWeapon");
    if (n && n.entIndex != null && globalThis.ents) { var w = ents.GetByIndex(n.entIndex); if (w) return w; }
    return this._r.activeWeapon || globalThis.NULL;
  };
  P.SelectWeapon = function (cls) {
    cls = String(cls); var w = this.GetWeapon(cls);
    if (w && w !== globalThis.NULL) { this._r.activeWeapon = w; nat(this, "selectWeapon", [cls]); }
  };
  P.GiveAmmo = function (amount, type) { nat(this, "giveAmmo", [amount | 0, String(type)]); return amount | 0; };
  P.ViewPunch = function (ang) { nat(this, "viewPunch", [ang.p || 0, ang.y || 0, ang.r || 0]); };

  // ---- legacy lowercase API (existing gamemodes) ----
  P.userId = P.UserID;
  P.steamId = P.SteamID;
  P.name = P.Nick;
  P.health = P.Health;
  P.setHealth = P.SetHealth;
  P.team = P.Team;
  P.setTeam = P.SetTeam;
  P.chat = P.ChatPrint;
  P.runCommand = P.ConCommand;

  // ---- wrapping / registry ----
  Player.fromNative = function (h) {
    if (!h) return null;
    if (h.__ovPlayer) return h;
    var uid = -1;
    try { uid = typeof h.userId === "function" ? h.userId() | 0 : -1; } catch {}
    if (uid < 0) return h;
    var ply = byUserId[uid];
    if (!ply) {
      var entIndex = 0;
      try { entIndex = typeof h.entIndex === "function" ? h.entIndex() | 0 : 0; } catch {}
      ply = new Player(uid, entIndex > 0 ? entIndex : undefined);
      byUserId[uid] = ply;
      Entity._register(ply);
    }
    ply._native = h;
    try { if (typeof h.name === "function") ply._r.playerName = h.name(); } catch {}
    try { if (typeof h.steamId === "function") ply._r.steamId = h.steamId() || ply._r.steamId; } catch {}
    return ply;
  };

  Player.getOrCreate = function (userId, name) {
    var ply = byUserId[userId | 0];
    if (!ply) {
      ply = new Player(userId | 0);
      ply._r.playerName = name || "";
      byUserId[userId | 0] = ply;
      Entity._register(ply);
    }
    return ply;
  };

  Player.drop = function (userId) {
    var ply = byUserId[userId | 0];
    if (ply) {
      Entity._unregister(ply);
      delete byUserId[userId | 0];
    }
  };

  var playerLib = {
    __openvibe: true,
    GetAll: function () {
      // Prefer the live native list (covers players the wrapper hasn't seen)
      if (OV && OV.players) {
        var out = [];
        (OV.players() || []).forEach(function (h) {
          var p = Player.fromNative(h);
          if (p) out.push(p);
        });
        if (out.length) return out;
      }
      var cached = [];
      for (var k in byUserId) cached.push(byUserId[k]);
      return cached;
    },
    GetByUserID: function (uid) {
      var p = byUserId[uid | 0];
      if (p) return p;
      if (OV && OV.playerByUserId) {
        var h = OV.playerByUserId(uid | 0);
        if (h) return Player.fromNative(h);
      }
      return null;
    },
    GetBySteamID: function (sid) {
      sid = String(sid);
      return playerLib.GetAll().find(function (p) { return p.SteamID() === sid; }) || null;
    },
    GetCount: function () { return playerLib.GetAll().length; },
    Iterator: function () {
      var all = playerLib.GetAll(), i = 0;
      return function () { return i < all.length ? [i, all[i++]] : null; };
    }
  };

  // ---- client realm: LocalPlayer ----
  var localPlayer = null;
  globalThis.LocalPlayer = function () {
    if (isServer) return globalThis.NULL;
    if (!localPlayer && OV && OV.localPlayer) {
      var h = OV.localPlayer();
      if (h) localPlayer = Player.fromNative(h);
    }
    return localPlayer || globalThis.NULL;
  };
  Player._setLocal = function (p) { localPlayer = p; };

  // Cleanup on disconnect (server realm).
  if (globalThis.hook && typeof hook.Add === "function" && isServer) {
    hook.Add("PlayerDisconnected", "OpenVibePlayerRegistry", function (ply) {
      if (ply && typeof ply.UserID === "function") {
        // Defer drop so later hooks this tick still see the player.
        var uid = ply.UserID();
        if (globalThis.timer && timer.simple) timer.simple(0, function () { Player.drop(uid); });
        else Player.drop(uid);
      }
      return undefined;
    });
  }

  globalThis.Player = Player;
  globalThis.player = playerLib;

  if (OV && OV.log) OV.log("player library ready");
})();
