import type { IngestReview, IngestStatus } from './ingestion'
import type { DiscoveryRequest, ShotChange, ShotCollection, ShotDetails } from './shots'
import type { ViewingLut } from './viewing'
import type { OptionRemovalPlan, OrganizationAction, TagVocabulary } from './organization'
import type { IPCResult } from './errors'
import type { LibraryCollection } from './library'
import type { SyncReview } from './sync'

export interface BackendHealth {
  status: 'ok'
  service: 'shot-manager-backend'
  mode: 'development-only'
}

export interface ApplicationStatus {
  level: 'ready' | 'warning' | 'error'
  message: string
  detail?: string
}

export type BackendStatus =
  | { state: 'connected'; health: BackendHealth; application?: ApplicationStatus }
  | { state: 'starting' | 'unavailable'; message: string }

export interface AppConfiguration {
  version: 1
  libraryPath: string | null
  libraryMount?: string
  scratchPath?: string | null
  scratchMount?: string
}

// Opaque capability for a directory selected by the native picker; not yet saved.
export interface LocationChoice { token: string; path: string }
export interface LocationChanges { library?: string | null }
export interface CacheSelection { metadata: boolean; thumbnails: boolean; fingerprints: boolean; proxies: boolean; catalogue?: boolean }

export interface CacheSummary {
  bytes: number
  files: number
}

export interface CacheInventory {
  catalogue?: CacheSummary
  metadata: CacheSummary
  thumbnails: CacheSummary
  fingerprints: CacheSummary
  proxies: CacheSummary
  total: CacheSummary
}

export interface LocalDataSummary extends CacheSummary {
  options: number
  identities: number
  projects: number
  tags: number
  records: number
  fingerprints: number
  clips: number
}

export interface DesktopAPI {
  chooseSyncDestination: () => Promise<LocationChoice | null>
  reviewLibrarySync: (shotIds: string[], destinationToken: string) => Promise<SyncReview>
  startLibrarySync: (token: string, shotIds: string[]) => Promise<IngestStatus>
  getLibrary: () => Promise<LibraryCollection>
  refreshCatalogue: () => Promise<LibraryCollection>
  onLibraryChanged: (listener: (change: ShotChange) => void) => () => void
  getLibraryVocabulary: () => Promise<TagVocabulary>
  updateLibraryOrganization: DesktopAPI['updateOrganization']
  revertLibraryOrganization: DesktopAPI['revertOrganization']
  reviewLibraryCommit: DesktopAPI['reviewIngest']
  startLibraryCommit: DesktopAPI['startIngest']
  getLibraryThumbnail: DesktopAPI['getShotThumbnail']
  setLibraryThumbnail: DesktopAPI['setShotThumbnail']
  getLibraryDetails: DesktopAPI['getShotDetails']
  getLibraryLut: DesktopAPI['getShotLut']
  getIngestStatus: () => Promise<IngestStatus>
  refreshLibrary: () => Promise<IngestStatus>
  onIngestChanged: (listener: (status: IngestStatus) => void) => () => void
  reviewIngest: (shotIds: string[], includeSynced?: boolean) => Promise<IngestReview>
  startIngest: (token: string, shotIds: string[]) => Promise<IngestStatus>
  stopAllWork: () => Promise<IngestStatus>
  resumeWork: () => Promise<IngestStatus>
  dismissIngestError: (eventId: string) => Promise<void>
  getSaveStatus: () => Promise<SaveStatus>
  onSaveStatusChanged: (listener: (status: SaveStatus) => void) => () => void
  retryOrganizationSaves: () => Promise<void>
  previewConfigurationOptions: (removals: TagVocabulary) => Promise<OptionRemovalPlan>
  saveConfigurationOptions: (removals: TagVocabulary, reviewToken: string) => Promise<{ vocabulary: TagVocabulary; collection: ShotCollection }>
  flushOrganizationText: () => Promise<void>
  getLocalDataSummary: () => Promise<LocalDataSummary>
  clearLocalData: (selection: CacheSelection) => Promise<{ collection: ShotCollection; configuration: AppConfiguration; workspaceReset: boolean }>
  browseCache: () => Promise<void>
  getCacheInventory: () => Promise<CacheInventory>
  getTagVocabulary: () => Promise<TagVocabulary>
  updateOrganization: (shotIds: string[], action: OrganizationAction) => Promise<{ collection: ShotCollection; vocabulary: TagVocabulary }>
  revertOrganization: (shotIds: string[]) => Promise<{ collection: ShotCollection; vocabulary: TagVocabulary }>
  getConfiguration: () => Promise<AppConfiguration>
  chooseLibrary: () => Promise<LocationChoice | null>
  saveConfigurationLocations: (changes: LocationChanges) => Promise<{ configuration: AppConfiguration; warning?: string; workspaceReset?: boolean }>
  getCacheSummary: () => Promise<CacheSummary>
  clearCache: () => Promise<CacheSummary>
  getBackendStatus: () => Promise<BackendStatus>
  chooseClips: () => Promise<DiscoveryRequest | null>
  addDroppedClips: (file: File) => Promise<DiscoveryRequest>
  getShots: () => Promise<ShotCollection>
  cancelClips: (shotIds: string[]) => Promise<ShotCollection>
  ejectClips: (shotIds: string[]) => Promise<ShotCollection>
  onShotsChanged: (listener: (change: ShotChange) => void) => () => void
  getShotThumbnail: (id: string) => Promise<string | null>
  setShotThumbnail: (id: string, dataUrl: string) => Promise<void>
  getShotDetails: (id: string) => Promise<ShotDetails>
  getShotLut: (id: string) => Promise<ViewingLut | null>
}

export interface SaveStatus { pending: number; failed: number; error?: string; closing?: boolean; shutdownPhase?: 'saving' | 'backend' }

// Error data crosses contextBridge as plain values; renderer constructs its own Error.
export type DesktopBridge = { [K in keyof DesktopAPI]: DesktopAPI[K] extends (...args: infer A) => Promise<infer R>
  ? (...args: A) => Promise<IPCResult<R>> : DesktopAPI[K] }
