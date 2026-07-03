// Example autorun script — runs in BOTH realms before the gamemode loads
// (GMod lua/autorun equivalent). Auto-networked to clients.
(function () {
  if (SERVER) {
    hook.Add("PlayerInitialSpawn", "OpenVibeMotd", function (ply) {
      if (globalThis.timer && timer.Simple) {
        timer.Simple(1, function () {
          if (ply && ply.ChatPrint) ply.ChatPrint("[MOTD] OpenVibe GModJS platform — !help for commands, F10 for console.");
        });
      }
    });
  } else {
    hook.Add("Initialize", "OpenVibeMotdClient", function () {
      OV.log("[MOTD] autorun ran on the client realm");
    });
  }
})();
