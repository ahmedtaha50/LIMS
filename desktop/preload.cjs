// Loaded ONLY by the setup window (desktop/main.cjs showSetup) and the update window (showUpdate). The application window has no preload.
// The main process also checks, on every call, that it comes from the top frame of that window showing setup.html.
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('lims', {
  getConfig: () => ipcRenderer.invoke('config:get'),
  saveAndStart: (cfg) => ipcRenderer.invoke('config:save', cfg),
});
// The update window (desktop/main.cjs showUpdate) uses this; the main process checks the sender of every call.
contextBridge.exposeInMainWorld('limsUpdate', {
  info: () => ipcRenderer.invoke('update:info'),
  install: (form) => ipcRenderer.invoke('update:install', form),
});
