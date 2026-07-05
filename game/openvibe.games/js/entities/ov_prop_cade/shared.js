// ov_prop_cade — a deployed cade (barricade). Ported from Devolved prop_cade:
// networked owner/health/maxhp (DTInt 0/1/2), damage decrements HP, removed at 0.
ENT.Type = "anim";
ENT.Base = "base_gmodentity";
ENT.PrintName = "Cade";

ENT.SetupDataTables = function () {
  this.NetworkVar("Int", 0, "CadeOwner");
  this.NetworkVar("Int", 1, "Health");
  this.NetworkVar("Int", 2, "MaxHealth");
};

// Convenience accessors matching Devolved naming.
ENT.GetOwnerIndex = function () { return this.GetCadeOwner(); };
