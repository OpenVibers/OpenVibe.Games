const props = ["crate", "barrel", "chair", "bucket"];

function randomProp() {
  return props[Math.floor(Math.random() * props.length)];
}

const GM = {
  mode: "prophunt",
  name: "OpenVibe Prop Hunt",

  Initialize() {
    OV.log("Prop Hunt Initialize fired");
  },

  PlayerInitialSpawn(ply) {
    ply.chat("Prop Hunt: hide as props or hunt them down.");
  },

  PlayerSay(ply, text) {
    if (text === "!prop") {
      ply.runCommand(`ov_prophunt_disguise ${randomProp()}`);
      return false;
    }

    if (text.startsWith("!prop ")) {
      ply.runCommand(`ov_prophunt_disguise ${text.slice(6).trim()}`);
      return false;
    }

    return undefined;
  },

  Think() {}
};

gamemode.set(GM);
