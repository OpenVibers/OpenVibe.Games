// ov_bouncy_crate — server realm.
AddCSJSFile("entities/ov_bouncy_crate/shared.js");
AddCSJSFile("entities/ov_bouncy_crate/cl_init.js");
include("entities/ov_bouncy_crate/shared.js");

ENT.Initialize = function () {
  this.SetModel("models/props_junk/wood_crate001a.mdl");
  this.PhysicsInit(SOLID_VPHYSICS);
  this.SetMoveType(MOVETYPE_VPHYSICS);
  this.SetSolid(SOLID_VPHYSICS);
  this.SetHealth(50);
  this.SetMaxHealth(50);
  this.SetBounces(0);
  const phys = this.GetPhysicsObject();
  if (IsValid(phys)) phys.Wake();
  this.NextThink(CurTime() + 2);
};

ENT.Think = function () {
  // Hop every 2 seconds.
  this.SetBounces(this.GetBounces() + 1);
  const phys = this.GetPhysicsObject();
  if (IsValid(phys)) phys.ApplyForceCenter({ x: 0, y: 0, z: 4000 });
  this.NextThink(CurTime() + 2);
};

ENT.OnTakeDamage = function (dmg) {
  this.SetHealth(this.Health() - dmg.GetDamage());
  if (this.Health() <= 0) this.Remove();
};

ENT.OnRemove = function () {
  if (globalThis.OV && OV.log) OV.log("bouncy crate removed after " + this.GetBounces() + " bounces");
};

ENT.Use = function (activator) {
  if (activator && activator.ChatPrint) activator.ChatPrint("Crate has bounced " + this.GetBounces() + " times.");
};
