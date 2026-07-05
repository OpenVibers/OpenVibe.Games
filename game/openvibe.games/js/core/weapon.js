// OpenVibe Weapon class — the weapon-entity wrapper, GMod SWEP semantics.
// https://wiki.facepunch.com/gmod/Weapon
//
// In GMod a weapon IS an entity (a scripted SWEP). Weapon extends Entity and
// adds the combat surface: clips/ammo, owner, view/world models, bullet firing,
// and animation. The C++ side (ov_js_weapon.cpp) backs a real CBaseCombatWeapon
// when running in-engine and forwards the engine's attack callbacks into the JS
// SWEP; with no native backend (tests / pure-JS) it degrades to logical state.
(function () {
  if (globalThis.Weapon && globalThis.Weapon.__openvibe) return;

  var OV = globalThis.OV;
  var Entity = globalThis.Entity;
  if (!Entity) { OV && OV.error && OV.error("weapon.js requires entity.js"); return; }

  // Native weapon call: OV.wepCall(entIndex, method, args) — mirrors entCall.
  function wnat(wep, method, args) {
    if (wep && wep._r && wep._r.isNative && OV && typeof OV.wepCall === "function") {
      try { return OV.wepCall(wep._r.key | 0, method, args || []); } catch (e) {
        OV && OV.warn && OV.warn("wepCall " + method + ": " + (e && e.message));
      }
    }
    return undefined;
  }

  // Weapon extends Entity. Construction reuses Entity's constructor; ents/weapons
  // libraries set the prototype to the registered SWEP proto.
  function Weapon(key) {
    Entity.call(this, key);
    this._w = {
      clip1: -1, clip2: -1,
      owner: globalThis.NULL,
      nextPrimary: 0, nextSecondary: 0, nextReload: 0,
      deployed: false
    };
  }
  Weapon.prototype = Object.create(Entity.prototype);
  Weapon.prototype.constructor = Weapon;

  var W = Weapon.prototype;
  W.__openvibe = true;
  W.IsWeapon = function () { return true; };
  W.IsValid = function () { return !this._r.removed; }; // real removal semantics (OnRemove wiring)

  // ---- ownership ----
  W.GetOwner = function () { var n = wnat(this, "getOwner"); if (n && n.entIndex != null) return globalThis.ents ? ents.GetByIndex(n.entIndex) : this._w.owner; return this._w.owner; };
  W.SetOwner = function (ply) { this._w.owner = ply; wnat(this, "setOwner", [ply && ply.EntIndex ? ply.EntIndex() : -1]); };
  W.GetActivity = function () { return wnat(this, "getActivity") || 0; };

  // ---- clips / ammo ----
  W.Clip1 = function () { var v = wnat(this, "clip1"); return v != null ? v | 0 : this._w.clip1; };
  W.Clip2 = function () { var v = wnat(this, "clip2"); return v != null ? v | 0 : this._w.clip2; };
  W.SetClip1 = function (n) { this._w.clip1 = n | 0; wnat(this, "setClip1", [n | 0]); };
  W.SetClip2 = function (n) { this._w.clip2 = n | 0; wnat(this, "setClip2", [n | 0]); };
  W.GetMaxClip1 = function () { return (this.Primary && this.Primary.ClipSize) || -1; };
  W.GetMaxClip2 = function () { return (this.Secondary && this.Secondary.ClipSize) || -1; };
  W.GetPrimaryAmmoType = function () { var v = wnat(this, "getPrimaryAmmoType"); return v != null ? v | 0 : -1; };
  W.GetSecondaryAmmoType = function () { var v = wnat(this, "getSecondaryAmmoType"); return v != null ? v | 0 : -1; };
  W.TakePrimaryAmmo = function (n) { var c = this.Clip1(); if (c >= 0) this.SetClip1(Math.max(0, c - (n | 0 || 1))); wnat(this, "takePrimaryAmmo", [n | 0 || 1]); };
  W.TakeSecondaryAmmo = function (n) { var c = this.Clip2(); if (c >= 0) this.SetClip2(Math.max(0, c - (n | 0 || 1))); wnat(this, "takeSecondaryAmmo", [n | 0 || 1]); };
  W.HasAmmo = function () { return this.Clip1() !== 0; };
  // GMod SWEP:Ammo1/Ammo2 — the owner's reserve ammo for this weapon's types.
  W.Ammo1 = function () {
    var o = this.GetOwner();
    var t = this.Primary && this.Primary.Ammo;
    return o && typeof o.GetAmmoCount === "function" ? o.GetAmmoCount(t) : 0;
  };
  W.Ammo2 = function () {
    var o = this.GetOwner();
    var t = this.Secondary && this.Secondary.Ammo;
    return o && typeof o.GetAmmoCount === "function" ? o.GetAmmoCount(t) : 0;
  };

  // ---- timing gates (GMod: SetNextPrimaryFire uses CurTime) ----
  W.GetNextPrimaryFire = function () { return this._w.nextPrimary; };
  W.SetNextPrimaryFire = function (t) { this._w.nextPrimary = +t || 0; wnat(this, "setNextPrimaryFire", [+t || 0]); };
  W.GetNextSecondaryFire = function () { return this._w.nextSecondary; };
  W.SetNextSecondaryFire = function (t) { this._w.nextSecondary = +t || 0; wnat(this, "setNextSecondaryFire", [+t || 0]); };
  W.SetNextIdle = function (t) { wnat(this, "setNextIdle", [+t || 0]); };

  // ---- models / animation ----
  W.GetViewModel = function () { return this.ViewModel || ""; };
  W.GetWorldModel = function () { return this.WorldModel || ""; };
  W.SendWeaponAnim = function (act) { wnat(this, "sendWeaponAnim", [act | 0]); };
  W.SetWeaponHoldType = function (t) { this.HoldType = String(t); wnat(this, "setHoldType", [String(t)]); };

  // ---- firing helpers (engine-backed; logical no-op in tests) ----
  // opts: { Num, Src, Dir, Spread:{x,y}, Damage, Force, Tracer, AmmoType, ... }
  W.FireBullets = function (opts) {
    opts = opts || {};
    wnat(this, "fireBullets", [{
      num: opts.Num | 0 || 1,
      spreadX: (opts.Spread && opts.Spread.x) || 0,
      spreadY: (opts.Spread && opts.Spread.y) || 0,
      damage: +opts.Damage || 0,
      force: +opts.Force || 1,
      ammoType: opts.AmmoType != null ? opts.AmmoType : this.GetPrimaryAmmoType(),
      tracer: opts.Tracer != null ? opts.Tracer : 1
    }]);
    if (globalThis.hook) { try { hook.Run("EntityFireBullets", this.GetOwner(), opts); } catch (e) {} }
  };
  W.ShootEffects = function () { wnat(this, "shootEffects"); };
  W.EmitSound = function (snd, lvl, pitch) { wnat(this, "emitSound", [String(snd), lvl | 0 || 75, pitch | 0 || 100]); Entity.prototype.EmitSound && Entity.prototype.EmitSound.call(this, snd); };

  // Fire a muzzle + view punch + bullet using this weapon's Primary table.
  W.ShootPrimary = function () {
    var p = this.Primary || {};
    var owner = this.GetOwner();
    this.ShootEffects();
    this.FireBullets({
      Num: p.NumShots || 1,
      Damage: p.Damage || 0,
      Force: p.Force || 1,
      Spread: p.Cone ? { x: p.Cone, y: p.Cone } : { x: 0.01, y: 0.01 },
      Tracer: p.Tracer != null ? p.Tracer : 1
    });
    if (p.Sound) this.EmitSound(p.Sound);
    if (owner && owner.ViewPunch && p.Recoil) owner.ViewPunch({ p: -(p.Recoil), y: 0, r: 0 });
  };

  globalThis.Weapon = Weapon;
  if (OV && OV.log) OV.log("Weapon class ready");
})();
