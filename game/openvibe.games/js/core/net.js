// OpenVibe net library — GMod net semantics for the JS platform.
// https://wiki.facepunch.com/gmod/Net_Library_Usage
//
// Faithful behaviors:
//   - util.AddNetworkString pooling required server-side before net.Start
//   - one implicit write buffer; Start resets it; Abort discards
//   - receiver names are case-insensitive; ONE handler per name
//   - server receivers get (len, ply) with the authoritative sender
//   - 64KB payload cap; read-past-end returns type defaults
//   - per-player per-message rate limiting (net.SetRateLimit)
//
// Transport: fields are collected as a typed list, serialized to JSON and
// base64-encoded. The C++ bridge carries (name, payloadB64):
//   server->client : OV.netEmit(targetsCsv, name, payloadB64) -> "OVNet" usermessage
//   client->server : OV.netSendToServer(name, payloadB64)      -> "ov_net" command
// Source usermessages cap at ~255 bytes, so payloads are chunked over the
// reserved "__ovchunk" message and reassembled before dispatch.
// Inbound messages arrive as the "OVNetReceive" hook fired from the bridge.
(function () {
  if (globalThis.net && globalThis.net.__openvibe) return;

  var OV = globalThis.OV;
  var isServer = OV && OV.isServer ? !!OV.isServer() : true;

  var MAX_PAYLOAD_BYTES = 65533;   // GMod per-message cap
  var CHUNK_SIZE = 180;            // base64 chars per usermessage-safe chunk

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
    str = String(str).replace(/=+$/, "");
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

  function warn(m) { if (OV && OV.warn) OV.warn("net: " + m); }
  function error(m) { if (OV && OV.error) OV.error("net: " + m); }

  var receivers = Object.create(null); // lowercase name -> fn(len, ply)
  var writeBuf = null;                 // { name, fields: [{t,v}], unreliable }
  var readBuf = null;                  // { fields, cursor }

  // --- rate limiting (server inbound) ---
  var rateLimits = Object.create(null); // lowercase name -> per-second cap
  var DEFAULT_RATE = 30;
  var rateState = Object.create(null);  // "name:userId" -> {sec, count}
  function rateOk(name, ply) {
    if (!isServer || !ply || typeof ply.userId !== "function") return true;
    var cap = rateLimits[name] !== undefined ? rateLimits[name] : DEFAULT_RATE;
    if (cap <= 0) return true;
    var now = Math.floor((OV && OV.time ? OV.time() : 0));
    var key = name + ":" + ply.userId();
    var st = rateState[key];
    if (!st || st.sec !== now) { rateState[key] = { sec: now, count: 1 }; return true; }
    st.count++;
    return st.count <= cap;
  }

  function pooled(name) {
    return globalThis.util && util.NetworkStringToID ? util.NetworkStringToID(name) !== 0 : true;
  }

  function push(t, v) {
    if (!writeBuf) { warn("net.Write* called without net.Start"); return; }
    writeBuf.fields.push({ t: t, v: v });
  }
  function readNext() {
    if (!readBuf || readBuf.cursor >= readBuf.fields.length) return undefined;
    var f = readBuf.fields[readBuf.cursor++];
    return f ? f.v : undefined;
  }

  function serialize() {
    var payload = b64encode(JSON.stringify({ n: writeBuf.name, f: writeBuf.fields, u: writeBuf.unreliable ? 1 : 0 }));
    if (payload.length > MAX_PAYLOAD_BYTES) {
      error("message '" + writeBuf.name + "' exceeds 64KB payload cap (" + payload.length + " bytes) — dropped");
      return null;
    }
    return payload;
  }

  // --- chunked outbound (server->client path over 255-byte usermessages) ---
  var chunkSeq = 0;
  function emitChunked(idsCsv, name, payload) {
    if (!OV || !OV.netEmit) { warn("no netEmit bridge"); return; }
    if (payload.length <= CHUNK_SIZE) { OV.netEmit(idsCsv, name, payload); return; }
    var msgId = String(++chunkSeq);
    var total = Math.ceil(payload.length / CHUNK_SIZE);
    for (var i = 0; i < total; i++) {
      var part = payload.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
      // header "msgId:seq:total:name|" + data — single transport-safe token
      OV.netEmit(idsCsv, "__ovchunk", b64encode(msgId + ":" + i + ":" + total + ":" + name) + "|" + part);
    }
  }
  function sendToServerChunked(name, payload) {
    if (!OV || !OV.netSendToServer) { warn("net.SendToServer unavailable (no client bridge)"); return; }
    if (payload.length <= CHUNK_SIZE) { OV.netSendToServer(name, payload); return; }
    var msgId = String(++chunkSeq);
    var total = Math.ceil(payload.length / CHUNK_SIZE);
    for (var i = 0; i < total; i++) {
      var part = payload.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
      OV.netSendToServer("__ovchunk", b64encode(msgId + ":" + i + ":" + total + ":" + name) + "|" + part);
    }
  }

  // --- chunk reassembly (both realms) ---
  var assembling = Object.create(null); // "senderKey:msgId" -> {total, parts[], got, name}
  function onChunk(payloadB64, ply) {
    var bar = payloadB64.indexOf("|");
    if (bar < 0) return null;
    var header;
    try { header = b64decode(payloadB64.slice(0, bar)); } catch { return null; }
    var m = /^([^:]+):(\d+):(\d+):(.*)$/.exec(header);
    if (!m) return null;
    var senderKey = ply && typeof ply.userId === "function" ? String(ply.userId()) : "s";
    var key = senderKey + ":" + m[1];
    var seq = m[2] | 0, total = m[3] | 0, name = m[4];
    if (total < 1 || total > 4096 || seq >= total) return null;
    var st = assembling[key];
    if (!st) st = assembling[key] = { total: total, parts: [], got: 0, name: name };
    if (st.parts[seq] === undefined) { st.parts[seq] = payloadB64.slice(bar + 1); st.got++; }
    if (st.got < st.total) return null;
    delete assembling[key];
    return { name: st.name, payload: st.parts.join("") };
  }

  function entIndexOf(v) {
    if (v == null) return 0;
    if (typeof v === "number") return v | 0;
    if (typeof v.EntIndex === "function") return v.EntIndex() | 0;
    if (typeof v.entIndex === "function") return v.entIndex() | 0;
    return 0;
  }
  function userIdOf(v) {
    if (v == null) return -1;
    if (typeof v === "number") return v | 0;
    if (typeof v.UserID === "function") return v.UserID() | 0;
    if (typeof v.userId === "function") return v.userId() | 0;
    return -1;
  }
  function resolveEntity(idx) {
    idx = idx | 0;
    if (globalThis.ents && ents.GetByIndex) return ents.GetByIndex(idx);
    if (OV && OV.playerByUserId) return OV.playerByUserId(idx); // legacy fallback
    return null;
  }
  function resolvePlayer(uid) {
    uid = uid | 0;
    if (globalThis.player && player.GetByUserID) return player.GetByUserID(uid);
    if (OV && OV.playerByUserId) return OV.playerByUserId(uid);
    return null;
  }

  var net = {
    __openvibe: true,

    Start: function (name, unreliable) {
      name = String(name);
      if (isServer && !pooled(name)) {
        error("net.Start('" + name + "') — name not pooled; call util.AddNetworkString first");
        writeBuf = null;
        return false;
      }
      writeBuf = { name: name, fields: [], unreliable: !!unreliable };
      return true;
    },

    Abort: function () { writeBuf = null; },

    // ---- writers (bit widths accepted for GMod parity; JSON keeps precision) ----
    WriteBit: function (v) { push("b", !!v); return net; },
    WriteBool: function (v) { push("b", !!v); return net; },
    WriteInt: function (v, bits) { push("i", v | 0); return net; },
    WriteUInt: function (v, bits) { push("u", v >>> 0); return net; },
    WriteUInt64: function (v) { push("u64", String(v)); return net; },
    WriteFloat: function (v) { push("f", Number(v)); return net; },
    WriteDouble: function (v) { push("f", Number(v)); return net; },
    WriteString: function (v) { push("s", String(v)); return net; },
    WriteData: function (v, len) { var s = String(v); push("d", len === undefined ? s : s.slice(0, len)); return net; },
    WriteEntity: function (v) { push("e", entIndexOf(v)); return net; },
    WritePlayer: function (v) { push("p", userIdOf(v)); return net; },
    WriteVector: function (v) { push("v", v ? { x: +v.x || 0, y: +v.y || 0, z: +v.z || 0 } : { x: 0, y: 0, z: 0 }); return net; },
    WriteNormal: function (v) { return net.WriteVector(v); },
    WriteAngle: function (v) { push("a", v ? { p: +v.p || +v.pitch || 0, y: +v.y || +v.yaw || 0, r: +v.r || +v.roll || 0 } : { p: 0, y: 0, r: 0 }); return net; },
    WriteColor: function (v, writeAlpha) {
      var c = v || {};
      var out = { r: c.r | 0, g: c.g | 0, b: c.b | 0 };
      if (writeAlpha === undefined || writeAlpha) out.a = c.a === undefined ? 255 : c.a | 0;
      push("c", out); return net;
    },
    WriteTable: function (v, sequential) { push("t", v); return net; },
    WriteType: function (v) { push("y", v); return net; },

    // ---- readers (same order as written; past-end -> type default) ----
    ReadBit: function () { return readNext() ? 1 : 0; },
    ReadBool: function () { return !!readNext(); },
    ReadInt: function (bits) { return readNext() | 0; },
    ReadUInt: function (bits) { return readNext() >>> 0; },
    ReadUInt64: function () { var v = readNext(); return v === undefined ? "0" : String(v); },
    ReadFloat: function () { var v = readNext(); return v === undefined ? 0 : Number(v); },
    ReadDouble: function () { var v = readNext(); return v === undefined ? 0 : Number(v); },
    ReadString: function () { var v = readNext(); return v === undefined ? "" : String(v); },
    ReadData: function (len) { var v = readNext(); v = v === undefined ? "" : String(v); return len === undefined ? v : v.slice(0, len); },
    ReadEntity: function () { return resolveEntity(readNext() | 0); },
    ReadPlayer: function () { return resolvePlayer(readNext() | 0); },
    ReadVector: function () { var v = readNext(); return v && typeof v === "object" ? v : { x: 0, y: 0, z: 0 }; },
    ReadNormal: function () { return net.ReadVector(); },
    ReadAngle: function () { var v = readNext(); return v && typeof v === "object" ? v : { p: 0, y: 0, r: 0 }; },
    ReadColor: function (hasAlpha) {
      var v = readNext();
      var c = v && typeof v === "object" ? v : { r: 0, g: 0, b: 0 };
      if (c.a === undefined) c.a = 255;
      return c;
    },
    ReadTable: function (sequential) { var v = readNext(); return v === undefined ? {} : v; },
    ReadType: function () { return readNext(); },

    BytesWritten: function () { return writeBuf ? JSON.stringify(writeBuf.fields).length + 3 : 0; },
    BytesLeft: function () {
      if (!readBuf) return 0;
      var rest = readBuf.fields.slice(readBuf.cursor);
      return rest.length ? JSON.stringify(rest).length : 0;
    },

    Receive: function (name, fn) {
      if (typeof fn !== "function") throw new Error("net.Receive requires a function");
      receivers[String(name).toLowerCase()] = fn;
    },

    SetRateLimit: function (name, perSecond) { rateLimits[String(name).toLowerCase()] = perSecond | 0; },

    // ---- send: server -> client ----
    Send: function (target) {
      if (!writeBuf) return;
      if (!isServer) { warn("net.Send is server-only; use SendToServer on the client"); writeBuf = null; return; }
      var ids = [];
      if (target == null) { ids = [-1]; }
      else if (Array.isArray(target)) { ids = target.map(userIdOf); }
      else { ids = [userIdOf(target)]; }
      var name = writeBuf.name, payload = serialize();
      writeBuf = null;
      if (payload != null) emitChunked(ids.join(","), name, payload);
    },
    Broadcast: function () {
      if (!writeBuf) return;
      if (!isServer) { warn("net.Broadcast is server-only"); writeBuf = null; return; }
      var name = writeBuf.name, payload = serialize();
      writeBuf = null;
      if (payload != null) emitChunked("-1", name, payload);
    },
    SendOmit: function (omit) {
      if (!writeBuf) return;
      if (!isServer) { warn("net.SendOmit is server-only"); writeBuf = null; return; }
      var omitIds = {};
      (Array.isArray(omit) ? omit : [omit]).forEach(function (p) { omitIds[userIdOf(p)] = true; });
      var all = (OV && OV.players ? OV.players() : []) || [];
      var ids = [];
      for (var i = 0; i < all.length; i++) {
        var uid = userIdOf(all[i]);
        if (!omitIds[uid]) ids.push(uid);
      }
      var name = writeBuf.name, payload = serialize();
      writeBuf = null;
      if (payload != null && ids.length) emitChunked(ids.join(","), name, payload);
    },
    // PVS/PAS need engine visibility data; until the native bridge exposes it
    // these behave as Broadcast (documented deviation).
    SendPVS: function (pos) { return net.Broadcast(); },
    SendPAS: function (pos) { return net.Broadcast(); },

    // ---- send: client -> server ----
    SendToServer: function () {
      if (!writeBuf) return;
      if (isServer) { warn("net.SendToServer is client-only"); writeBuf = null; return; }
      var name = writeBuf.name, payload = serialize();
      writeBuf = null;
      if (payload != null) sendToServerChunked(name, payload);
    },

    // ---- inbound dispatch (fired via the OVNetReceive hook) ----
    _dispatch: function (name, payloadB64, ply) {
      name = String(name);
      if (name === "__ovchunk") {
        var whole = onChunk(String(payloadB64), ply);
        if (!whole) return;
        name = whole.name;
        payloadB64 = whole.payload;
      }
      var key = name.toLowerCase();
      var fn = receivers[key];
      if (!fn) return;
      if (!rateOk(key, ply)) { warn("rate limit exceeded for '" + name + "'"); return; }
      var decoded;
      try { decoded = JSON.parse(b64decode(payloadB64)); }
      catch (e) { error("bad payload for " + name + ": " + (e && e.message)); return; }
      readBuf = { fields: (decoded && decoded.f) || [], cursor: 0 };
      var lenBits = String(payloadB64).length * 8;
      try { fn(lenBits, isServer ? (ply || null) : null); }
      catch (e) { error("net.Receive('" + name + "') threw: " + (e && e.stack ? e.stack : e.message)); }
      readBuf = null;
    },

    Receivers: receivers
  };

  globalThis.net = net;

  // Bridge inbound -> JS. The bridge fires "OVNetReceive" with (name, payloadB64, ply).
  if (globalThis.hook && typeof hook.Add === "function") {
    hook.Add("OVNetReceive", "OpenVibeNetDispatch", function (name, payloadB64, ply) {
      net._dispatch(name, payloadB64, ply);
      return undefined;
    });
  }

  if (OV && OV.log) OV.log("net library ready (realm=" + (isServer ? "server" : "client") + ")");
})();
