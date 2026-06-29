import fs from "node:fs";
import vm from "node:vm";

const modeCommands = {
  hub: "hub_status",
  prophunt: "ph_status",
  deathrun: "dr_status",
  fortwars: "fw_status",
  traitortown: "ttt_status",
};

function makePlayer(messages) {
  return {
    userId: () => 1,
    entIndex: () => 1,
    steamId: () => "STEAM_0:1:1",
    name: () => "SmokePlayer",
    health: () => 100,
    setHealth: () => undefined,
    chat: (msg) => messages.push(`[chat] ${msg}`),
    team: () => 0,
    setTeam: () => undefined,
    runCommand: (cmd) => messages.push(`[runCommand] ${cmd}`),
  };
}

function runFile(context, file) {
  const code = fs.readFileSync(file, "utf8");
  vm.runInContext(code, context, { filename: file });
}

for (const [mode, commandName] of Object.entries(modeCommands)) {
  let fakeTime = 0;
  const messages = [];

  const context = vm.createContext({
    console,
    globalThis: {},
    OV: {
      log: (msg) => messages.push(`[log] ${msg}`),
      warn: (msg) => messages.push(`[warn] ${msg}`),
      error: (msg) => messages.push(`[error] ${msg}`),
      getMode: () => mode,
      getMapName: () => `${mode}_map`,
      time: () => fakeTime,
      broadcast: (msg) => messages.push(`[broadcast] ${msg}`),
      players: () => [makePlayer(messages)],
      playerByUserId: () => makePlayer(messages),
      serverCommand: (cmd) => messages.push(`[serverCommand] ${cmd}`),
      reward: () => undefined,
      endMatch: () => undefined,
    },
  });
  context.globalThis = context;

  [
    "game/openvibe.games/js/core/hook.js",
    "game/openvibe.games/js/core/gamemode.js",
    "game/openvibe.games/js/bridge.js",
    "game/openvibe.games/js/core/command.js",
    "game/openvibe.games/js/core/timer.js",
    "game/openvibe.games/js/gamemodes/base/server.js",
    `game/openvibe.games/js/gamemodes/${mode}/server.js`,
  ].forEach((file) => runFile(context, file));

  const ply = makePlayer(messages);
  context.gamemode.call("Initialize");
  context.gamemode.call("MapInitialize", `${mode}_map`);
  context.gamemode.call("PlayerInitialSpawn", ply);
  context.gamemode.call("PlayerSpawn", ply);
  context.gamemode.call("ConsoleCommand", commandName);
  fakeTime += 1;
  context.gamemode.call("Think");

  if (!context.GAMEMODE || context.GAMEMODE.mode !== mode) {
    throw new Error(`${mode}: GAMEMODE global was not set`);
  }

  if (!context.command.has(commandName)) {
    throw new Error(`${mode}: missing command ${commandName}`);
  }

  if (!messages.some((line) => line.includes("JS loaded") || line.includes("Welcome"))) {
    throw new Error(`${mode}: missing join/welcome output`);
  }
}

console.log("[openvibe-smoke] all JS gamemodes loaded and handled lifecycle hooks");
