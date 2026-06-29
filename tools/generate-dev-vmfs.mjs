import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const root = process.env.OPENVIBE_ROOT ?? resolve(import.meta.dirname, "..");
const vmfDir = resolve(root, "hammer", "vmf");

let nextId = 1;

const textures = {
  dev: "DEV/DEV_MEASUREGENERIC01",
  floor: "DEV/DEV_MEASUREWALL01A",
  pad: "DEV/DEV_BLENDMEASURE",
  trigger: "TOOLS/TOOLSTRIGGER",
};

const useAuthenticatedJoin = process.env.OPENVIBE_USE_OV_JOIN === "1";

const localHosts = {
  hub: "127.0.0.1",
  prophunt: "127.0.0.1",
  deathrun: "127.0.0.1",
  fortwars: "127.0.0.1",
  traitortown: "127.0.0.1",
};

function joinCommand(mode, port) {
  if (useAuthenticatedJoin) return `ov_join ${mode}`;
  return `connect ${localHosts[mode] ?? localHosts.hub}:${port}`;
}

function id() {
  return nextId++;
}

function kv(key, value, indent = 2) {
  return `${"  ".repeat(indent)}"${key}" "${value}"`;
}

function point(x, y, z) {
  return `(${x} ${y} ${z})`;
}

function side(plane, material) {
  const sideId = id();
  return [
    "    side",
    "    {",
    kv("id", sideId, 3),
    kv("plane", plane, 3),
    kv("material", material, 3),
    kv("uaxis", "[1 0 0 0] 0.25", 3),
    kv("vaxis", "[0 -1 0 0] 0.25", 3),
    kv("rotation", "0", 3),
    kv("lightmapscale", "16", 3),
    kv("smoothing_groups", "0", 3),
    "    }",
  ].join("\n");
}

function solid(name, min, max, material = textures.dev, indent = 2) {
  const [x1, y1, z1] = min;
  const [x2, y2, z2] = max;
  const lines = [
    `${"  ".repeat(indent)}solid`,
    `${"  ".repeat(indent)}{`,
    kv("id", id(), indent + 1),
  ];

  void name;

  const faces = [
    [point(x1, y1, z2), point(x2, y1, z2), point(x2, y2, z2)],
    [point(x1, y2, z1), point(x2, y2, z1), point(x2, y1, z1)],
    [point(x1, y2, z1), point(x1, y2, z2), point(x2, y2, z2)],
    [point(x2, y1, z1), point(x2, y1, z2), point(x1, y1, z2)],
    [point(x2, y2, z1), point(x2, y2, z2), point(x2, y1, z2)],
    [point(x1, y1, z1), point(x1, y1, z2), point(x1, y2, z2)],
  ];

  for (const [a, b, c] of faces) {
    lines.push(side(`${a} ${c} ${b}`, material));
  }

  lines.push(`${"  ".repeat(indent)}}`);
  return lines.join("\n");
}

function entity(properties, children = []) {
  const lines = ["  entity", "  {", kv("id", id(), 2)];
  for (const [key, value] of Object.entries(properties)) {
    lines.push(kv(key, value, 2));
  }
  lines.push(...children);
  lines.push("  }");
  return lines.join("\n");
}

function output(outputName, target, input, parameter = "", delay = "0", once = "-1") {
  return `"${outputName}" "${target},${input},${parameter},${delay},${once}"`;
}

function trigger(name, min, max, targetCommand, command) {
  return entity(
    {
      classname: "trigger_multiple",
      targetname: name,
      StartDisabled: "0",
      spawnflags: "1",
      wait: "1",
    },
    [
      "    connections",
      "    {",
      `      ${output("OnStartTouch", targetCommand, "Command", command)}`,
      "    }",
      solid(null, min, max, textures.trigger, 2),
    ],
  );
}

function light(origin, brightness = "255 244 214 450") {
  return entity({
    classname: "light",
    origin: origin.join(" "),
    _light: brightness,
  });
}

function spawn(origin, angle = 0) {
  return entity({
    classname: "info_player_deathmatch",
    origin: origin.join(" "),
    angles: `0 ${angle} 0`,
  });
}

function pointCommand(name, origin) {
  return entity({
    classname: "point_clientcommand",
    targetname: name,
    origin: origin.join(" "),
  });
}

function infoTarget(name, origin, label) {
  return entity({
    classname: "info_target",
    targetname: name,
    origin: origin.join(" "),
    comment: label,
  });
}

// logic_script entity — loads a VScript file when the map spawns.
function logicScript(scriptFile, origin = [0, 0, 64]) {
  return entity({
    classname: "logic_script",
    targetname: "ov_logic_script",
    vscripts: scriptFile,
    origin: origin.join(" "),
  });
}

// game_text entity used by VScript for in-game HUD announcements.
// channel 1-4, x/y in 0..1 (-1 = center)
function gameText(name, channel, msg, x = "-1", y = "0.05", holdTime = "4") {
  return entity({
    classname: "game_text",
    targetname: name,
    message: msg,
    color: "255 255 255",
    color2: "240 110 0",
    fadein: "0.25",
    fadeout: "0.5",
    holdtime: holdTime,
    fxtime: "0.15",
    channel: channel.toString(),
    x: x.toString(),
    y: y.toString(),
    effect: "0",
    origin: "0 0 64",
  });
}

// logic_auto entity — fires on map/round start.
function logicAuto(connections = []) {
  const lines = ["  entity", "  {", kv("id", id(), 2), kv("classname", "logic_auto", 2)];
  if (connections.length > 0) {
    lines.push("    connections", "    {");
    for (const c of connections) lines.push(`      ${c}`);
    lines.push("    }");
  }
  lines.push("  }");
  return lines.join("\n");
}

// Team-specific spawn point (info_player_teamspawn for TF2-style team spawns).
function teamSpawn(origin, teamNum, angle = 0) {
  return entity({
    classname: "info_player_teamspawn",
    origin: origin.join(" "),
    angles: `0 ${angle} 0`,
    TeamNum: teamNum.toString(),
  });
}

function propNpc(name, origin, angle = 180) {
  return entity({
    classname: "prop_dynamic",
    targetname: name,
    origin: origin.join(" "),
    angles: `0 ${angle} 0`,
    model: "models/Humans/Group03/male_07.mdl",
    solid: "0",
  });
}

function roomSolids(size = 2048, height = 384) {
  const h = size / 2;
  return [
    solid("floor", [-h, -h, -64], [h, h, 0], textures.floor),
    solid("ceiling", [-h, -h, height], [h, h, height + 64], textures.dev),
    solid("north_wall", [-h, h, 0], [h, h + 64, height], textures.dev),
    solid("south_wall", [-h, -h - 64, 0], [h, -h, height], textures.dev),
    solid("east_wall", [h, -h, 0], [h + 64, h, height], textures.dev),
    solid("west_wall", [-h - 64, -h, 0], [-h, h, height], textures.dev),
  ];
}

function header(mapName) {
  return [
    "versioninfo",
    "{",
    kv("editorversion", "400", 1),
    kv("editorbuild", "8871", 1),
    kv("mapversion", "1", 1),
    kv("formatversion", "100", 1),
    kv("prefab", "0", 1),
    "}",
    "visgroups",
    "{",
    "}",
    "viewsettings",
    "{",
    kv("bSnapToGrid", "1", 1),
    kv("bShowGrid", "1", 1),
    kv("bShowLogicalGrid", "0", 1),
    kv("nGridSpacing", "32", 1),
    kv("bShow3DGrid", "0", 1),
    "}",
    "world",
    "{",
    kv("id", id(), 1),
    kv("mapversion", "1", 1),
    kv("classname", "worldspawn", 1),
    kv("skyname", "sky_day01_01", 1),
    kv("detailmaterial", "detail/detailsprites", 1),
    kv("detailvbsp", "detail.vbsp", 1),
    kv("maxpropscreenwidth", "-1", 1),
    `  // ${mapName}`,
  ].join("\n");
}

function footer() {
  return [
    "cameras",
    "{",
    kv("activecamera", "-1", 1),
    "}",
    "cordons",
    "{",
    kv("active", "0", 1),
    "}",
    "",
  ].join("\n");
}

function buildMap(mapName, generateContent) {
  nextId = 1;
  const head = header(mapName);
  const { worldSolids, entities } = generateContent();

  return [
    head,
    ...worldSolids,
    "}",
    ...entities,
    footer(),
  ].join("\n");
}

function hub() {
  return buildMap("ov_hub", () => {
    const pads = [
      {
        label: "Prop Hunt",
        mode: "prophunt",
        origin: [-640, 360, 0],
        port: 27016,
      },
      {
        label: "Deathrun",
        mode: "deathrun",
        origin: [-220, 360, 0],
        port: 27017,
      },
      {
        label: "Fort Wars",
        mode: "fortwars",
        origin: [220, 360, 0],
        port: 27018,
      },
      {
        label: "Traitor Town",
        mode: "traitortown",
        origin: [640, 360, 0],
        port: 27019,
      },
    ];

    const worldSolids = [
      ...roomSolids(2304, 448),
      solid("shop_counter", [-256, -780, 0], [256, -720, 96], textures.pad),
      solid("inventory_station", [560, -780, 0], [800, -700, 96], textures.pad),
      ...pads.map((pad) =>
        solid(
          `${pad.mode}_portal_pad`,
          [pad.origin[0] - 128, pad.origin[1] - 128, 0],
          [pad.origin[0] + 128, pad.origin[1] + 128, 16],
          textures.pad,
        ),
      ),
    ];

    const entities = [
      // VScript loader — runs ov_hub.nut when the map spawns
      logicScript("ov_hub"),

      // HUD text entities for VScript announcements
      gameText("ov_hud_1", 1, "OpenVibe Hub", "-1", "0.05", "6"),
      gameText("ov_hud_2", 2, "", "-1", "0.12", "3"),

      light([0, 0, 320], "255 244 214 650"),
      light([-700, -600, 280], "120 170 255 350"),
      light([700, -600, 280], "255 210 120 350"),
      ...Array.from({ length: 12 }, (_, index) => {
        const x = -420 + (index % 6) * 168;
        const y = -220 + Math.floor(index / 6) * 140;
        return spawn([x, y, 24], 0);
      }),
      propNpc("npc_shop_models", [-120, -660, 16], 0),
      propNpc("npc_shop_trails", [120, -660, 16], 0),
      infoTarget("ov_shop_models", [-120, -600, 80], "Model shop placeholder"),
      infoTarget("ov_inventory_station", [680, -640, 80], "Inventory station placeholder"),
      ...pads.flatMap((pad) => {
        const commandTarget = `cmd_join_${pad.mode}`;
        return [
          pointCommand(commandTarget, [pad.origin[0], pad.origin[1], 80]),
          infoTarget(`portal_label_${pad.mode}`, [pad.origin[0], pad.origin[1], 96], `${pad.label} portal`),
          trigger(
            `trigger_join_${pad.mode}`,
            [pad.origin[0] - 128, pad.origin[1] - 128, 16],
            [pad.origin[0] + 128, pad.origin[1] + 128, 128],
            commandTarget,
            joinCommand(pad.mode, pad.port),
          ),
        ];
      }),
    ];

    return { worldSolids, entities };
  });
}

const modeScripts = {
  prophunt: "ov_prophunt",
  deathrun: "ov_deathrun",
  fortwars: "ov_fortwars",
  traitortown: "ov_traitortown",
};

function minigame(mapName, modeName, returnX = 0) {
  const scriptFile = modeScripts[modeName] ?? `ov_${modeName}`;

  return buildMap(mapName, () => {
    const worldSolids = [
      ...roomSolids(1792, 384),
      solid(`${modeName}_play_lane`, [-512, -64, 0], [512, 64, 12], textures.pad),
      solid("return_hub_pad", [returnX - 128, 580, 0], [returnX + 128, 836, 16], textures.pad),
    ];

    const entities = [
      // VScript loader for this game mode
      logicScript(scriptFile),

      // HUD text entities used by VScript (channels 1–4)
      gameText("ov_hud_1", 1, "Waiting for players...", "-1", "0.05", "4"),
      gameText("ov_hud_2", 2, "", "-1", "0.12", "3"),   // timer
      gameText("ov_hud_3", 3, "", "-1", "0.85", "3"),   // score
      gameText("ov_hud_4", 4, "", "0.72", "0.10", "5"), // role

      // Finish line info_target for Deathrun
      infoTarget("finish_line", [0, -480, 32], "Finish line / goal area"),

      light([0, 0, 300], "255 244 214 550"),
      light([0, 620, 260], "120 170 255 300"),

      // Team A spawns (runners / props / innocents / team A)
      ...Array.from({ length: 6 }, (_, i) => {
        const x = -250 + i * 100;
        return teamSpawn([x, -480, 24], 2, 0);
      }),

      // Team B spawns (activator / hunters / traitors / team B)
      ...Array.from({ length: 4 }, (_, i) => {
        const x = -150 + i * 100;
        return teamSpawn([x, 480, 24], 3, 180);
      }),

      // Deathmatch fallback spawns
      ...Array.from({ length: 10 }, (_, index) => {
        const x = -360 + (index % 5) * 180;
        const y = -520 + Math.floor(index / 5) * 140;
        return spawn([x, y, 24], 0);
      }),

      infoTarget(`ov_mode_${modeName}`, [0, 0, 96], `${modeName} development map`),
      pointCommand("cmd_return_hub", [returnX, 720, 80]),
      trigger(
        "trigger_return_hub",
        [returnX - 128, 580, 16],
        [returnX + 128, 836, 128],
        "cmd_return_hub",
        joinCommand("hub", 27015),
      ),
    ];

    return { worldSolids, entities };
  });
}

const maps = new Map([
  ["ov_hub.vmf", hub()],
  ["ph_openvibe_dev.vmf", minigame("ph_openvibe_dev", "prophunt", -512)],
  ["dr_openvibe_dev.vmf", minigame("dr_openvibe_dev", "deathrun", -256)],
  ["fw_openvibe_dev.vmf", minigame("fw_openvibe_dev", "fortwars", 256)],
  ["tt_openvibe_dev.vmf", minigame("tt_openvibe_dev", "traitortown", 512)],
]);

await mkdir(vmfDir, { recursive: true });

for (const [file, content] of maps) {
  const path = resolve(vmfDir, file);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
  console.log(`[vmf] wrote ${path}`);
}
