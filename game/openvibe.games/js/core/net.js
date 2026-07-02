// OpenVibe net library — GMod-style networking for the JS platform.
// https://wiki.facepunch.com/gmod/Net_Library_Usage
//
// Messages are composed with net.Start(name) + net.Write*(...) and sent with
// net.Send/Broadcast (server->client) or net.SendToServer (client->server).
// Receivers register net.Receive(name, fn) and read fields in the same order
// they were written.
//
// Transport: fields are collected as a typed list, serialized to JSON, and
// base64-encoded so the payload is a single transport-safe token. The C++
// bridge carries (name, payloadB64):
//   server->client : OV.netEmit(targets, name, payloadB64) -> usermessage
//   client->server : OV.netSendToServer(name, payloadB64) -> forwarded cmd
// Inbound messages arrive as the "OVNetReceive" hook fired from C++.
//
// NOTE: The client realm has no JS runtime yet, so net.Receive on the client
// is inert until the client JS runtime lands. Server-side receive (from
// client->server) and server-side send are fully live today.
(function () {
  if (globalThis.net && globalThis.net.__openvibe) return;

  var OV = globalThis.OV;
  var isServer = OV && OV.isServer ? OV.isServer() : true;

  // --- base64 over UTF-8 (QuickJS has no btoa/atob) ---
  var B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  function utf8Encode(str) {
    var out = [];
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) { out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f)); }
      else { out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f)); }
    }
    return out;
  }
  function utf8Decode(bytes) {
    var out = "", i = 0;
    while (i < bytes.length) {
      var c = bytes[i++];
      if (c < 0x80) out += String.fromCharCode(c);
      else if (c < 0xe0) out += String.fromCharCode(((c & 0x1f) << 6) | (bytes[i++] & 0x3f));
      else out += String.fromCharCode(((c & 0x0f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f));
    }
    return out;
  }
  function b64encode(str) {
    var bytes = utf8Encode(str), out = "";
    for (var i = 0; i < bytes.length; i += 3) {
      var b0 = bytes[i], b1 = bytes[i + 1], b2 = bytes[i + 2];
      out += B64[b0 >> 2];
      out += B64[((b0 & 3) << 4) | ((b1 === undefined ? 0 : b1) >> 4)];
      out += b1 === undefined ? "=" : B64[((b1 & 15) << 2) | ((b2 === undefined ? 0 : b2) >> 6)];
      out += b2 === undefined ? "=" : B64[b2 & 63];
    }
    return out;
  }
  function b64decode(str) {
    var bytes = [], i = 0;
    str = str.replace(/=+$/, "");
    while (i < str.length) {
      var e0 = B64.indexOf(str[i++]), e1 = B64.indexOf(str[i++]);
      var e2 = i < str.length ? B64.indexOf(str[i++]) : -1;
      var e3 = i < str.length ? B64.indexOf(str[i++]) : -1;
      bytes.push((e0 << 2) | (e1 >> 4));
      if (e2 !== -1) bytes.push(((e1 & 15) << 4) | (e2 >> 2));
      if (e3 !== -1) bytes.push(((e2 & 3) << 6) | e3);
    }
    return utf8Decode(bytes);
  }

  var networkStrings = Object.create(null); // parity with util.AddNetworkString
  var receivers = Object.create(null);      // name -> fn(len, ply)

  var writeBuf = null; // { name, fields: [{t,v}] }
  var readBuf = null;  // { fields, cursor }

  function push(t, v) {
    if (!writeBuf) { OV.warn("net.Write* called without net.Start"); return; }
    writeBuf.fields.push({ t: t, v: v });
  }
  function readNext(expectType) {
    if (!readBuf || readBuf.cursor >= readBuf.fields.length) return undefined;
    var f = readBuf.fields[readBuf.cursor++];
    return f ? f.v : undefined;
  }

  function serialize() {
    return b64encode(JSON.stringify({ n: writeBuf.name, f: writeBuf.fields }));
  }

  var net = {
    __openvibe: true,

    Start: function (name, unreliable) {
      writeBuf = { name: String(name), fields: [], unreliable: !!unreliable };
      return net;
    },

    // Writers (bits arg accepted for GMod parity; JSON keeps full precision).
    WriteInt: function (v, bits) { push("i", v | 0); return net; },
    WriteUInt: function (v, bits) { push("u", v >>> 0); return net; },
    WriteFloat: function (v) { push("f", Number(v)); return net; },
    WriteDouble: function (v) { push("f", Number(v)); return net; },
    WriteBool: function (v) { push("b", !!v); return net; },
    WriteString: function (v) { push("s", String(v)); return net; },
    WriteEntity: function (v) { push("e", v && v.entIndex ? v.entIndex() : (v | 0)); return net; },
    WriteTable: function (v) { push("t", v); return net; },
    WriteVector: function (v) { push("v", v); return net; },

    // Readers (call in the same order as written).
    ReadInt: function () { return readNext("i") | 0; },
    ReadUInt: function () { return readNext("u") >>> 0; },
    ReadFloat: function () { return Number(readNext("f")); },
    ReadDouble: function () { return Number(readNext("f")); },
    ReadBool: function () { return !!readNext("b"); },
    ReadString: function () { var v = readNext("s"); return v === undefined ? "" : String(v); },
    ReadEntity: function () { var id = readNext("e") | 0; return OV.playerByUserId ? OV.playerByUserId(id) : id; },
    ReadTable: function () { return readNext("t"); },
    ReadVector: function () { return readNext("v"); },

    Receive: function (name, fn) {
      if (typeof fn !== "function") throw new Error("net.Receive requires a function");
      receivers[String(name)] = fn;
    },

    // server -> client
    Send: function (target) {
      if (!writeBuf) return;
      if (!isServer) { OV.warn("net.Send is server-only; use SendToServer on the client"); return; }
      var ids = [];
      if (target == null) { ids = [-1]; }
      else if (Array.isArray(target)) { ids = target.map(function (p) { return p && p.userId ? p.userId() : (p | 0); }); }
      else { ids = [target && target.userId ? target.userId() : (target | 0)]; }
      var payload = serialize();
      if (OV.netEmit) OV.netEmit(JSON.stringify(ids), writeBuf.name, payload);
      writeBuf = null;
    },
    Broadcast: function () {
      if (!writeBuf) return;
      if (!isServer) { OV.warn("net.Broadcast is server-only"); return; }
      var payload = serialize();
      if (OV.netEmit) OV.netEmit(JSON.stringify([-1]), writeBuf.name, payload);
      writeBuf = null;
    },

    // client -> server
    SendToServer: function () {
      if (!writeBuf) return;
      var payload = serialize();
      if (OV.netSendToServer) OV.netSendToServer(writeBuf.name, payload);
      else OV.warn("net.SendToServer unavailable (no client bridge)");
      writeBuf = null;
    },

    // Called from the C++ "OVNetReceive" hook. ply is the sending player object
    // for client->server messages, or null (server->client / server console).
    _dispatch: function (name, payloadB64, ply) {
      var fn = receivers[String(name)];
      if (!fn) return;
      var decoded;
      try { decoded = JSON.parse(b64decode(payloadB64)); }
      catch (e) { OV.error("net: bad payload for " + name + ": " + (e && e.message)); return; }
      readBuf = { fields: (decoded && decoded.f) || [], cursor: 0 };
      try { fn(readBuf.fields.length, ply || null); }
      catch (e) { OV.error("net.Receive('" + name + "') threw: " + (e && e.message)); }
      readBuf = null;
    }
  };

  globalThis.net = net;

  // util.AddNetworkString parity (names also travel inline, so this is advisory).
  globalThis.util = globalThis.util || {};
  if (!globalThis.util.AddNetworkString) {
    globalThis.util.AddNetworkString = function (name) { networkStrings[String(name)] = true; return name; };
  }

  // Bridge C++ inbound -> JS. C++ fires "OVNetReceive" with (name, payloadB64, plyUserId).
  if (globalThis.hook && typeof hook.Add === "function") {
    hook.Add("OVNetReceive", "OpenVibeNetDispatch", function (name, payloadB64, ply) {
      net._dispatch(name, payloadB64, ply);
    });
  }

  if (OV && OV.log) OV.log("net library ready (realm=" + (isServer ? "server" : "client") + ")");
})();
