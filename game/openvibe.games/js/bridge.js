OV.log("bridge.js loaded");

globalThis.console = {
  log: (...args) => OV.log(args.map(String).join(" ")),
  warn: (...args) => OV.warn(args.map(String).join(" ")),
  error: (...args) => OV.error(args.map(String).join(" "))
};

globalThis.game = {
  mode: () => OV.getMode(),
  map: () => OV.getMapName(),
  time: () => OV.time(),
  broadcast: (msg) => OV.broadcast(String(msg)),
  serverCommand: (cmd) => OV.serverCommand(String(cmd))
};

globalThis.round = {
  start: () => OV.fireHook("RoundStart"),
  end: () => OV.fireHook("RoundEnd")
};
