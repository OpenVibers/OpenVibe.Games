// OV Crowbar — melee; trace-based swing instead of hitscan bullets.
SWEP.Base = "weapon_base";
SWEP.Author = "OpenVibe";
SWEP.Category = "OpenVibe";
SWEP.Spawnable = true;
SWEP.PrintName = "OV Crowbar";
SWEP.Slot = 0; SWEP.SlotPos = 0;
SWEP.HoldType = "melee";
SWEP.ViewModel = "models/weapons/v_crowbar.mdl";
SWEP.WorldModel = "models/weapons/w_crowbar.mdl";
SWEP.Primary = { ClipSize: -1, DefaultClip: -1, Automatic: false, Ammo: "",
  Delay: 0.4, Damage: 25, Range: 75, Sound: "Weapon_Crowbar.Single" };
SWEP.PrimaryAttack = function () {
  var now = OV && OV.time ? OV.time() : 0;
  if (now < this.GetNextPrimaryFire()) return;
  this.SetNextPrimaryFire(now + this.Primary.Delay);
  this.SendWeaponAnim(3 /* ACT_VM_HITCENTER */);
  if (this.Primary.Sound) this.EmitSound(this.Primary.Sound);
  // Melee trace forward; engine native performs the hull trace + damage.
  this.wnat = this.wnat; // (no-op marker)
  if (globalThis.hook) { try { hook.Run("OVWeaponMelee", this, this.GetOwner(), this.Primary.Damage, this.Primary.Range); } catch (e) {} }
};
SWEP.SecondaryAttack = function () {};
SWEP.Reload = function () {};
