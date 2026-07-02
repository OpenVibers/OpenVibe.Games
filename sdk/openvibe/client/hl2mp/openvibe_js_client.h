#ifndef OPENVIBE_JS_CLIENT_H
#define OPENVIBE_JS_CLIENT_H
#ifdef _WIN32
#pragma once
#endif

// Client-realm OpenVibe JavaScript runtime lifecycle. Mirrors the server JS
// integration but for CLIENT_DLL: runs core JS + js/gamemodes/<mode>/client.js,
// gives client addons a place to run, and bridges the net library both ways
// (client->server via the ov_net forward, server->client via the OVNet
// usermessage).
void OpenVibeJS_Client_Init();
void OpenVibeJS_Client_Shutdown();
void OpenVibeJS_Client_Think();

#endif // OPENVIBE_JS_CLIENT_H
