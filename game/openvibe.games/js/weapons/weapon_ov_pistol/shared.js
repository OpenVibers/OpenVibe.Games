// OV Pistol — semi-auto hitscan sidearm.
SWEP.Base = "weapon_ov_base";
SWEP.PrintName = "OV Pistol";
SWEP.Slot = 1; SWEP.SlotPos = 0;
SWEP.HoldType = "pistol";
SWEP.ViewModel = "models/weapons/v_pistol.mdl";
SWEP.WorldModel = "models/weapons/w_pistol.mdl";
SWEP.Primary = { ClipSize: 18, DefaultClip: 18, Automatic: false, Ammo: "Pistol",
  Delay: 0.15, Damage: 8, NumShots: 1, Cone: 0.01, Recoil: 1.2, Sound: "Weapon_Pistol.Single" };
