const GM = {
  mode: "deathrun",
  name: "OpenVibe Deathrun",

  Initialize() {
    OV.log("Deathrun Initialize fired");
  },

  PlayerInitialSpawn(ply) {
    ply.chat("Deathrun: survive the traps and reach the finish.");
  },

  PlayerSay(ply, text) {
    if (text === "!finish") {
      ply.chat("Deathrun finish test.");
      OV.reward(ply, 50, 100, "deathrun_finish");
      return false;
    }

    return undefined;
  }
};

gamemode.set(GM);
