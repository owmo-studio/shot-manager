import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { DesktopBridge } from '../shared/desktop'
import type { IPCResult } from '../shared/errors'

function invoke<T>(channel: string, ...args: unknown[]): Promise<IPCResult<T>> {
  return ipcRenderer.invoke(channel, ...args)
}

const desktop: DesktopBridge = {
  getSaveStatus: () => invoke('organization:save-status'),
  retryOrganizationSaves: () => invoke('organization:retry-saves'),
  onSaveStatusChanged: listener => {
    const handler = (_event: Electron.IpcRendererEvent, status: Parameters<typeof listener>[0]) => listener(status)
    ipcRenderer.on('organization:save-status', handler)
    return () => ipcRenderer.removeListener('organization:save-status', handler)
  },
  previewConfigurationOptions: removals => invoke('configuration:preview-options', removals),
  saveConfigurationOptions: (removals, reviewToken) => invoke('configuration:save-options', removals, reviewToken),
  flushNotes: () => invoke('organization:flush-notes'),
  getLocalDataSummary: () => invoke('local-data:summary'),
  clearLocalData: () => invoke('local-data:clear'),
  getTagVocabulary: () => invoke('organization:vocabulary'),
  updateOrganization: (shotIds, action) => invoke('organization:update', shotIds, action),
  getConfiguration: () => invoke('configuration:get'),
  chooseLibrary: () => invoke('configuration:choose-library'),
  getCacheSummary: () => invoke('cache:summary'),
  clearCache: () => invoke('cache:clear'),
  getBackendStatus: () => invoke('backend:status'),
  getSources: () => invoke('sources:list'),
  chooseSource: () => invoke('sources:choose'),
  addDroppedSource: (file) => invoke('sources:drop', webUtils.getPathForFile(file)),
  removeSource: (id) => invoke('sources:remove', id),
  refreshSource: (id) => invoke('sources:refresh', id),
  relinkSource: (id) => invoke('sources:relink', id),
  getShots: () => invoke('shots:list'),
  onShotsChanged: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, collection: Parameters<typeof listener>[0]) => listener(collection)
    ipcRenderer.on('shots:changed', handler)
    return () => { ipcRenderer.removeListener('shots:changed', handler) }
  },
  getShotThumbnail: (id) => invoke('shots:thumbnail', id),
  setShotThumbnail: (id, dataUrl) => invoke('shots:set-thumbnail', id, dataUrl),
  getShotDetails: (id) => invoke('shots:details', id),
  getShotLut: (id) => invoke('shots:lut', id)
}

contextBridge.exposeInMainWorld('desktopBridge', desktop)
