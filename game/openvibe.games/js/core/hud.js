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

    GetLayout: function () { return elements.slice(); },
    GetValues: function () { var out = {}; for (var k in values) out[k] = values[k]; return out; },

    // Serialisable snapshot the client pushes to the HTML overlay.
    Snapshot: function () { return { visible: visible, layout: elements.slice(), values: HUD.GetValues() }; },

    // Push to the page (client realm only). Uses the menu bridge like base HUD.
    Flush: function (force) {
      if (isServer) return false;
      if (!dirty && !force) return false;
      dirty = false;
      var snap = HUD.Snapshot();
      if (OV && typeof OV.menuJS === "function") {
        try {
          var json = JSON.stringify(snap).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
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
