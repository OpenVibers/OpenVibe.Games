// OpenVibe Sandbox — client realm.
// The spawn menu is served by the server realm (server.js) and shown via chat.
// The actual "press Q" binding is installed from the client cfg
// (openvibe_proton_client.cfg: bind q "say !q"), which routes to the server's
// !q command through the PlayerSay hook. This file just marks the realm loaded.
console.log("OpenVibe Sandbox client realm loaded — press Q for the spawn menu.");
