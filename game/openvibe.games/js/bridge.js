import { hook } from "./core/hook.js";
import { gamemode } from "./core/gamemode.js";

globalThis.hook = hook;
globalThis.gamemode = gamemode;

globalThis.console = {
  log: (...args) => OV.log(args.map(String).join(" ")),
  warn: (...args) => OV.warn(args.map(String).join(" ")),
  error: (...args) => OV.error(args.map(String).join(" "))
};

globalThis.game = {
  mode: () => OV.getMode(),
  map: () => OV.getMapName(),
  time: () => OV.time(),
  log: (msg) => OV.log(String(msg)),
  broadcast: (msg) => OV.broadcast(String(msg)),
  runServerCommand: (cmd) => OV.serverCommand(String(cmd))
};

globalThis.round = {
  state: () => OV.roundState(),
  setState: (state) => OV.setRoundState(String(state)),
  start: () => OV.fireHook("RoundStart"),
  end: () => OV.fireHook("RoundEnd")
};

OV.log("[OpenVibe JS] bridge.js loaded");
