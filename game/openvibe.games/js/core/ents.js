// OpenVibe ents + scripted_ents libraries — GMod semantics.
// https://wiki.facepunch.com/gmod/ents  https://wiki.facepunch.com/gmod/Scripted_Entities
//
// scripted_ents.Register(ENT, class) supports Base prototype chains and
// hot-patches live instances on re-register (GMod auto-refresh behavior).
(function () {
  if (globalThis.ents && globalThis.ents.__openvibe) return;

  var OV = globalThis.OV;
  var isServer = OV && OV.isServer ? !!OV.isServer() : true;
  var Entity = globalThis.Entity;

  // ---- scripted entity registry ----
  var stored = Object.create(null);   // class -> { t: def, proto, instances: [] }

  function buildProto(def, className) {
    // Prototype chain: Entity.prototype <- base proto <- def
    var baseProto = Entity.prototype;
    if (def.Base && def.Base !== className) {
      var baseEntry = stored[def.Base];
      if (baseEntry) baseProto = baseEntry.proto;
      else if (OV && OV.warn) OV.warn("scripted_ents: base '" + def.Base + "' of '" + className + "' not registered yet");
    }
    var proto = Object.create(baseProto);
    for (var k in def) proto[k] = def[k];
    proto.ClassName = className;
    proto.BaseClass = baseProto;
    return proto;
  }

  var scripted_ents = {
    __openvibe: true,
    Register: function (def, className) {
      className = String(className);
      if (!def || typeof def !== "object") throw new Error("scripted_ents.Register requires an ENT table");
      var proto = buildProto(def, className);
      var entry = stored[className];
      if (entry) {
        // Hot-patch: live instances jump to the new prototype; OnReloaded fires.
        entry.t = def;
        entry.proto = proto;
        entry.instances = entry.instances.filter(function (e) { return e.IsValid(); });
        entry.instances.forEach(function (e) {
          Object.setPrototypeOf(e, proto);
          if (typeof e.OnReloaded === "function") { try { e.OnReloaded(); } catch {} }
        });
        // Dependent classes need their chains rebuilt too.
        for (var cls in stored) {
          if (cls !== className && stored[cls].t.Base === className) {
            scripted_ents.Register(stored[cls].t, cls);
          }
        }
      } else {
        stored[className] = { t: def, proto: proto, instances: [] };
      }
      if (globalThis.baseclass) baseclass.Set("entity_" + className, proto);
      return stored[className];
    },
    GetStored: function (className) { return stored[String(className)] || null; },
    Get: function (className) {
      var entry = stored[String(className)];
      if (!entry) return null;
      var out = {};
      var p = entry.proto;
      // flatten the chain (GMod returns a base-merged copy)
      var keys = [];
      for (var k in p) keys.push(k);
      keys.forEach(function (key) { out[key] = p[key]; });
      return out;
    },
    GetList: function () { var out = {}; for (var k in stored) out[k] = stored[k].t; return out; },
    GetType: function (className) { var e = stored[String(className)]; return e ? e.t.Type || "anim" : null; },
    IsBasedOn: function (className, baseName) {
      var cur = String(className);
      var guard = 0;
      while (cur && guard++ < 32) {
        if (cur === String(baseName)) return true;
        var e = stored[cur];
        cur = e && e.t.Base;
      }
      return false;
    },
    GetMember: function (className, key) {
      var e = stored[String(className)];
      return e ? e.proto[key] : undefined;
    },
    _stored: stored
  };

  // ---- construction ----
  function construct(className, key, clientside) {
    var ent = new Entity(key);
    ent._r.class = className;
    ent._r.clientside = !!clientside;
    var entry = stored[className];
    if (entry) {
      Object.setPrototypeOf(ent, entry.proto);
      ent._ENT = entry.t;
      entry.instances.push(ent);
    }
    Entity._register(ent);
    if (typeof ent.SetupDataTables === "function") {
      try { ent.SetupDataTables(); } catch (e) { OV && OV.error && OV.error("SetupDataTables " + className + ": " + (e && e.message)); }
    }
    if (globalThis.hook) { try { hook.Run("OnEntityCreated", ent); } catch {} }
    return ent;
  }

  var ents = {
    __openvibe: true,

    Create: function (className) {
      if (!isServer) { OV && OV.warn && OV.warn("ents.Create is server-only; use ents.CreateClientside"); return globalThis.NULL; }
      className = String(className);
      var entry = stored[className];
      var key;
      if (Entity._native()) {
        // Real engine entity (scripted classes become logical + native anchor
        // when the class is unknown to the engine).
        var res = OV.entCreate ? OV.entCreate(className) : null;
        if (res && res.entIndex > 0) {
          key = res.entIndex | 0;
          var ent = construct(className, key, false);
          ent._r.isNative = true;
          return ent;
        }
        if (!entry) return globalThis.NULL; // unknown engine class and not scripted
      }
      if (!entry && !Entity._native()) {
        // Pure-JS backend: allow logical entities for any class so gamemode
        // logic and tests behave; scripted classes get their prototypes.
      }
      key = Entity._allocLogical();
      return construct(className, key, false);
    },

    CreateClientside: function (className) {
      if (isServer) { OV && OV.warn && OV.warn("ents.CreateClientside is client-only"); return globalThis.NULL; }
      return construct(String(className), Entity._allocClientside(), true);
    },

    GetByIndex: function (idx) { return Entity._get(idx | 0); },

    GetAll: function () {
      var out = [];
      Entity._each(function (e) { out.push(e); });
      if (globalThis.player && player.GetAll) {
        player.GetAll().forEach(function (p) { if (out.indexOf(p) < 0) out.push(p); });
      }
      return out;
    },

    Iterator: function () {
      var all = ents.GetAll(), i = 0;
      return function () { return i < all.length ? [i, all[i++]] : null; };
    },

    GetCount: function () { return ents.GetAll().length; },

    FindByClass: function (pattern) {
      pattern = String(pattern);
      var rx = new RegExp("^" + pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$");
      return ents.GetAll().filter(function (e) { return rx.test(e.GetClass()); });
    },

    FindByName: function (pattern) {
      pattern = String(pattern);
      var rx = new RegExp("^" + pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$");
      return ents.GetAll().filter(function (e) { return rx.test(e.GetName ? e.GetName() : ""); });
    },

    FindByModel: function (model) {
      model = String(model);
      return ents.GetAll().filter(function (e) { return e.GetModel && e.GetModel() === model; });
    },

    FindInSphere: function (origin, radius) {
      var r2 = (+radius || 0) * (+radius || 0);
      return ents.GetAll().filter(function (e) { return Entity._dist2(e.GetPos(), origin) <= r2; });
    },

    FindInBox: function (mins, maxs) {
      return ents.GetAll().filter(function (e) {
        var p = e.GetPos();
        return p.x >= mins.x && p.x <= maxs.x && p.y >= mins.y && p.y <= maxs.y && p.z >= mins.z && p.z <= maxs.z;
      });
    },

    FireTargets: function (name, activator, caller, useType, value) {
      ents.FindByName(name).forEach(function (e) { e.Use(activator, caller, useType, value); });
    }
  };

  // ---- Think pump: entity Think scheduling + deferred removals ----
  if (globalThis.hook && typeof hook.Add === "function") {
    hook.Add("Think", "OpenVibeEntityThink", function () {
      var now = OV && OV.time ? OV.time() : 0;
      Entity._each(function (e) {
        if (!e._ENT || typeof e.Think !== "function" || !e._r.spawned) return;
        if (e._r.nextThink && now < e._r.nextThink) return;
        e._r.nextThink = 0;
        try { e.Think(); } catch (err) { OV && OV.error && OV.error("ENT:Think " + e.GetClass() + ": " + (err && err.message)); }
      });
      Entity._flushRemovals();
      return undefined;
    });
  }

  globalThis.ents = ents;
  globalThis.scripted_ents = scripted_ents;

  if (OV && OV.log) OV.log("ents library ready");
})();
