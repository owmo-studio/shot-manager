import type { IngestReview, IngestStatus } from './ingestion'
import type { ShotChange, ShotCollection, ShotDetails } from './shots'
import type { ViewingLut } from './viewing'
import type { OptionRemovalPlan, OrganizationAction, TagVocabulary } from './organization'
import type { IPCResult } from './errors'

export interface BackendHealth {
  status: 'ok'
  service: 'shot-manager-backend'
  mode: 'development-only'
}

export type BackendStatus =
  | { state: 'connected'; health: BackendHealth }
  | { state: 'starting' | 'unavailable'; message: string }

export interface ImportSource {
  id: string
  name: string
  path: string
  type: 'sony' | 'folder'
  cameraModels: string[]
  available: boolean
  warning?: string
}

export interface AppConfiguration {
  version: 1
  libraryPath: string | null
  libraryMount?: string
}

export interface CacheSummary {
  bytes: number
  files: number
}

export interface LocalDataSummary extends CacheSummary {
  options: number
  identities: number
  projects: number
  tags: number
  records: number
  fingerprints: number
  sources: number
  clips: number
}

export interface DesktopAPI {
  getIngestStatus: () => Promise<IngestStatus>
  refreshLibrary: () => Promise<IngestStatus>
  onIngestChanged: (listener: (status: IngestStatus) => void) => () => void
  reviewIngest: (shotIds: string[]) => Promise<IngestReview>
  startIngest: (token: string, shotIds: string[]) => Promise<IngestStatus>
  stopIngest: () => Promise<IngestStatus>
  dismissIngestError: (eventId: string) => Promise<void>
  getSaveStatus: () => Promise<SaveStatus>
  onSaveStatusChanged: (listener: (status: SaveStatus) => void) => () => void
  retryOrganizationSaves: () => Promise<void>
  previewConfigurationOptions: (removals: TagVocabulary) => Promise<OptionRemovalPlan>
  saveConfigurationOptions: (removals: TagVocabulary, reviewToken: string) => Promise<{ vocabulary: TagVocabulary; collection: ShotCollection }>
  flushOrganizationText: () => Promise<void>
  getLocalDataSummary: () => Promise<LocalDataSummary>
  clearLocalData: () => Promise<{ summary: LocalDataSummary; collection: ShotCollection }>
  getTagVocabulary: () => Promise<TagVocabulary>
  updateOrganization: (shotIds: string[], action: OrganizationAction) => Promise<{ collection: ShotCollection; vocabulary: TagVocabulary }>
  revertOrganization: (shotIds: string[]) => Promise<{ collection: ShotCollection; vocabulary: TagVocabulary }>
  getConfiguration: () => Promise<AppConfiguration>
  chooseLibrary: () => Promise<AppConfiguration | null>
  getCacheSummary: () => Promise<CacheSummary>
  clearCache: () => Promise<CacheSummary>
  getBackendStatus: () => Promise<BackendStatus>
  getSources: () => Promise<ImportSource[]>
  chooseSource: () => Promise<ImportSource | null>
  addDroppedSource: (file: File) => Promise<ImportSource>
  removeSource: (id: string) => Promise<void>
  refreshSource: (id: string) => Promise<{ source: ImportSource; collection: ShotCollection }>
  relinkSource: (id: string) => Promise<{ source: ImportSource; collection: ShotCollection } | null>
  getShots: () => Promise<ShotCollection>
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
