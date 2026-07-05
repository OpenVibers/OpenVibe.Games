// OpenVibe HUD / GUI library — lets a gamemode code its in-game GUI in JS.
// https://wiki.facepunch.com/gmod/GM:HUDPaint (declarative variant)
//
// A gamemode declares HUD elements in JS (HUD.Add / a HUDLayout hook); the
// client serialises the layout + live values and pushes them to the HTML HUD
// overlay (window.OV.onHudLayout / onHudState), which renders them generically.
// No layout is hard-coded in the page — each gamemode owns its GUI.
(function () {
  if (globalThis.HUD && globalThis.HUD.__openvibe) return;

  var OV = globalThis.OV;
  var isServer = OV && OV.isServer ? !!OV.isServer() : true;

  var elements = [];        // ordered element specs
  var byId = Object.create(null);
  var values = Object.create(null);
  var dirty = false;
  var visible = true;
  var hiddenById = Object.create(null); // HUD.SetElementVisible(id, false)

  // Stock (engine C++) HUD element names, GMod GM:HUDShouldDraw parity.
  // Returning false from a HUDShouldDraw hook for one of the health/suit trio
  // maps onto the coarse `ov_hud_stock` client convar (see syncStockHud below).
  // The other stock elements have no convar control yet — documented limitation.
  var STOCK_ELEMENTS = [
    "CHudHealth", "CHudBattery", "CHudSuitPower",
    "CHudAmmo", "CHudCrosshair", "CHudChat", "CHudWeaponSelection"
  ];
  var STOCK_CONVAR_GROUP = ["CHudHealth", "CHudBattery", "CHudSuitPower"];
  var stockHiddenLast = null; // null = never touched the convar

  // GM:HUDShouldDraw — a registered hook (or gamemode method) returning false
  // for an element id hides it from the pushed snapshot. Server truth untouched.
  function allowedByHooks(id) {
    if (!globalThis.hook || typeof hook.Run !== "function") return true;
    var v;
    try { v = hook.Run("HUDShouldDraw", String(id)); } catch (e) { return true; }
    return v !== false;
  }

  function visibleElements() {
    return elements.filter(function (el) {
      return hiddenById[el.id] !== true && allowedByHooks(el.id);
    });
  }

  // Map HUDShouldDraw verdicts for the stock health/suit trio onto the
  // `ov_hud_stock` convar. The convar defaults to 0 (stock HUD hidden, the JS
  // HUD replaces it), so we only start pushing after a hook first hides one —
  // a gamemode with no HUDShouldDraw opinion never touches the convar.
  // Client concmd path: OV.clientCommand when the bridge grows one (TODO in
  // ov-runtime.js buildOV); today the client-realm OV.serverCommand routes
  // {t:'concmd'} to the attached client DLL (ClientCmd_Unrestricted), which is
  // exactly a client console command.
  function syncStockHud() {
    if (isServer) return;
    var hide = false;
    for (var i = 0; i < STOCK_CONVAR_GROUP.length; i++) {
      if (!allowedByHooks(STOCK_CONVAR_GROUP[i])) { hide = true; break; }
    }
    if (hide === stockHiddenLast) return;
    if (!hide && stockHiddenLast === null) { stockHiddenLast = false; return; }
    stockHiddenLast = hide;
    var send = OV && typeof OV.clientCommand === "function" ? OV.clientCommand
             : OV && typeof OV.serverCommand === "function" ? OV.serverCommand : null;
    if (send) { try { send("ov_hud_stock " + (hide ? "0" : "1")); } catch (e) { /* best-effort */ } }
  }

  // Element spec: { id, type, anchor, x, y, bind, text, color, size, max, ... }
  // type: 'text' | 'bar' | 'timer' | 'counter' | 'icon' | 'panel' | 'list'
  function normalize(spec) {
    spec = spec || {};
    return {
      id: String(spec.id || ("el_" + elements.length)),
      type: String(spec.type || "text"),
      anchor: spec.anchor || "top",         // top|top-left|top-right|center|bottom|bottom-left|bottom-right
      x: +spec.x || 0, y: +spec.y || 0,
      bind: spec.bind != null ? String(spec.bind) : null, // value key
      text: spec.text != null ? String(spec.text) : "",
      color: spec.color || null,
      size: spec.size != null ? +spec.size : null,
      max: spec.max != null ? +spec.max : null,
      icon: spec.icon != null ? String(spec.icon) : null,
      hideWhenEmpty: !!spec.hideWhenEmpty
    };
  }

  var HUD = {
    __openvibe: true,

    // Declare an element. Returns the element id.
    Add: function (spec) {
      var el = normalize(spec);
      if (byId[el.id]) { // replace in place (redeclare on hot-reload)
        var idx = elements.indexOf(byId[el.id]);
        elements[idx] = el;
      } else {
        elements.push(el);
      }
      byId[el.id] = el;
      dirty = true;
      return el.id;
    },

    // Replace the whole layout at once (a gamemode's GUI definition).
    SetLayout: function (specs) {
      elements = []; byId = Object.create(null);
      (specs || []).forEach(function (s) { HUD.Add(s); });
      dirty = true;
      return HUD;
    },

    Remove: function (id) {
      id = String(id);
      if (byId[id]) { elements.splice(elements.indexOf(byId[id]), 1); delete byId[id]; dirty = true; }
    },

    // Update a live bound value (client-side).
    Set: function (key, val) { if (values[key] !== val) { values[key] = val; dirty = true; } },
    SetMany: function (obj) { if (obj) for (var k in obj) HUD.Set(k, obj[k]); },
    Get: function (key) { return values[key]; },

    Show: function () { visible = true; dirty = true; },
    Hide: function () { visible = false; dirty = true; },
    IsVisible: function () { return visible; },

    // Per-element visibility (script-driven; combined with HUDShouldDraw).
    SetElementVisible: function (id, vis) {
      id = String(id);
      if (vis === false) hiddenById[id] = true;
      else delete hiddenById[id];
      dirty = true;
    },
    GetElementVisible: function (id) { return hiddenById[String(id)] !== true; },

    // Well-known stock engine HUD element names (GM:HUDShouldDraw targets).
    STOCK_ELEMENTS: STOCK_ELEMENTS,

    GetLayout: function () { return elements.slice(); },
    GetValues: function () { var out = {}; for (var k in values) out[k] = values[k]; return out; },

    // Serialisable snapshot the client pushes to the HTML overlay.
    // HUDShouldDraw + SetElementVisible filtering applies here (GetLayout is
    // the unfiltered declaration list).
    Snapshot: function () { return { visible: visible, layout: visibleElements(), values: HUD.GetValues() }; },

    // Wire-compact snapshot: identical shape but null/false/empty fields are
    // omitted so the push usually fits in one <512-char console command
    // (the page treats missing keys as their defaults).
    CompactSnapshot: function () {
      var layout = visibleElements().map(function (el) {
        var out = { id: el.id, type: el.type, anchor: el.anchor, x: el.x, y: el.y };
        if (el.bind != null) out.bind = el.bind;
        if (el.text) out.text = el.text;
        if (el.color) out.color = el.color;
        if (el.size != null) out.size = el.size;
        if (el.max != null) out.max = el.max;
        if (el.icon != null) out.icon = el.icon;
        if (el.hideWhenEmpty) out.hideWhenEmpty = true;
        return out;
      });
      return { visible: visible, layout: layout, values: HUD.GetValues() };
    },

    // Push to the page (client realm only). Uses the menu bridge like base HUD.
    Flush: function (force) {
      if (isServer) return false;
      syncStockHud(); // stock-element HUDShouldDraw verdicts -> ov_hud_stock
      if (!dirty && !force) return false;
      dirty = false;
      var snap = HUD.Snapshot();
      if (OV && typeof OV.menuJS === "function") {
        try {
          var json = JSON.stringify(HUD.CompactSnapshot()).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
          OV.menuJS('window.OV&&OV.onHudLayout&&OV.onHudLayout(JSON.parse("' + json + '"))');
        } catch (e) { /* best-effort */ }
      }
      if (globalThis.hook) { try { hook.Run("OVHudLayout", snap); } catch (e) {} }
      return true;
    }
  };

  // Client: flush the HUD to the page on the Tick/Think hook when dirty.
  if (!isServer && globalThis.hook && typeof hook.Add === "function") {
    hook.Add("Think", "OpenVibeHUDFlush", function () { HUD.Flush(false); return undefined; });
  }

  globalThis.HUD = HUD;
  if (OV && OV.log) OV.log("HUD library ready (realm=" + (isServer ? "server" : "client") + ")");
})();
