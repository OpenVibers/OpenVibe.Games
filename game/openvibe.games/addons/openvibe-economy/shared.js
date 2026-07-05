// OpenVibe economy — shared definitions (both realms). Devolved-inspired port.
// Net string names, the Devolved->HL2DM weapon class map (import provenance) and small helpers.
// The registry lives on globalThis.OVEconomy so server.js/client.js (and the
// test harness) share one object across require() boundaries.
(function () {
  var OV = globalThis.OV;

  // ---- net message names (pooled server-side in server.js) ----
  var NET_STATE = "OVEcon_State";       // server->client: economy snapshot table
  var NET_REFRESH = "OVEcon_Refresh";   // client->server: request a re-fetch+push
  var NET_CADE_BUY = "OVEcon_CadeBuy";  // client->server: buy/place a cade by name

  // ---- Devolved weapon class -> HL2DM C++ weapon class ----
  // Weapons on this platform are the stock HL2DM C++ set (weapons are 0% JS),
  // so Devolved perma classes map onto the closest HL2DM equivalent.
  // Data-driven: extend this table as more Devolved content is ported.
  var CLASS_MAP = {
    // rifles -> AR2
    weapon_ttt_ak47: "weapon_ar2",
    weapon_tttgo_ak47: "weapon_ar2",
    weapon_ttt_m16: "weapon_ar2",
    weapon_tttgo_m4a4: "weapon_ar2",
    weapon_ttt_famas: "weapon_ar2",
    weapon_ttt_galil: "weapon_ar2",
    weapon_ttt_aug: "weapon_ar2",
    weapon_ttt_sg552: "weapon_ar2",
    weapon_ttt_halo_ma5b: "weapon_ar2",
    // SMGs -> SMG1
    weapon_ttt_mp5: "weapon_smg1",
    weapon_ttt_p90: "weapon_smg1",
    weapon_zm_mac10: "weapon_smg1",
    weapon_tttgo_mp7: "weapon_smg1",
    weapon_tttgo_mp9: "weapon_smg1",
    weapon_tttgo_tec9: "weapon_smg1",
    weapon_ttt_hug_tommy: "weapon_smg1",
    // snipers / scoped -> crossbow
    weapon_tttgo_awp: "weapon_crossbow",
    weapon_ttt_halo_srs99: "weapon_crossbow",
    weapon_ttt_hug_dsr: "weapon_crossbow",
    weapon_zm_rifle: "weapon_crossbow",
    weapon_ttt_halo_dmr: "weapon_crossbow",
    // shotguns -> shotgun
    weapon_zm_shotgun: "weapon_shotgun",
    weapon_zm_m3: "weapon_shotgun",
    weapon_ttt_haji_shotgun: "weapon_shotgun",
    // heavy pistols / revolvers -> 357
    weapon_zm_revolver: "weapon_357",
    weapon_zm_revolverg: "weapon_357",
    weapon_spec_deagle: "weapon_357",
    weapon_ttt_halo_m6d: "weapon_357",
    // pistols -> pistol
    weapon_ttt_glock: "weapon_pistol",
    weapon_tttgo_glock: "weapon_pistol",
    weapon_ttt_p228: "weapon_pistol",
    weapon_ttt_elites: "weapon_pistol",
    weapon_spec_m1911: "weapon_pistol",
    weapon_fc3_1911: "weapon_pistol",
    weapon_ttt_haji_rglock: "weapon_pistol",
    // melee -> crowbar / stunstick
    weapon_zm_improvised: "weapon_crowbar",
    weapon_zm_sledge: "weapon_crowbar",
    weapon_ttt_hammer: "weapon_stunstick",
    // grenades -> frag
    weapon_ttt_confgrenade: "weapon_frag",
    weapon_ttt_smokegrenade: "weapon_frag",
    weapon_zm_molotov: "weapon_frag"
  };

  // Prefix fallbacks for class families with many variants (e.g. the dozens of
  // weapon_zm_improvised_* knife reskins). Checked after the exact map.
  var PREFIX_RULES = [
    ["weapon_zm_improvised", "weapon_crowbar"],
    ["weapon_spec_", "weapon_ar2"],
    ["weapon_fc3_", "weapon_smg1"]
  ];

  // Map a Devolved weapon class to an HL2DM class, or null when unmapped.
  function mapWeaponClass(cls) {
    if (!cls) return null;
    cls = String(cls).toLowerCase();
    if (CLASS_MAP[cls]) return CLASS_MAP[cls];
    for (var i = 0; i < PREFIX_RULES.length; i++) {
      if (cls.indexOf(PREFIX_RULES[i][0]) === 0) return PREFIX_RULES[i][1];
    }
    return null;
  }

  var OVEconomy = globalThis.OVEconomy || {};
  OVEconomy.NET_STATE = NET_STATE;
  OVEconomy.NET_REFRESH = NET_REFRESH;
  OVEconomy.NET_CADE_BUY = NET_CADE_BUY;
  OVEconomy.CLASS_MAP = CLASS_MAP;
  OVEconomy.PREFIX_RULES = PREFIX_RULES;
  OVEconomy.MapWeaponClass = mapWeaponClass;
  // Devolved cade caps: 8 normal / 14 plat / 15 citizen; the js/core/cades.js
  // GLOBAL_CAP (8) is the default; def.perPlayerMax overrides per cade.
  OVEconomy.CADE_CAP = 8;
  OVEconomy.CADE_CAP_MAX = 15;
  OVEconomy.state = OVEconomy.state || null; // client realm: last synced snapshot

  globalThis.OVEconomy = OVEconomy;
  if (typeof module !== "undefined" && module && module.exports) module.exports = OVEconomy;
  if (OV && OV.log) OV.log("[ov-econ] shared loaded (" + Object.keys(CLASS_MAP).length + " mapped classes)");
})();
