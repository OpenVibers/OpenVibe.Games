import fs from "node:fs";
import vm from "node:vm";

let fakeTime = 0;
const messages = [];

function player() {
  return {
    userId: 1,
    entIndex: 1,
    steamId: () => "STEAM_0:1:1",
    name: () => "SmokePlayer",
    health: () => 87,
    setHealth: () => undefined,
    chat: (msg) => messages.push(`[chat] ${msg}`),
    team: () => 0,
    setTeam: () => undefined,
    runCommand: (cmd) => messages.push(`[runCommand] ${cmd}`)
  };
}

const context = vm.createContext({
  console,
  globalThis: {},
  OV: {
    log: (msg) => messages.push(`[log] ${msg}`),
    warn: (msg) => messages.push(`[warn] ${msg}`),
    error: (msg) => messages.push(`[error] ${msg}`),
    getMode: () => "hub",
    getMapName: () => "ov_hub",
    time: () => fakeTime,
    broadcast: (msg) => messages.push(`[broadcast] ${msg}`),
    players: () => [player()],
    playerByUserId: () => player(),
    serverCommand: (cmd) => messages.push(`[serverCommand] ${cmd}`),
    reward: () => undefined,
    endMatch: () => undefined
  }
});
context.globalThis = context;

const files = [
  "game/openvibe.games/js/core/hook.js",
  "game/openvibe.games/js/core/gamemode.js",
  "game/openvibe.games/js/bridge.js",
  "game/openvibe.games/js/core/command.js",
  "game/openvibe.games/js/core/timer.js",
  "game/openvibe.games/js/gamemodes/base/server.js",
  "game/openvibe.games/js/gamemodes/hub/server.js"
];

for (const file of files) {
  const code = fs.readFileSync(file, "utf8");
  vm.runInContext(code, context, { filename: file });
}

context.gamemode.call("Initialize");
context.gamemode.call("MapInitialize", "ov_hub");
context.gamemode.call("PlayerInitialSpawn", player());

const blocked = context.gamemode.call("PlayerSay", player(), "!js");
if (blocked !== false) throw new Error("!js did not block default chat");

context.gamemode.call("ConsoleCommand", "smoke");
context.gamemode.call("ConsoleCommand", "hub_status");
context.gamemode.call("ConsoleCommand", "timer_smoke");
fakeTime += 1;
context.gamemode.call("Think");

if (!messages.some((line) => line.includes("JavaScript hooks are working"))) throw new Error("missing !js response");
if (!messages.some((line) => line.includes("OpenVibe embedded JS smoke test passed"))) throw new Error("missing smoke response");
if (!messages.some((line) => line.includes("OpenVibe JS timer smoke fired"))) throw new Error("missing timer smoke response");

console.log(messages.join("\n"));
console.log("[openvibe-smoke] JS command/timer smoke passed");
