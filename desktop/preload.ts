import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { DesktopAPI } from '../shared/desktop'

const desktop: DesktopAPI = {
  getConfiguration: () => ipcRenderer.invoke('configuration:get'),
  chooseLibrary: () => ipcRenderer.invoke('configuration:choose-library'),
  getCacheSummary: () => ipcRenderer.invoke('cache:summary'),
  clearCache: () => ipcRenderer.invoke('cache:clear'),
  getBackendStatus: () => ipcRenderer.invoke('backend:status'),
  getSources: () => ipcRenderer.invoke('sources:list'),
  chooseSource: () => ipcRenderer.invoke('sources:choose'),
  addDroppedSource: (file) => ipcRenderer.invoke('sources:drop', webUtils.getPathForFile(file)),
  removeSource: (id) => ipcRenderer.invoke('sources:remove', id),
  refreshSource: (id) => ipcRenderer.invoke('sources:refresh', id),
  relinkSource: (id) => ipcRenderer.invoke('sources:relink', id),
  getShots: () => ipcRenderer.invoke('shots:list'),
  onShotsChanged: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, collection: Parameters<typeof listener>[0]) => listener(collection)
    ipcRenderer.on('shots:changed', handler)
    return () => { ipcRenderer.removeListener('shots:changed', handler) }
  },
  getShotThumbnail: (id) => ipcRenderer.invoke('shots:thumbnail', id),
  setShotThumbnail: (id, dataUrl) => ipcRenderer.invoke('shots:set-thumbnail', id, dataUrl),
  getShotDetails: (id) => ipcRenderer.invoke('shots:details', id),
  getShotLut: (id) => ipcRenderer.invoke('shots:lut', id)
}

contextBridge.exposeInMainWorld('desktop', desktop)
