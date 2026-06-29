const allowed = new Set(["crate", "barrel", "pallet", "fence", "sheet"]);

const GM = {
  mode: "fortwars",
  name: "OpenVibe Fort Wars",

  Initialize() {
    OV.log("Fort Wars Initialize fired");
  },

  PlayerInitialSpawn(ply) {
    ply.chat("Fort Wars: build first, fight second.");
  },

  PlayerSay(ply, text) {
    if (!text.startsWith("!build ")) return undefined;

    const part = text.slice(7).trim();
    if (!allowed.has(part)) {
      ply.chat("Allowed: crate, barrel, pallet, fence, sheet");
      return false;
    }

    ply.runCommand(`ov_fortwars_spawn ${part}`);
    return false;
  }
};

gamemode.set(GM);
