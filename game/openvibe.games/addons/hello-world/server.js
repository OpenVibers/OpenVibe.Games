// server realm: use an npm module + register a chat command
var leftpad = require("ov-leftpad");
OV.log("hello-world server.js loaded; leftpad('7',3,'0')=" + leftpad("7", 3, "0"));
if (globalThis.command) {
  command.add("hello", "Addon demo command", function ({ ply, reply }) {
    reply(ply, "Hello from the JS addon system! padded=" + leftpad("42", 5, "0"));
    return false;
  });
}

// net library demo: receive a client->server message and log it.
if (globalThis.net) {
  net.Receive("HW_Ping", function (len, ply) {
    var who = ply ? ply.name() : "server-console";
    var text = net.ReadString();
    var n = net.ReadInt();
    OV.log("net RECV HW_Ping from " + who + " text=" + text + " n=" + n);
  });
  OV.log("hello-world registered net.Receive('HW_Ping')");
}
