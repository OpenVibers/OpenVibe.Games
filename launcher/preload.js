// preload.js — secure IPC bridge exposed to renderer
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('OV', {
  // API calls (proxied through main process)
  health:      ()            => ipcRenderer.invoke('api:health'),
  servers:     ()            => ipcRenderer.invoke('api:servers'),
  leaderboard: (limit)       => ipcRenderer.invoke('api:leaderboard', limit),
  travel:      (opts)        => ipcRenderer.invoke('api:travel', opts),

  // Game launch
  launchGame:  (ip, port)    => ipcRenderer.invoke('game:launch', { ip, port }),
  launchMode:  (mode)        => ipcRenderer.invoke('game:launch-direct', mode),
  gameStatus:  ()            => ipcRenderer.invoke('game:status'),

  // Window controls
  minimize:    ()            => ipcRenderer.send('window:minimize'),
  maximize:    ()            => ipcRenderer.send('window:maximize'),
  close:       ()            => ipcRenderer.send('window:close'),
  openUrl:     (url)         => ipcRenderer.send('open-url', url),

  // Events from main → renderer
  onGameExit: (cb) => ipcRenderer.on('game-exited', (_e, code) => cb(code)),
});
