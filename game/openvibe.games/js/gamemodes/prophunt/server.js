let state = "waiting";
let roundEndsAt = 0;

const propChoices = ["can", "crate", "barrel", "chair", "bucket"];

function randomProp() {
  return propChoices[Math.floor(Math.random() * propChoices.length)];
}

export const GM = {
  mode: "prophunt",
  name: "OpenVibe Prop Hunt",

  Initialize() {
    state = "waiting";
    console.log("Prop Hunt initialized");
  },

  PlayerInitialSpawn(ply) {
    ply.chat("Prop Hunt: hide as props or hunt them down.");
  },

  PlayerSpawn(ply) {
    if (state === "hide") {
      ply.runCommand(`ov_prophunt_disguise ${randomProp()}`);
    }
  },

  PlayerSay(ply, text) {
    if (text === "!prop") {
      ply.runCommand(`ov_prophunt_disguise ${randomProp()}`);
      return false;
    }

    if (text.startsWith("!prop ")) {
      const choice = text.slice("!prop ".length).trim();
      ply.runCommand(`ov_prophunt_disguise ${choice}`);
      return false;
    }

    return undefined;
  },

  RoundStart() {
    state = "hide";
    roundEndsAt = game.time() + 300;
    game.broadcast("Prop Hunt round started. Props hide. Hunters seek.");
  },

  Think() {
    if (state === "hide" && game.time() >= roundEndsAt) {
      state = "ended";
      game.broadcast("Props win!");
      OV.endMatch("props_win");
    }
  }
};

gamemode.set(GM);
