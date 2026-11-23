import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { DesktopBridge } from '../shared/desktop'
import type { IPCResult } from '../shared/errors'

function invoke<T>(channel: string, ...args: unknown[]): Promise<IPCResult<T>> {
  return ipcRenderer.invoke(channel, ...args)
}

const desktop: DesktopBridge = {
  getLibrary: () => invoke('library:list'),
  chooseSyncDestination: () => invoke('sync:choose-destination'),
  reviewLibrarySync: (ids, destinationToken) => invoke('sync:review', ids, destinationToken),
  startLibrarySync: (token, ids) => invoke('sync:start', token, ids),
  refreshCatalogue: () => invoke('library:refresh'),
  onLibraryChanged: listener => {
    const handler = (_event: Electron.IpcRendererEvent, change: Parameters<typeof listener>[0]) => listener(change)
    ipcRenderer.on('library:changed', handler)
    return () => ipcRenderer.removeListener('library:changed', handler)
  },
  getLibraryVocabulary: () => invoke('library:vocabulary'),
  updateLibraryOrganization: (ids, action) => invoke('library:update', ids, action),
  revertLibraryOrganization: ids => invoke('library:revert', ids),
  reviewLibraryCommit: ids => invoke('library:review', ids),
  startLibraryCommit: (token, ids) => invoke('library:commit', token, ids),
  reviewLibraryDelete: ids => invoke('library:delete-review', ids),
  deleteLibraryClips: (token, ids) => invoke('library:delete', token, ids),
  onOrphanCleanupRequested: listener => {
    const handler = () => listener()
    ipcRenderer.on('library:open-orphan-cleanup', handler)
    return () => ipcRenderer.removeListener('library:open-orphan-cleanup', handler)
  },
  reviewOrphanedData: () => invoke('library:orphans-review'),
  deleteOrphanedData: (token, ids) => invoke('library:orphans-delete', token, ids),
  getLibraryThumbnail: id => invoke('library:thumbnail', id),
  setLibraryThumbnail: (id, dataUrl) => invoke('library:set-thumbnail', id, dataUrl),
  getLibraryDetails: id => invoke('library:details', id),
  getLibraryLut: id => invoke('library:lut', id),
  getIngestStatus: () => invoke('ingestion:status'),
  refreshLibrary: () => invoke('ingestion:refresh-library'),
  controlQueue: (queue, pause) => invoke('work:control-queue', queue, pause),
  onIngestChanged: listener => {
    const handler = (_event: Electron.IpcRendererEvent, status: Parameters<typeof listener>[0]) => listener(status)
    ipcRenderer.on('ingestion:changed', handler)
    return () => ipcRenderer.removeListener('ingestion:changed', handler)
  },
  reviewIngest: (shotIds, includeSynced) => invoke('ingestion:review', shotIds, includeSynced),
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
  chooseClips: () => invoke('workspace:choose'),
  addDroppedClips: (file) => invoke('workspace:drop', webUtils.getPathForFile(file)),
  getShots: () => invoke('shots:list'),
  cancelClips: (shotIds, kind) => invoke('workspace:cancel', shotIds, kind),
  ejectClips: shotIds => invoke('workspace:eject', shotIds),
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
