// OpenVibe Entity system — GMod Entity class semantics in JS.
// https://wiki.facepunch.com/gmod/Entity
//
// Entities are id-handled wrappers over an internal registry. When the native
// bridge exposes entity bindings (OV.entCreate/OV.entCall) the wrapper drives
// the real engine entity; otherwise it is a pure-JS logical entity with the
// same lifecycle (usable in the Node harness, tests, and round logic).
//
// Networked state:
//   - SetNW*/GetNW*  — keyed store, server writes replicate via "__ovnw"
//   - NetworkVar     — DTVar-lite slots declared in ENT:SetupDataTables,
//                      replicate via "__ovdt", generate Get<Name>/Set<Name>
(function () {
  if (globalThis.Entity && globalThis.Entity.__openvibe) return;

  var OV = globalThis.OV;
  var isServer = OV && OV.isServer ? !!OV.isServer() : true;

  // ---- math globals (GMod parity) ----
  if (!globalThis.Vector) {
    globalThis.Vector = function (x, y, z) { return { x: +x || 0, y: +y || 0, z: +z || 0 }; };
  }
  if (!globalThis.Angle) {
    globalThis.Angle = function (p, y, r) { return { p: +p || 0, y: +y || 0, r: +r || 0 }; };
  }
  if (!globalThis.Color) {
    globalThis.Color = function (r, g, b, a) { return { r: r | 0, g: g | 0, b: b | 0, a: a === undefined ? 255 : a | 0 }; };
  }
  function vcopy(v) { return { x: +v.x || 0, y: +v.y || 0, z: +v.z || 0 }; }
  function acopy(a) { return { p: +a.p || 0, y: +a.y || 0, r: +a.r || 0 }; }
  function dist2(a, b) {
    var dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
    return dx * dx + dy * dy + dz * dz;
  }

  // ---- enums (subset used by gamemodes) ----
  globalThis.SOLID_NONE = 0; globalThis.SOLID_BBOX = 2; globalThis.SOLID_VPHYSICS = 6;
  globalThis.MOVETYPE_NONE = 0; globalThis.MOVETYPE_WALK = 2; globalThis.MOVETYPE_NOCLIP = 8;
  globalThis.MOVETYPE_VPHYSICS = 6; globalThis.MOVETYPE_FLY = 5;
  globalThis.COLLISION_GROUP_NONE = 0; globalThis.COLLISION_GROUP_DEBRIS = 1; globalThis.COLLISION_GROUP_WORLD = 3;
  globalThis.RENDERMODE_NORMAL = 0; globalThis.RENDERMODE_TRANSALPHA = 4;
  globalThis.SIMPLE_USE = 0; globalThis.CONTINUOUS_USE = 1; globalThis.ONOFF_USE = 2;

  // ---- registry ----
  var registry = Object.create(null);   // key(entIndex) -> Entity
  var pendingRemoval = [];
  var nextLogicalIndex = 16384;         // pure-JS server entities sit above engine edicts
  var nextClientsideKey = -2;           // clientside-only entities (EntIndex() reports -1)

  function native() { return OV && typeof OV.entCall === "function"; }
  function ncall(idx, method, args) {
    try { return OV.entCall(idx, method, args || []); }
    catch (e) { if (OV && OV.warn) OV.warn("entCall " + method + ": " + (e && e.message)); return undefined; }
  }

  // NULL singleton
  var NULL_ENTITY = null;

  function Entity(key) {
    // Calling Entity(n) as a function resolves an index (GMod Global.Entity).
    if (!(this instanceof Entity)) {
      var e = registry[key | 0];
      return e && !e._r.removed ? e : NULL_ENTITY;
    }
    this.__ovEntity = true;
    this._key = key;
    this._r = {
      class: "", model: "", pos: Vector(), ang: Angle(),
      health: 0, maxHealth: 0, color: Color(255, 255, 255, 255), material: "",
      moveType: 0, solid: 0, collisionGroup: 0, renderMode: 0, useType: 0,
      name: "", keyvalues: {}, parent: null, owner: null,
      spawned: false, removed: false, noDraw: false, trigger: false,
      nw: Object.create(null), nwProxies: Object.create(null),
      dt: Object.create(null), dtNotify: Object.create(null), dtSlots: Object.create(null),
      removeCallbacks: [], deleteOnRemove: [],
      nextThink: 0, createdAt: (OV && OV.time ? OV.time() : 0),
      isNative: false, clientside: key < 0
    };
  }
  Entity.__openvibe = true;

  var P = Entity.prototype;

  // ---- identity / lifecycle ----
  P.IsValid = function () { return !this._r.removed && this !== NULL_ENTITY; };
  P.isValid = P.IsValid;
  P.EntIndex = function () { return this._r.clientside ? -1 : this._key; };
  P.entIndex = P.EntIndex;
  P.GetClass = function () { return this._r.class; };
  P.GetModel = function () { return this._r.model || null; };
  P.IsWorld = function () { return this._key === 0; };
  P.GetCreationTime = function () { return this._r.createdAt; };
  P.GetTable = function () { return this; };
  P.IsPlayer = function () { return false; };
  P.IsNPC = function () { return false; };
  P.IsWeapon = function () { return false; };
  P.IsScripted = function () { return !!this._ENT; };

  P.Spawn = function () {
    if (this._r.spawned || this._r.removed) return;
    this._r.spawned = true;
    if (this._r.isNative && native()) ncall(this._key, "spawn");
    if (typeof this.Initialize === "function") {
      try { this.Initialize(); } catch (e) { OV && OV.error && OV.error("ENT:Initialize " + this._r.class + ": " + (e && e.stack || e)); }
    }
  };
  P.Activate = function () { if (this._r.isNative && native()) ncall(this._key, "activate"); };

  P.Remove = function () {
    if (this._r.removed) return;
    if (pendingRemoval.indexOf(this) < 0) pendingRemoval.push(this);
  };
  P.IsMarkedForDeletion = function () { return pendingRemoval.indexOf(this) >= 0; };
  P.CallOnRemove = function (id, fn) { this._r.removeCallbacks.push({ id: String(id), fn: fn }); };
  P.RemoveCallOnRemove = function (id) {
    this._r.removeCallbacks = this._r.removeCallbacks.filter(function (c) { return c.id !== String(id); });
  };
  P.DeleteOnRemove = function (ent) { this._r.deleteOnRemove.push(ent); };

  // ---- transform ----
  P.GetPos = function () {
    if (this._r.isNative && native()) { var v = ncall(this._key, "getPos"); if (v) this._r.pos = v; }
    return vcopy(this._r.pos);
  };
  P.SetPos = function (v) { this._r.pos = vcopy(v || {}); if (this._r.isNative && native()) ncall(this._key, "setPos", [this._r.pos.x, this._r.pos.y, this._r.pos.z]); };
  P.GetAngles = function () {
    if (this._r.isNative && native()) { var a = ncall(this._key, "getAngles"); if (a) this._r.ang = a; }
    return acopy(this._r.ang);
  };
  P.SetAngles = function (a) { this._r.ang = acopy(a || {}); if (this._r.isNative && native()) ncall(this._key, "setAngles", [this._r.ang.p, this._r.ang.y, this._r.ang.r]); };
  P.GetForward = function () {
    var a = this.GetAngles(), p = a.p * Math.PI / 180, y = a.y * Math.PI / 180;
    return Vector(Math.cos(p) * Math.cos(y), Math.cos(p) * Math.sin(y), -Math.sin(p));
  };
  P.GetVelocity = function () { return (this._r.isNative && native() && ncall(this._key, "getVelocity")) || Vector(); };
  P.SetVelocity = function (v) { if (this._r.isNative && native()) ncall(this._key, "setVelocity", [v.x, v.y, v.z]); };
  P.EyePos = function () { var p = this.GetPos(); return Vector(p.x, p.y, p.z + 64); };

  // ---- appearance ----
  P.SetModel = function (m) { this._r.model = String(m); if (this._r.isNative && native()) ncall(this._key, "setModel", [this._r.model]); };
  P.SetModelScale = function (s) { if (this._r.isNative && native()) ncall(this._key, "setModelScale", [+s || 1]); };
  P.SetColor = function (c) { this._r.color = c ? Color(c.r, c.g, c.b, c.a) : Color(255, 255, 255); if (this._r.isNative && native()) ncall(this._key, "setColor", [this._r.color.r, this._r.color.g, this._r.color.b, this._r.color.a]); };
  P.GetColor = function () { return this._r.color; };
  P.SetMaterial = function (m) { this._r.material = String(m || ""); if (this._r.isNative && native()) ncall(this._key, "setMaterial", [this._r.material]); };
  P.GetMaterial = function () { return this._r.material; };
  P.SetRenderMode = function (m) { this._r.renderMode = m | 0; if (this._r.isNative && native()) ncall(this._key, "setRenderMode", [m | 0]); };
  P.SetNoDraw = function (b) { this._r.noDraw = !!b; if (this._r.isNative && native()) ncall(this._key, "setNoDraw", [!!b]); };
  P.GetNoDraw = function () { return this._r.noDraw; };

  // ---- health / damage ----
  P.Health = function () {
    if (this._r.isNative && native()) { var h = ncall(this._key, "health"); if (h !== undefined) this._r.health = h; }
    return this._r.health;
  };
  P.SetHealth = function (v) { this._r.health = v | 0; if (this._r.isNative && native()) ncall(this._key, "setHealth", [v | 0]); };
  P.GetMaxHealth = function () { return this._r.maxHealth; };
  P.SetMaxHealth = function (v) { this._r.maxHealth = v | 0; if (this._r.isNative && native()) ncall(this._key, "setMaxHealth", [v | 0]); };
  P.Alive = function () { return this.Health() > 0; };
  P.TakeDamage = function (dmg, attacker, inflictor) {
    if (!isServer) return;
    var info = { damage: +dmg || 0, attacker: attacker || NULL_ENTITY, inflictor: inflictor || attacker || NULL_ENTITY,
      GetDamage: function () { return this.damage; }, GetAttacker: function () { return this.attacker; },
      GetInflictor: function () { return this.inflictor; }, SetDamage: function (d) { this.damage = +d || 0; },
      ScaleDamage: function (s) { this.damage *= s; } };
    var block = globalThis.hook ? hook.Run("EntityTakeDamage", this, info) : undefined;
    if (block === true) return;
    if (typeof this.OnTakeDamage === "function") {
      try { this.OnTakeDamage(info); return; } catch (e) { OV && OV.error && OV.error("OnTakeDamage: " + (e && e.message)); }
    }
    if (this._r.isNative && native()) { ncall(this._key, "takeDamage", [info.damage, attacker ? attacker.EntIndex() : 0]); return; }
    this.SetHealth(this.Health() - info.damage);
    if (this.Health() <= 0 && !this._r.clientside) this.Remove();
  };

  // ---- physics / movement ----
  P.PhysicsInit = function (solidType) {
    if (this._r.isNative && native()) return !!ncall(this._key, "physicsInit", [solidType | 0]);
    this._r.solid = solidType | 0;
    return true;
  };
  P.PhysWake = function () { if (this._r.isNative && native()) ncall(this._key, "physWake"); };
  P.GetPhysicsObject = function () {
    var self = this;
    return {
      IsValid: function () { return self._r.solid !== 0 || (self._r.isNative && native() && !!ncall(self._key, "hasPhysics")); },
      Wake: function () { self.PhysWake(); },
      SetMass: function (m) { if (self._r.isNative && native()) ncall(self._key, "setMass", [+m || 1]); },
      EnableMotion: function (b) { if (self._r.isNative && native()) ncall(self._key, "enableMotion", [!!b]); },
      ApplyForceCenter: function (v) { if (self._r.isNative && native()) ncall(self._key, "applyForceCenter", [v.x, v.y, v.z]); }
    };
  };
  P.SetMoveType = function (m) { this._r.moveType = m | 0; if (this._r.isNative && native()) ncall(this._key, "setMoveType", [m | 0]); };
  P.GetMoveType = function () { return this._r.moveType; };
  P.SetSolid = function (s) { this._r.solid = s | 0; if (this._r.isNative && native()) ncall(this._key, "setSolid", [s | 0]); };
  P.GetSolid = function () { return this._r.solid; };
  P.SetCollisionGroup = function (g) { this._r.collisionGroup = g | 0; if (this._r.isNative && native()) ncall(this._key, "setCollisionGroup", [g | 0]); };
  P.GetCollisionGroup = function () { return this._r.collisionGroup; };

  // ---- hierarchy ----
  P.SetParent = function (parent) { this._r.parent = parent || null; if (this._r.isNative && native()) ncall(this._key, "setParent", [parent && parent.EntIndex ? parent.EntIndex() : 0]); };
  P.GetParent = function () { return this._r.parent || NULL_ENTITY; };
  P.GetChildren = function () {
    var out = [], self = this;
    Entity._each(function (e) { if (e._r.parent === self) out.push(e); });
    return out;
  };
  P.SetOwner = function (owner) { this._r.owner = owner || null; if (this._r.isNative && native()) ncall(this._key, "setOwner", [owner && owner.EntIndex ? owner.EntIndex() : 0]); };
  P.GetOwner = function () { return this._r.owner || NULL_ENTITY; };

  // ---- keyvalues / IO / use ----
  P.SetKeyValue = function (k, v) { this._r.keyvalues[String(k)] = String(v); if (this._r.isNative && native()) ncall(this._key, "setKeyValue", [String(k), String(v)]); if (typeof this.KeyValue === "function") { try { this.KeyValue(String(k), String(v)); } catch {} } };
  P.GetKeyValues = function () { var out = {}; for (var k in this._r.keyvalues) out[k] = this._r.keyvalues[k]; return out; };
  P.SetName = function (n) { this._r.name = String(n); };
  P.GetName = function () { return this._r.name; };
  P.Fire = function (input, param, delay) { if (this._r.isNative && native()) ncall(this._key, "fire", [String(input), String(param || ""), +delay || 0]); };
  P.SetUseType = function (t) { this._r.useType = t | 0; };
  P.SetTrigger = function (b) { this._r.trigger = !!b; };
  P.Use = function (activator, caller, useType, value) {
    if (typeof this._useHook === "function") { try { this._useHook(activator, caller, useType, value); } catch {} }
  };
  P.EmitSound = function (name) { if (this._r.isNative && native()) ncall(this._key, "emitSound", [String(name)]); };
  P.NextThink = function (t) { this._r.nextThink = +t || 0; };
  P.SetNextClientThink = P.NextThink;

  // ---- networked vars (NW) ----
  var NW_TYPES = ["Int", "Float", "Bool", "String", "Entity", "Vector", "Angle"];
  var NW_DEFAULTS = { Int: 0, Float: 0, Bool: false, String: "", Entity: null, Vector: null, Angle: null };
  function nwSet(ent, type, key, value) {
    key = String(key);
    var old = ent._r.nw[key];
    ent._r.nw[key] = value;
    var proxy = ent._r.nwProxies[key];
    if (proxy) { try { proxy(ent, key, old, value); } catch {} }
    if (isServer && globalThis.net && net.__openvibe && OV && OV.netEmit) {
      var wire = value;
      if (type === "Entity") wire = value && value.EntIndex ? value.EntIndex() : 0;
      try {
        net.Start("__ovnw");
        net.WriteInt(ent.EntIndex());
        net.WriteString(type);
        net.WriteString(key);
        net.WriteType(wire);
        net.Broadcast();
      } catch (e) { /* net not ready during early load */ }
    }
  }
  function nwGet(ent, type, key, fallback) {
    var v = ent._r.nw[String(key)];
    if (v === undefined) return fallback !== undefined ? fallback : NW_DEFAULTS[type];
    return v;
  }
  NW_TYPES.forEach(function (type) {
    P["SetNW" + type] = function (key, value) { nwSet(this, type, key, value); };
    P["GetNW" + type] = function (key, fallback) { return nwGet(this, type, key, fallback); };
    P["SetNW2" + type] = P["SetNW" + type];
    P["GetNW2" + type] = P["GetNW" + type];
  });
  P.SetNWVarProxy = function (key, fn) { this._r.nwProxies[String(key)] = fn; };
  P.GetNWVarTable = function () { var out = {}; for (var k in this._r.nw) out[k] = this._r.nw[k]; return out; };

  // ---- DTVars (NetworkVar) ----
  P.NetworkVar = function (type, slot, name, extended) {
    var ent = this;
    name = String(name);
    ent._r.dtSlots[name] = { type: String(type), slot: slot | 0 };
    if (ent._r.dt[name] === undefined) ent._r.dt[name] = NW_DEFAULTS[type];
    ent["Get" + name] = function () { return ent._r.dt[name]; };
    ent["Set" + name] = function (v) {
      var old = ent._r.dt[name];
      ent._r.dt[name] = v;
      var notify = ent._r.dtNotify[name];
      if (notify) { try { notify(ent, name, old, v); } catch {} }
      if (isServer && globalThis.net && net.__openvibe && OV && OV.netEmit) {
        var wire = type === "Entity" ? (v && v.EntIndex ? v.EntIndex() : 0) : v;
        try {
          net.Start("__ovdt");
          net.WriteInt(ent.EntIndex());
          net.WriteString(name);
          net.WriteType(wire);
          net.Broadcast();
        } catch (e) { /* net not ready */ }
      }
    };
  };
  P.NetworkVarNotify = function (name, fn) { this._r.dtNotify[String(name)] = fn; };
  P.GetNetworkVars = function () { var out = {}; for (var k in this._r.dt) out[k] = this._r.dt[k]; return out; };

  // ---- internal registry api (used by ents.js / player.js) ----
  Entity._register = function (ent) { registry[ent._key] = ent; };
  Entity._unregister = function (ent) { delete registry[ent._key]; };
  Entity._each = function (fn) {
    for (var k in registry) { var e = registry[k]; if (e && !e._r.removed) fn(e); }
  };
  Entity._get = function (key) { var e = registry[key | 0]; return e && !e._r.removed ? e : NULL_ENTITY; };
  Entity._allocLogical = function () { return nextLogicalIndex++; };
  Entity._allocClientside = function () { return nextClientsideKey--; };
  Entity._native = native;
  Entity._ncall = ncall;
  Entity._dist2 = dist2;
  Entity._pendingRemoval = pendingRemoval;

  // Actual removal, deferred to end of tick (GMod behavior).
  function reallyRemove(ent) {
    if (ent._r.removed) return;
    ent._r.removeCallbacks.forEach(function (c) { try { c.fn(ent); } catch {} });
    if (typeof ent.OnRemove === "function") { try { ent.OnRemove(false); } catch {} }
    ent._r.removed = true;
    if (ent._r.isNative && native()) ncall(ent._key, "remove");
    Entity._unregister(ent);
    if (globalThis.hook) { try { hook.Run("EntityRemoved", ent, false); } catch {} }
    ent._r.deleteOnRemove.forEach(function (other) { if (other && other.Remove) other.Remove(); });
  }
  Entity._flushRemovals = function () {
    if (!pendingRemoval.length) return;
    var batch = pendingRemoval.splice(0, pendingRemoval.length);
    batch.forEach(reallyRemove);
  };

  // ---- NULL entity ----
  NULL_ENTITY = new Entity(0);
  NULL_ENTITY._r.removed = true;
  NULL_ENTITY._r.class = "";
  NULL_ENTITY.IsValid = function () { return false; };
  NULL_ENTITY.isValid = NULL_ENTITY.IsValid;
  globalThis.NULL = NULL_ENTITY;

  // ---- world entity (index 0 semantics kept simple) ----
  globalThis.Entity = Entity;

  // ---- replication receivers (both realms register; only client applies) ----
  function ensureShellEntity(idx) {
    var e = Entity._get(idx);
    if (e && e.IsValid()) return e;
    var shell = new Entity(idx);
    shell._r.spawned = true;
    Entity._register(shell);
    return shell;
  }
  // net.js loads before entity.js in the bootstrap order, so this runs
  // immediately in practice.
  function registerSyncReceivers() {
    if (!globalThis.net || !net.__openvibe) return;
    if (isServer) {
      if (globalThis.util && util.AddNetworkString) {
        util.AddNetworkString("__ovnw");
        util.AddNetworkString("__ovdt");
        util.AddNetworkString("__ovchunk");
      }
      return;
    }
    net.Receive("__ovnw", function () {
      var idx = net.ReadInt(), type = net.ReadString(), key = net.ReadString(), v = net.ReadType();
      var ent = ensureShellEntity(idx);
      if (type === "Entity") v = Entity._get(v | 0);
      var old = ent._r.nw[key];
      ent._r.nw[key] = v;
      var proxy = ent._r.nwProxies[key];
      if (proxy) { try { proxy(ent, key, old, v); } catch {} }
    });
    net.Receive("__ovdt", function () {
      var idx = net.ReadInt(), name = net.ReadString(), v = net.ReadType();
      var ent = ensureShellEntity(idx);
      var slot = ent._r.dtSlots[name];
      if (slot && slot.type === "Entity") v = Entity._get(v | 0);
      var old = ent._r.dt[name];
      ent._r.dt[name] = v;
      var notify = ent._r.dtNotify[name];
      if (notify) { try { notify(ent, name, old, v); } catch {} }
    });
  }
  registerSyncReceivers();

  if (OV && OV.log) OV.log("entity system ready (realm=" + (isServer ? "server" : "client") + ")");
})();
