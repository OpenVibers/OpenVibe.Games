// Client: draw + spawn/remove effects. Owner/HP come from the NetworkVars.
ENT.Draw = function () { if (this.DrawModel) this.DrawModel(); };
ENT.OnRemove = function () { if (globalThis.hook) { try { hook.Run("OVCadeClientRemoved", this); } catch (e) {} } };
