import type { ShotCollection } from './shots'

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

export interface DesktopAPI {
  getBackendStatus: () => Promise<BackendStatus>
  getSources: () => Promise<ImportSource[]>
  chooseSource: () => Promise<ImportSource | null>
  addDroppedSource: (file: File) => Promise<ImportSource>
  removeSource: (id: string) => Promise<void>
  refreshSource: (id: string) => Promise<{ source: ImportSource; collection: ShotCollection }>
  getShots: () => Promise<ShotCollection>
  onShotsChanged: (listener: (collection: ShotCollection) => void) => () => void
  getShotThumbnail: (id: string) => Promise<string | null>
}
