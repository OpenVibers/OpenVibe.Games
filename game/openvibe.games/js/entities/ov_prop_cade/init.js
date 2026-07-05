// Server: physical prop body + HP/damage lifecycle.
ENT.Initialize = function () {
  // The cade's physical body is a real prop; model/pos are set by the deployer.
  if (this.SetModel && this._r.cadeModel) this.SetModel(this._r.cadeModel);
  if (this.PhysicsInit) this.PhysicsInit(6 /* SOLID_VPHYSICS */);
  if (this.SetMoveType) this.SetMoveType(6 /* MOVETYPE_VPHYSICS */);
  var hp = this._r.cadeHP || 100;
  this.SetHealth(hp);
  this.SetMaxHealth(hp);
};

// Damage decrements HP (no healing); remove at 0 (Devolved OnTakeDamage).
ENT.OnTakeDamage = function (dmg) {
  var amount = Math.max(0, (dmg && dmg.GetDamage ? dmg.GetDamage() : (dmg && dmg.amount) || 0));
  var hp = this.GetHealth() - amount;
  this.SetHealth(hp);
  if (globalThis.hook) { try { hook.Run("OVCadeDamaged", this, amount, hp); } catch (e) {} }
  if (hp <= 0) {
    if (globalThis.hook) { try { hook.Run("OVCadeDestroyed", this, this.GetCadeOwner()); } catch (e) {} }
    this.Remove();
  }
  return amount;
};
