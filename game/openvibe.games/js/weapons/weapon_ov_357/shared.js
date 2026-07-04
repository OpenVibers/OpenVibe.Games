// OV .357 — high-damage low-capacity revolver.
SWEP.Base = "weapon_ov_base";
SWEP.PrintName = "OV .357 Magnum";
SWEP.Slot = 1; SWEP.SlotPos = 1;
SWEP.HoldType = "revolver";
SWEP.ViewModel = "models/weapons/v_357.mdl";
SWEP.WorldModel = "models/weapons/w_357.mdl";
SWEP.Primary = { ClipSize: 6, DefaultClip: 6, Automatic: false, Ammo: "357",
  Delay: 0.75, Damage: 40, NumShots: 1, Cone: 0.005, Recoil: 6, Sound: "Weapon_357.Single" };
