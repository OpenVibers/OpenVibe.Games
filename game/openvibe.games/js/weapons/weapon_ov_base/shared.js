// OpenVibe base firearm — shared defaults for the JS-coded weapons.
// Extends weapon_base (js/core/weapons.js) with HL2MP-style hitscan firing.
SWEP.Base = "weapon_base";
SWEP.Author = "OpenVibe";
SWEP.Category = "OpenVibe";
SWEP.Spawnable = true;
SWEP.PrintName = "OV Weapon";
SWEP.HoldType = "pistol";

SWEP.Primary = {
  ClipSize: 18, DefaultClip: 18, Automatic: false, Ammo: "Pistol",
  Delay: 0.2, Damage: 10, NumShots: 1, Cone: 0.02, Recoil: 1.5,
  Sound: "Weapon_Pistol.Single"
};
SWEP.Secondary = { ClipSize: -1, DefaultClip: -1, Automatic: false, Ammo: "" };

// Iron-sight zoom as the shared secondary for firearms.
SWEP.SecondaryAttack = function () {
  var owner = this.GetOwner();
  this._w.zoomed = !this._w.zoomed;
  if (owner && owner.SetFOV) owner.SetFOV(this._w.zoomed ? 55 : 0, 0.2);
  this.SetNextSecondaryFire((OV && OV.time ? OV.time() : 0) + 0.3);
};

SWEP.OnDrop = function () { var o = this.GetOwner(); if (o && o.SetFOV && this._w.zoomed) o.SetFOV(0, 0); };
