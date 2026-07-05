// preload.js — secure IPC bridge exposed to renderer
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('OV', {
  // API calls (proxied through main process)
  health:      ()            => ipcRenderer.invoke('api:health'),
  servers:     ()            => ipcRenderer.invoke('api:servers'),
  leaderboard: (limit)       => ipcRenderer.invoke('api:leaderboard', limit),
  travel:      (opts)        => ipcRenderer.invoke('api:travel', opts),

  // Steam sign-in via a Steam OpenID popup window (handled in main process).
  // Resolves { sessionToken, steamId } or { error } — never rejects.
  steamLogin:  ()            => ipcRenderer.invoke('ov-steam-login'),

  // Game launch
  launchGame:  (ip, port)    => ipcRenderer.invoke('game:launch', { ip, port }),
  launchMode:  (mode)        => ipcRenderer.invoke('game:launch-direct', mode),
  gameStatus:  ()            => ipcRenderer.invoke('game:status'),
  focusGame:   ()            => ipcRenderer.invoke('game:focus'),
  showLauncher: ()           => ipcRenderer.invoke('launcher:show'),

  // Window controls
  minimize:    ()            => ipcRenderer.send('window:minimize'),
  maximize:    ()            => ipcRenderer.send('window:maximize'),
  close:       ()            => ipcRenderer.send('window:close'),
  openUrl:     (url)         => ipcRenderer.send('open-url', url),
  setRoute:    (route)       => ipcRenderer.send('ui:set-route', route),

  // Events from main → renderer
  onGameStart: (cb) => ipcRenderer.on('game-started', (_e, pid) => cb(pid)),
  // Loading-overlay phase updates: { phase: 'starting'|'connected'|'map'|'ready'|'timeout', message, at }
  onLoadingPhase: (cb) => ipcRenderer.on('ov-loading-phase', (_e, info) => cb(info)),
  onLaunchState: (cb) => ipcRenderer.on('launch-state', (_e, state) => cb(state)),
  onLaunchPhase: (cb) => ipcRenderer.on('game-launch-phase', (_e, info) => cb(info)),
  onGameExit: (cb) => ipcRenderer.on('game-exited', (_e, code) => cb(code)),
  onRoute:    (cb) => ipcRenderer.on('ui:set-route', (_e, route) => cb(route)),
});
