let state = "build";
let stateEndsAt = 0;

const allowedParts = new Set(["crate", "barrel", "pallet", "fence", "sheet"]);

export const GM = {
  mode: "fortwars",
  name: "OpenVibe Fort Wars",

  Initialize() {
    state = "build";
    stateEndsAt = game.time() + 180;
    game.broadcast("Fort Wars build phase started.");
  },

  PlayerInitialSpawn(ply) {
    ply.chat("Fort Wars: build first, fight second.");
  },

  PlayerSay(ply, text) {
    if (!text.startsWith("!build ")) return undefined;

    if (state !== "build") {
      ply.chat("Build phase is over.");
      return false;
    }

    const part = text.slice("!build ".length).trim();
    if (!allowedParts.has(part)) {
      ply.chat("Allowed: crate, barrel, pallet, fence, sheet");
      return false;
    }

    ply.runCommand(`ov_fortwars_spawn ${part}`);
    return false;
  },

  Think() {
    if (state === "build" && game.time() >= stateEndsAt) {
      state = "fight";
      stateEndsAt = game.time() + 420;
      game.broadcast("Fort Wars fight phase started.");
    }

    if (state === "fight" && game.time() >= stateEndsAt) {
      state = "ended";
      game.broadcast("Fort Wars ended.");
      OV.endMatch("time_expired");
    }
  }
};

gamemode.set(GM);
