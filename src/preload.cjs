const { contextBridge, ipcRenderer, webUtils } = require('electron');

const channels = new Set([
  'state', 'profile:edit', 'profile:mod', 'mods:import', 'mods:rename', 'mods:remove',
  'mods:folder', 'mods:slider-sheet', 'mods:config-read', 'mods:config-write', 'settings:pick', 'settings:detect',
  'mods:appearance-saves', 'mods:apply-appearance',
  'presets:state', 'presets:paste', 'presets:apply', 'presets:remove',
  'settings:smithbox', 'settings:me3-install', 'settings:me3-version', 'settings:skip-logos', 'saves:backup', 'saves:restore', 'merge:review', 'merge:build',
  'saves:rename', 'saves:delete', 'saves:folder',
  'reshade:install', 'reshade:uninstall', 'reshade:select', 'reshade:me3',
  'game:launch', 'game:log', 'nexus:connect', 'nexus:disconnect', 'nexus:mod', 'nexus:download',
  'nexus:register', 'nexus:pending', 'open:external', 'open:data',
  'updates:preference', 'updates:check', 'updates:download', 'updates:manual', 'updates:install', 'storage:change'
]);

contextBridge.exposeInMainWorld('ringward', {
  invoke(channel, ...args) {
    if (!channels.has(channel)) throw new Error('Unknown action.');
    return ipcRenderer.invoke(channel, ...args);
  },
  dropped(files, profile) {
    return ipcRenderer.invoke('mods:import', 'drop', profile, files.map(file => webUtils.getPathForFile(file)).filter(Boolean));
  },
  onProgress(callback) { ipcRenderer.on('operation:progress', (_event, data) => callback(data)); },
  onIncoming(callback) { ipcRenderer.on('nexus:incoming', () => callback()); },
  onUpdates(callback) { ipcRenderer.on('updates:state', (_event, data) => callback(data)); },
  onGameEnded(callback) { ipcRenderer.on('game:ended', (_event, code) => callback(code)); }
});
