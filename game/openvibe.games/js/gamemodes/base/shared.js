// OpenVibe base gamemode — shared realm (both server and client).
// Identity + shared constants live here; realm entries build on them.
(function () {
  globalThis.OVBase = {
    TEAM_UNASSIGNED: 0,
    TEAM_SPECTATOR: 1,
    // Modes define their own playable teams as 2/3.
    HUD_NET: "OV_HudState",
    hudState: null // last known round/HUD snapshot (client keeps it fresh)
  };

  if (globalThis.OV && OV.log) OV.log("base shared.js loaded (realm=" + (globalThis.SERVER ? "server" : "client") + ")");
})();
