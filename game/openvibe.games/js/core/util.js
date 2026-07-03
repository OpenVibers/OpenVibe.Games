// OpenVibe util library — network string pooling + helpers.
// https://wiki.facepunch.com/gmod/util.AddNetworkString
(function () {
  if (globalThis.util && globalThis.util.__openvibe) return;

  var OV = globalThis.OV;
  var isServer = OV && OV.isServer ? !!OV.isServer() : true;

  // Pooled network strings: name -> id. GMod's table has 4095 usable slots.
  var MAX_STRINGS = 4095;
  var names = Object.create(null);
  var ids = [null]; // id 0 reserved (NULL)

  function addNetworkString(name) {
    name = String(name);
    if (names[name] !== undefined) return names[name];
    if (!isServer) {
      // Clients cannot pool. GMod silently only lets the server pool; we track
      // locally so client Start() of a known name still works after sync.
    }
    if (ids.length > MAX_STRINGS) {
      if (OV && OV.warn) OV.warn("util.AddNetworkString: networkstring table is full, can't add " + name);
      return 0;
    }
    var id = ids.length;
    ids.push(name);
    names[name] = id;
    return id;
  }

  function networkStringToID(name) {
    var id = names[String(name)];
    return id === undefined ? 0 : id;
  }

  function networkIDToString(id) {
    return ids[id | 0] || undefined;
  }

  // FNV-1a 32-bit — stable content hash usable in both QuickJS and Node,
  // used by the file-sync manifest (not cryptographic).
  function fnv1a(str) {
    str = String(str);
    var h = 0x811c9dc5;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i) & 0xff;
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return ("0000000" + h.toString(16)).slice(-8);
  }

  var util = globalThis.util || {};
  util.__openvibe = true;
  util.AddNetworkString = addNetworkString;
  util.NetworkStringToID = networkStringToID;
  util.NetworkIDToString = networkIDToString;
  util.CRC = fnv1a;
  util.TableToJSON = function (t, pretty) { return JSON.stringify(t, null, pretty ? 2 : 0); };
  util.JSONToTable = function (s) { try { return JSON.parse(String(s)); } catch { return null; } };
  util.IsValid = function (o) { return globalThis.IsValid ? IsValid(o) : o != null; };

  globalThis.util = util;

  // Shared pooled-name access for net.js.
  util.__netNames = names;
  util.__netIds = ids;
})();
