// ov_bouncy_crate — demo scripted entity (folder form, GMod SENT layout).
// shared.js runs in both realms; the loader provides the ENT global.
ENT.Type = "anim";
ENT.Base = "base_gmodentity";
ENT.PrintName = "Bouncy Crate";
ENT.Author = "OpenVibe.Games";
ENT.Spawnable = true;
ENT.Category = "OpenVibe";

ENT.SetupDataTables = function () {
  this.NetworkVar("Int", 0, "Bounces");
};
