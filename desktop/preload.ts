import { contextBridge, ipcRenderer } from 'electron'
import type { DesktopAPI } from '../shared/desktop'

const desktop: DesktopAPI = {
  getBackendStatus: () => ipcRenderer.invoke('backend:status'),
  getSources: () => ipcRenderer.invoke('sources:list'),
  chooseSource: () => ipcRenderer.invoke('sources:choose'),
  removeSource: (id) => ipcRenderer.invoke('sources:remove', id)
}

contextBridge.exposeInMainWorld('desktop', desktop)
