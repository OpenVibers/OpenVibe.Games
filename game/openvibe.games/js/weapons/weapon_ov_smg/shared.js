// OV SMG — full-auto with a grenade secondary hook.
SWEP.Base = "weapon_ov_base";
SWEP.PrintName = "OV SMG";
SWEP.Slot = 2; SWEP.SlotPos = 0;
SWEP.HoldType = "smg";
SWEP.ViewModel = "models/weapons/v_smg1.mdl";
SWEP.WorldModel = "models/weapons/w_smg1.mdl";
SWEP.Primary = { ClipSize: 45, DefaultClip: 45, Automatic: true, Ammo: "SMG1",
  Delay: 0.075, Damage: 6, NumShots: 1, Cone: 0.04, Recoil: 0.8, Sound: "Weapon_SMG1.Single" };
SWEP.Secondary = { ClipSize: -1, DefaultClip: -1, Automatic: false, Ammo: "SMG1_Grenade" };
SWEP.SecondaryAttack = function () {
  var now = OV && OV.time ? OV.time() : 0;
  if (now < this.GetNextSecondaryFire()) return;
  this.SetNextSecondaryFire(now + 1.0);
  if (globalThis.hook) { try { hook.Run("OVWeaponGrenadeLaunch", this, this.GetOwner()); } catch (e) {} }
};
