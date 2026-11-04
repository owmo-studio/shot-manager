import type { ShotCollection, ShotDetails } from './shots'
import type { ViewingLut } from './viewing'

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
}

export interface CacheSummary {
  bytes: number
  files: number
}

export interface DesktopAPI {
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
  onShotsChanged: (listener: (collection: ShotCollection) => void) => () => void
  getShotThumbnail: (id: string) => Promise<string | null>
  setShotThumbnail: (id: string, dataUrl: string) => Promise<void>
  getShotDetails: (id: string) => Promise<ShotDetails>
  getShotLut: (id: string) => Promise<ViewingLut | null>
}
