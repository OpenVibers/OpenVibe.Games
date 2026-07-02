// OpenVibe Sandbox — shared realm.
// The spawn catalog lives here so both the server (which does the actual
// spawning) and the client (which can render the Q menu) agree on the exact
// same categories and prop ids without duplicating the list.
(function () {
  // Every prop id here must be allowlisted by the C++ ov_fortwars_spawn command,
  // which is what actually creates the prop_physics entity server-side.
  const SPAWN_CATALOG = [
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

  // Flatten to a quick id -> label lookup for validation / menu numbering.
  const byId = Object.create(null);
  const flat = [];
  SPAWN_CATALOG.forEach(function (cat) {
    cat.items.forEach(function (item) {
      byId[item.id] = item;
      flat.push(item);
    });
  });

  globalThis.OVSandbox = {
    SPAWN_CATALOG: SPAWN_CATALOG,
    spawnItems: flat,
    isSpawnable: function (id) { return !!byId[String(id || "").toLowerCase()]; },
    labelFor: function (id) {
      const item = byId[String(id || "").toLowerCase()];
      return item ? item.label : id;
    }
  };
})();
