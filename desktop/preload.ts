import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { DesktopBridge } from '../shared/desktop'
import type { IPCResult } from '../shared/errors'

function invoke<T>(channel: string, ...args: unknown[]): Promise<IPCResult<T>> {
  return ipcRenderer.invoke(channel, ...args)
}

const desktop: DesktopBridge = {
  getIngestStatus: () => invoke('ingestion:status'),
  refreshLibrary: () => invoke('ingestion:refresh-library'),
  onIngestChanged: listener => {
    const handler = (_event: Electron.IpcRendererEvent, status: Parameters<typeof listener>[0]) => listener(status)
    ipcRenderer.on('ingestion:changed', handler)
    return () => ipcRenderer.removeListener('ingestion:changed', handler)
  },
  reviewIngest: shotIds => invoke('ingestion:review', shotIds),
  startIngest: (token, shotIds) => invoke('ingestion:start', token, shotIds),
  stopAllWork: () => invoke('work:stop'),
  resumeWork: () => invoke('work:resume'),
  dismissIngestError: eventId => invoke('ingestion:dismiss-error', eventId),
  getSaveStatus: () => invoke('organization:save-status'),
  retryOrganizationSaves: () => invoke('organization:retry-saves'),
  onSaveStatusChanged: listener => {
    const handler = (_event: Electron.IpcRendererEvent, status: Parameters<typeof listener>[0]) => listener(status)
    ipcRenderer.on('organization:save-status', handler)
    return () => ipcRenderer.removeListener('organization:save-status', handler)
  },
  previewConfigurationOptions: removals => invoke('configuration:preview-options', removals),
  saveConfigurationOptions: (removals, reviewToken) => invoke('configuration:save-options', removals, reviewToken),
  flushOrganizationText: () => invoke('organization:flush-text'),
  getLocalDataSummary: () => invoke('local-data:summary'),
  clearLocalData: selection => invoke('local-data:clear', selection),
  browseCache: () => invoke('local-data:browse'),
  getCacheInventory: () => invoke('local-data:inventory'),
  getTagVocabulary: () => invoke('organization:vocabulary'),
  updateOrganization: (shotIds, action) => invoke('organization:update', shotIds, action),
  revertOrganization: shotIds => invoke('organization:revert', shotIds),
  getConfiguration: () => invoke('configuration:get'),
  chooseLibrary: () => invoke('configuration:choose-library'),
  saveConfigurationLocations: changes => invoke('configuration:save-locations', changes),
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
