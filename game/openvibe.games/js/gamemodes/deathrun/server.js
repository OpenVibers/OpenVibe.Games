let roundState = "waiting";
let roundEndsAt = 0;

export const GM = {
  mode: "deathrun",
  name: "OpenVibe Deathrun",

  Initialize() {
    roundState = "waiting";
  },

  PlayerInitialSpawn(ply) {
    ply.chat("Deathrun: survive the traps and reach the finish.");
  },

  RoundStart() {
    roundState = "running";
    roundEndsAt = game.time() + 420;
    game.broadcast("Deathrun round started.");
  },

  PlayerFinish(ply) {
    ply.chat("Finished Deathrun!");
    OV.reward(ply, 50, 100, "deathrun_finish");
    return true;
  },

  Think() {
    if (roundState === "running" && game.time() >= roundEndsAt) {
      roundState = "ended";
      game.broadcast("Deathrun time expired.");
      OV.endMatch("time_expired");
    }
  }
};

gamemode.set(GM);
