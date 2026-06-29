export const GM = {
  mode: "hub",
  name: "OpenVibe Hub",

  Initialize() {
    game.broadcast("OpenVibe Hub online");
  },

  PlayerInitialSpawn(ply) {
    ply.chat("Welcome to the OpenVibe Hub");
    ply.chat("Use the portals to join Prop Hunt, Deathrun, Fort Wars, or Traitor Town.");
  },

  HubPortalUse(ply, mode) {
    ply.chat(`Sending you to ${mode}...`);
    ply.runCommand(`ov_join ${mode}`);
    return true;
  },

  ShopNpcUse(ply, category) {
    ply.chat(`Opening ${category} shop...`);
    ply.runCommand(`ov_open_url https://openvibe.games/me/inventory`);
    return true;
  }
};

gamemode.set(GM);
