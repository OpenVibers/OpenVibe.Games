// js/autorun/server/ — server realm only (GMod lua/autorun/server).
// Greets players as they spawn, like the classic GMod beginner tutorial.
hook.Add("PlayerInitialSpawn", "ExampleAutorunGreet", function (ply) {
  if (ply && typeof ply.chat === "function") {
    ply.chat("Welcome! This greeting comes from js/autorun/server/example_server_hello.js");
  }
});
print("[example] autorun/server ran");
