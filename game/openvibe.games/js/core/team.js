// OpenVibe team library — GMod team semantics.
// https://wiki.facepunch.com/gmod/team
(function () {
  if (globalThis.team && globalThis.team.__openvibe) return;

  var teams = Object.create(null); // id -> {name, color, score, joinable}

  function players() {
    return globalThis.player && player.GetAll ? player.GetAll() : (globalThis.OV && OV.players ? OV.players() : []);
  }
  function teamOf(p) {
    if (!p) return 0;
    if (typeof p.Team === "function") return p.Team() | 0;
    if (typeof p.team === "function") return p.team() | 0;
    return 0;
  }

  globalThis.team = {
    __openvibe: true,

    SetUp: function (id, name, color, joinable) {
      id = id | 0;
      teams[id] = {
        name: String(name),
        color: color || (globalThis.Color ? Color(255, 255, 255) : { r: 255, g: 255, b: 255, a: 255 }),
        score: teams[id] ? teams[id].score : 0,
        joinable: joinable !== false
      };
      return id;
    },
    Valid: function (id) { return !!teams[id | 0]; },
    GetName: function (id) { var t = teams[id | 0]; return t ? t.name : "Unassigned"; },
    GetColor: function (id) { var t = teams[id | 0]; return t ? t.color : { r: 255, g: 255, b: 255, a: 255 }; },
    GetScore: function (id) { var t = teams[id | 0]; return t ? t.score : 0; },
    SetScore: function (id, score) { var t = teams[id | 0]; if (t) t.score = score | 0; },
    AddScore: function (id, amount) { var t = teams[id | 0]; if (t) t.score += amount | 0; },
    GetPlayers: function (id) {
      id = id | 0;
      return players().filter(function (p) { return teamOf(p) === id; });
    },
    NumPlayers: function (id) { return this.GetPlayers(id).length; },
    GetAllTeams: function () {
      var out = {};
      for (var id in teams) out[id] = teams[id];
      return out;
    }
  };

  if (globalThis.OV && OV.log) OV.log("team library ready");
})();
