// OpenVibe cades (deployable barricades) — ported from Devolved's Dev_SH.Cades.
// A flat registry of buyable props keyed by name; the loader auto-discovers
// js/cades/*.js (mirrors the scripted_ents / weapons loaders).
//
// Devolved shape: AddCade(Name, Model, HP, Cost, Level, Hidden)
//   -> Cades[Name] = { model, cost, hp, level, hidden }
(function () {
  if (globalThis.cades && globalThis.cades.__openvibe) return;

  var OV = globalThis.OV;
  var registry = Object.create(null); // name -> def

  var cades = {
    __openvibe: true,

    // Register a cade. Accepts a def object or positional args (Devolved style).
    Register: function (defOrName, model, hp, cost, level, hidden) {
      var def;
      if (defOrName && typeof defOrName === "object") {
        def = defOrName;
      } else {
        def = { name: defOrName, model: model, hp: hp, cost: cost, level: level, hidden: hidden };
      }
      def.name = String(def.name);
      def.model = String(def.model || "");
      def.hp = def.hp | 0 || 100;
      def.cost = def.cost | 0 || 0;
      def.level = def.level | 0 || 0;
      def.hidden = !!def.hidden;
      def.perPlayerMax = def.perPlayerMax != null ? def.perPlayerMax : 0; // 0 = use global cap
      registry[def.name] = def;
      return def;
    },

    Get: function (name) { return registry[String(name)] || null; },
    GetAll: function () { var out = []; for (var k in registry) out.push(registry[k]); return out; },
    // Buyable list for a player: not hidden (unless unlocked) and level met.
    ListFor: function (ply) {
      var lvl = (ply && ply.GetLevel) ? ply.GetLevel() : 0;
      var unlocked = (ply && ply._r && ply._r.cadesUnlocked) || {};
      return cades.GetAll().filter(function (c) {
        if (c.level > lvl) return false;
        if (c.hidden && !unlocked[c.name]) return false;
        return true;
      });
    },
    _registry: registry
  };

  // Per-player deploy caps (Devolved: 8 normal / 14 plat / 15 citizen; 1s cd).
  cades.GLOBAL_CAP = 8;
  cades.COOLDOWN = 1.0;

  globalThis.cades = cades;
  if (OV && OV.log) OV.log("cades library ready");
})();
