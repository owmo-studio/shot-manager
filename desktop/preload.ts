import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { DesktopAPI } from '../shared/desktop'

const desktop: DesktopAPI = {
  getBackendStatus: () => ipcRenderer.invoke('backend:status'),
  getSources: () => ipcRenderer.invoke('sources:list'),
  chooseSource: () => ipcRenderer.invoke('sources:choose'),
  addDroppedSource: (file) => ipcRenderer.invoke('sources:drop', webUtils.getPathForFile(file)),
  removeSource: (id) => ipcRenderer.invoke('sources:remove', id),
  refreshSource: (id) => ipcRenderer.invoke('sources:refresh', id),
  getShots: () => ipcRenderer.invoke('shots:list'),
  onShotsChanged: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, collection: Parameters<typeof listener>[0]) => listener(collection)
    ipcRenderer.on('shots:changed', handler)
    return () => { ipcRenderer.removeListener('shots:changed', handler) }
  },
  getShotThumbnail: (id, fallback) => ipcRenderer.invoke('shots:thumbnail', id, fallback),
  setShotThumbnail: (id, dataUrl) => ipcRenderer.invoke('shots:set-thumbnail', id, dataUrl),
  getShotDetails: (id) => ipcRenderer.invoke('shots:details', id)
}

contextBridge.exposeInMainWorld('desktop', desktop)
