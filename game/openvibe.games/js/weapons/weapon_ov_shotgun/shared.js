// OV Shotgun — multi-pellet spread, double-shot secondary.
SWEP.Base = "weapon_ov_base";
SWEP.PrintName = "OV Shotgun";
SWEP.Slot = 3; SWEP.SlotPos = 0;
SWEP.HoldType = "shotgun";
SWEP.ViewModel = "models/weapons/v_shotgun.mdl";
SWEP.WorldModel = "models/weapons/w_shotgun.mdl";
SWEP.Primary = { ClipSize: 6, DefaultClip: 6, Automatic: false, Ammo: "Buckshot",
  Delay: 0.7, Damage: 8, NumShots: 7, Cone: 0.08, Recoil: 4, Sound: "Weapon_Shotgun.Single" };
SWEP.SecondaryAttack = function () {
  if (!this.CanPrimaryAttack()) return;
  var now = OV && OV.time ? OV.time() : 0;
  this.Primary.NumShots = 14; this.ShootPrimary(); this.Primary.NumShots = 7;
  if (this.Clip1() > 1) this.TakePrimaryAmmo(2); else this.TakePrimaryAmmo(1);
  this.SetNextPrimaryFire(now + 0.9);
};
