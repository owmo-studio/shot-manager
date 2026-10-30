import { contextBridge, ipcRenderer } from 'electron'
import type { DesktopAPI } from '../shared/desktop'

const desktop: DesktopAPI = {
  getBackendStatus: () => ipcRenderer.invoke('backend:status')
}

contextBridge.exposeInMainWorld('desktop', desktop)
