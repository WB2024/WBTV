const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('wbtvDesktop', {
  current: () => ipcRenderer.invoke('server:get'),
  connect: (address) => ipcRenderer.invoke('server:set', address),
});
