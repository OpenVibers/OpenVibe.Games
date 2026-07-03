// OpenVibe Sandbox — server realm.
//
// Free-build sandbox mode with a GMod-style Q menu (spawn menu) implemented
// entirely in the JS engine. There are no rounds: props can be spawned at any
// time. The Q menu is a chat/console-driven spawn menu because the JS runtime
// runs server-side; a keybind (bind q "ov_qmenu") forwards to the server which
// prints the menu to the requesting player.
(function () {
  // The shared realm isn't auto-loaded by the C++ core loader (only
  // base/server.js + <mode>/server.js are), so pull the catalog in defensively:
  // if OVSandbox isn't defined yet, define a minimal fallback matching shared.js.
  const catalog = (globalThis.OVSandbox && globalThis.OVSandbox.SPAWN_CATALOG) || [
    {
      category: "Build Props",
      items: [
        { id: "crate",  label: "Wooden Crate" },
        { id: "barrel", label: "Oil Drum" },
        { id: "pallet", label: "Wood Pallet" },
        { id: "fence",  label: "Wood Fence" },
        { id: "sheet",  label: "Mattress" }
      ]
    }
  ];

  const spawnable = Object.create(null);
  const numbered = [];
  catalog.forEach(function (cat) {
    cat.items.forEach(function (item) {
      spawnable[item.id] = item.label;
      numbered.push(item);
    });
  });

  function ensureBuildEnabled() {
    // ov_fortwars_spawn is gated behind this convar; sandbox keeps it on always.
    OV.serverCommand("ov_fortwars_build_enabled 1");
  }

  function spawnProp(ply, id) {
    const key = String(id || "").toLowerCase();
    if (!spawnable[key]) {
      if (ply) ply.chat(`Can't spawn "${id}". Type !q for the spawn menu.`);
      return false;
    }
    if (!ply) return false;
    ensureBuildEnabled();
    ply.runCommand(`ov_fortwars_spawn ${key}`);
    ply.chat(`Spawned: ${spawnable[key]}`);
    return true;
  }

  // Render the Q menu to a single player as chat lines. Numbered so a player can
  // spawn by number (!1) or by id (!spawn crate).
  function openQMenu(ply) {
    if (!ply) return;
    ply.chat("=== OpenVibe Q Menu — Spawn ===");
    let n = 0;
    catalog.forEach(function (cat) {
      ply.chat(`- ${cat.category} -`);
      cat.items.forEach(function (item) {
        n += 1;
        ply.chat(`  ${n}. ${item.label}   (!spawn ${item.id}  or  !${n})`);
      });
    });
    ply.chat("Spawn appears where you're looking.");
  }

  function registerCommands() {
    if (!globalThis.command) return;

    // Q menu open — chat (!q / !qmenu) and console (ov_qmenu via ConsoleCommand hook).
    command.add("q", "Open the sandbox spawn (Q) menu", function ({ ply }) {
      openQMenu(ply);
      return false;
    });
    command.add("qmenu", "Open the sandbox spawn (Q) menu", function ({ ply }) {
      openQMenu(ply);
      return false;
    });

    // Spawn by id: !spawn crate
    command.add("spawn", "Spawn a prop: !spawn <crate|barrel|pallet|fence|sheet>", function ({ ply, args }) {
      spawnProp(ply, args[0] || "crate");
      return false;
    });

    // Spawn by menu number: !1 .. !N
    numbered.forEach(function (item, idx) {
      const num = String(idx + 1);
      command.add(num, `Spawn ${item.label}`, function ({ ply }) {
        spawnProp(ply, item.id);
        return false;
      });
    });

    // Entity-system spawn: !ent <class> — demonstrates ents.Create end to end
    // (scripted entities like ov_bouncy_crate, or allowlisted engine classes
    // when the native entity bridge is compiled in).
    command.add("ent", "Spawn an entity: !ent ov_bouncy_crate", function ({ ply, args, reply }) {
      const cls = String(args[0] || "ov_bouncy_crate");
      const ent = ents.Create(cls);
      if (!IsValid(ent)) {
        reply(ply, `Unknown entity class: ${cls}`);
        return false;
      }
      if (ply) {
        const p = ply.GetPos ? ply.GetPos() : { x: 0, y: 0, z: 0 };
        const fwd = ply.GetForward ? ply.GetForward() : { x: 1, y: 0, z: 0 };
        ent.SetPos({ x: p.x + fwd.x * 96, y: p.y + fwd.y * 96, z: p.z + 32 });
      }
      ent.Spawn();
      ent.Activate();
      reply(ply, `Spawned ${cls} (entindex ${ent.EntIndex()})`);
      return false;
    });

    command.add("ents", "Count live entities", function ({ ply, reply }) {
      reply(ply, `Entities: ${ents.GetCount()} (${ents.FindByClass("ov_*").length} scripted ov_*)`);
      return false;
    });
  }

  // Networked Q-menu spawn: the client sends the chosen prop via the net
  // library (ov_net OV_Sandbox_Spawn <payload>). spawnProp already validates
  // the prop id against the allowlist, so we never trust the client's value.
  // Pool at file scope (GMod convention: before any net.Start can run).
  if (globalThis.util && util.AddNetworkString) {
    util.AddNetworkString("OV_Sandbox_Spawn");
    util.AddNetworkString("OV_Sandbox_Welcome");
  }

  function registerNet() {
    if (!globalThis.net) return;
    net.Receive("OV_Sandbox_Spawn", function (len, ply) {
      var id = net.ReadString();
      if (!ply) { OV.warn("OV_Sandbox_Spawn with no player; ignoring"); return; }
      spawnProp(ply, id);
    });
    OV.log("sandbox: net.Receive('OV_Sandbox_Spawn') ready");
  }

  const GM = {
    mode: "sandbox",
    name: "OpenVibe Sandbox",

    Initialize() {
      OV.log("Sandbox Initialize fired");
      registerCommands();
      registerNet();
      ensureBuildEnabled();
    },

    MapInitialize(mapName) {
      OV.log(`Sandbox MapInitialize: ${mapName}`);
      ensureBuildEnabled();
      // Sandbox has no rounds — deliberately do NOT call scheduleRoundStart().
    },

    // No rounds in sandbox: neutralize the base round scheduler entirely.
    scheduleRoundStart() {},
    startRound() {},
    endRound() {},

    PlayerInitialSpawn(ply) {
      ply.chat("Welcome to OpenVibe Sandbox! Press Q (or type !q) for the spawn menu.");
      // server -> client net: push a welcome the client JS receives & logs.
      if (globalThis.net && ply) {
        net.Start("OV_Sandbox_Welcome");
        net.WriteString("Hello " + ply.name() + " from the server via net.Send!");
        net.Send(ply);
      }
    },

    PlayerSpawn(ply) {
      ensureBuildEnabled();
      if (ply) ply.chat("Sandbox: !q spawn menu · !spawn crate");
    },

    Think() {}
  };

  gamemode.set(GM);
})();
