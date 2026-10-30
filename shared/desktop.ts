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
  removeSource: (id: string) => Promise<void>
}
