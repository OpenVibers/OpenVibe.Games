// server realm: use an npm module + register a chat command
var leftpad = require("ov-leftpad");
OV.log("hello-world server.js loaded; leftpad('7',3,'0')=" + leftpad("7", 3, "0"));
if (globalThis.command) {
  command.add("hello", "Addon demo command", function ({ ply, reply }) {
    reply(ply, "Hello from the JS addon system! padded=" + leftpad("42", 5, "0"));
    return false;
  });
}
