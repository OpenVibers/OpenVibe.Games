// OpenVibe weapons + scripted_weapons libraries — GMod SWEP semantics.
// https://wiki.facepunch.com/gmod/weapons  https://wiki.facepunch.com/gmod/Structures/SWEP
//
// weapons.Register(SWEP, class) supports Base prototype chains and hot-patches
// live instances on re-register (same behaviour as scripted_ents). Weapons are
// entities, so the prototype chain roots at Weapon.prototype (<- Entity).
(function () {
  if (globalThis.weapons && globalThis.weapons.__openvibe) return;

  var OV = globalThis.OV;
  var Weapon = globalThis.Weapon;
  var Entity = globalThis.Entity;
  if (!Weapon) { OV && OV.error && OV.error("weapons.js requires weapon.js"); return; }

  var stored = Object.create(null); // class -> { t, proto, instances: [] }

  function buildProto(def, className) {
    var baseProto = Weapon.prototype;
    if (def.Base && def.Base !== className) {
      var baseEntry = stored[def.Base];
      if (baseEntry) baseProto = baseEntry.proto;
      else if (def.Base !== "weapon_base" && OV && OV.warn)
        OV.warn("weapons: base '" + def.Base + "' of '" + className + "' not registered yet");
    }
    var proto = Object.create(baseProto);
    for (var k in def) proto[k] = def[k];
    proto.ClassName = className;
    proto.BaseClass = baseProto;
    return proto;
  }

  var scripted_weapons = {
    __openvibe: true,
    Register: function (def, className) {
      className = String(className);
      if (!def || typeof def !== "object") throw new Error("weapons.Register requires a SWEP table");
      var proto = buildProto(def, className);
      var entry = stored[className];
      if (entry) {
        entry.t = def; entry.proto = proto;
        entry.instances = entry.instances.filter(function (w) { return w.IsValid(); });
        entry.instances.forEach(function (w) {
          Object.setPrototypeOf(w, proto);
          if (typeof w.OnReloaded === "function") { try { w.OnReloaded(); } catch (e) {} }
        });
        for (var cls in stored) {
          if (cls !== className && stored[cls].t.Base === className) scripted_weapons.Register(stored[cls].t, cls);
        }
      } else {
        stored[className] = { t: def, proto: proto, instances: [] };
      }
      if (globalThis.baseclass) baseclass.Set(className, proto);
      return stored[className];
    },
    GetStored: function (c) { return stored[String(c)] || null; },
    Get: function (c) {
      var e = stored[String(c)]; if (!e) return null;
      var out = {}; for (var k in e.proto) out[k] = e.proto[k]; return out;
    },
    GetList: function () { var out = []; for (var k in stored) out.push(stored[k].t); return out; },
    GetMember: function (c, key) { var e = stored[String(c)]; return e ? e.proto[key] : undefined; },
    IsBasedOn: function (c, base) {
      var cur = String(c), guard = 0;
      while (cur && guard++ < 32) { if (cur === String(base)) return true; var e = stored[cur]; cur = e && e.t.Base; }
      return false;
    },
    _stored: stored
  };

  // ---- construction ----
  function construct(className, key, clientside) {
    var w = new Weapon(key);
    w._r.class = className;
    w._r.clientside = !!clientside;
    var entry = stored[className];
    if (entry) {
      Object.setPrototypeOf(w, entry.proto);
      w._SWEP = entry.t;
      entry.instances.push(w);
      // Seed clips from the SWEP tables.
      if (w.Primary) w._w.clip1 = (w.Primary.DefaultClip != null ? w.Primary.DefaultClip : (w.Primary.ClipSize || -1));
      if (w.Secondary) w._w.clip2 = (w.Secondary.DefaultClip != null ? w.Secondary.DefaultClip : (w.Secondary.ClipSize || -1));
    }
    if (Entity._register) Entity._register(w);
    if (typeof w.SetupDataTables === "function") { try { w.SetupDataTables(); } catch (e) {} }
    if (typeof w.Initialize === "function") { try { w.Initialize(); } catch (e) { OV && OV.error && OV.error("SWEP:Initialize " + className + ": " + (e && e.message)); } }
    if (globalThis.hook) { try { hook.Run("OnEntityCreated", w); } catch (e) {} }
    return w;
  }

  var weapons = {
    __openvibe: true,
    Register: function (def, className) { return scripted_weapons.Register(def, className); },
    Get: scripted_weapons.Get,
    GetStored: scripted_weapons.GetStored,
    GetList: scripted_weapons.GetList,
    IsBasedOn: scripted_weapons.IsBasedOn,
    // Create a weapon instance (server: real entity via native give path, else logical).
    Create: function (className) {
      className = String(className);
      var key;
      if (Entity._native && Entity._native() && OV && typeof OV.wepCreate === "function") {
        var res = OV.wepCreate(className);
        if (res && res.entIndex > 0) { var w = construct(className, res.entIndex | 0, false); w._r.isNative = true; w._r.key = res.entIndex | 0; return w; }
      }
      key = Entity._allocLogical ? Entity._allocLogical() : (-1 - Math.floor(Math.random() * 1e6));
      return construct(className, key, false);
    }
  };

  globalThis.weapons = weapons;
  globalThis.scripted_weapons = scripted_weapons;

  // ---- base weapon SWEP: default combat behaviour all weapons inherit ----
  // Registered here so weapon_base always exists (like ents.js base classes).
  scripted_weapons.Register({
    PrintName: "Scripted Weapon",
    Author: "", Category: "OpenVibe",
    Spawnable: false, AdminOnly: false,
    Slot: 0, SlotPos: 0,
    ViewModel: "", WorldModel: "",
    HoldType: "pistol",
    Primary: { ClipSize: -1, DefaultClip: -1, Automatic: false, Ammo: "", Delay: 0.5, Damage: 0, NumShots: 1, Cone: 0.02, Sound: "", Recoil: 0 },
    Secondary: { ClipSize: -1, DefaultClip: -1, Automatic: false, Ammo: "" },

    Initialize: function () { this.SetWeaponHoldType(this.HoldType || "pistol"); },
    Deploy: function () { this._w.deployed = true; this.SendWeaponAnim(2 /* ACT_VM_DRAW */); return true; },
    Holster: function () { this._w.deployed = false; return true; },

    // GMod: CanPrimaryAttack checks clip + timing.
    CanPrimaryAttack: function () {
      var now = OV && OV.time ? OV.time() : 0;
      if (now < this.GetNextPrimaryFire()) return false;
      if (this.Clip1() === 0) { this.EmitSound("Weapon.empty"); this.SetNextPrimaryFire(now + 0.5); return false; }
      return true;
    },
    PrimaryAttack: function () {
      if (!this.CanPrimaryAttack()) return;
      var p = this.Primary, now = OV && OV.time ? OV.time() : 0;
      this.ShootPrimary();
      if (this.Clip1() > 0) this.TakePrimaryAmmo(1);
      this.SetNextPrimaryFire(now + (p.Delay || 0.5));
      if (globalThis.hook) { try { hook.Run("OnWeaponPrimaryAttack", this, this.GetOwner()); } catch (e) {} }
    },
    SecondaryAttack: function () {
      if (globalThis.hook) { try { hook.Run("OnWeaponSecondaryAttack", this, this.GetOwner()); } catch (e) {} }
    },
    Reload: function () {
      var now = OV && OV.time ? OV.time() : 0;
      if (now < this._w.nextReload) return;
      var max = this.GetMaxClip1();
      if (max > 0) this.SetClip1(max);
      this._w.nextReload = now + 1.5;
      this.SendWeaponAnim(6 /* ACT_VM_RELOAD */);
    },
    Think: function () {}
  }, "weapon_base");

  if (OV && OV.log) OV.log("weapons library ready");
})();
