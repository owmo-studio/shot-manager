import { app, BrowserWindow, dialog, ipcMain, protocol, shell, utilityProcess } from 'electron'
import type { IpcMainInvokeEvent, UtilityProcess } from 'electron'
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { mkdir, realpath } from 'node:fs/promises'
import type { LibraryLocation } from '../server/library'
import { inspectLibrary } from '../server/library'
import { assertCacheReady, cacheFiles, cacheInventory, clearSelectedCache, managedCacheDirectory } from '../server/cacheFiles'
import type { CacheSelection } from '../server/cacheFiles'
import { readConfiguration, saveConfiguration } from './configuration'
import { validateOptionRemovals, validateOrganizationAction } from '../shared/organization'
import type { OrganizationAction } from '../shared/organization'
import { DebouncedWrites, RetainedWrites, WriteQueue } from './writeQueue'
import { installApplicationMenu } from './menu'
import { requestBackend } from './backendRequest'
import { AppError, errorDetails } from '../shared/errors'
import type { ApplicationStatus, BackendHealth, BackendStatus } from '../shared/desktop'
import type { WorkspaceRestore } from '../shared/shots'
import { storageWaitSeconds } from '../server/storageRecovery'

let mainWindow: BrowserWindow | null = null
let backend: UtilityProcess | null = null
let backendURL: string | null = null
let backendState: 'starting' | 'unavailable' = 'starting'
let quitting = false
let shutdownComplete = false
const token = randomBytes(32).toString('hex')
let choosingSource = false
let choosingLibrary = false
const organizationWrites = new WriteQueue()
const draftWrites = new RetainedWrites(organizationWrites, publishSaveStatus)
const textWrites = new DebouncedWrites(draftWrites, 500)
let backendStopping = false

function publishSaveStatus() {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('organization:save-status', {
    ...draftWrites.status(), closing: quitting, shutdownPhase: backendStopping ? 'backend' : 'saving'
  })
}

async function flushDrafts() {
  await textWrites.flush()
  await draftWrites.drain()
}

async function assertSourceAddingReady() {
  const status = await backendRequest<ApplicationStatus>('/api/application-status')
  if (status.level === 'error') throw new Error(`${status.message}. Resolve this issue before adding clips.`)
}

async function managedCacheLocation() {
  const parent = await realpath(app.getPath('userData'))
  const root = join(parent, managedCacheDirectory)
  const location = await inspectLibrary(parent)
  return { parent, root, mount: location.mount }
}
const pendingIPC = new Set<Promise<unknown>>()
const mediaShutdown = new AbortController()

function handle(channel: string, listener: Parameters<typeof ipcMain.handle>[1]) {
  ipcMain.handle(channel, (event, ...args) => {
    // Calls already accepted are drained; late renderer calls must not restart work.
    if (quitting) return { ok: false, error: errorDetails(new AppError('The app is closing.', 'APP_CLOSING')) }
    const request = Promise.resolve().then(() => listener(event, ...args))
    pendingIPC.add(request)
    return request.then(value => ({ ok: true, value }), error => ({ ok: false, error: errorDetails(error) }))
      .finally(() => pendingIPC.delete(request))
  })
}

protocol.registerSchemesAsPrivileged([
  { scheme: 'shot-media', privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true, corsEnabled: true } }
])

function backendRequest<T = unknown>(path: string, options: RequestInit = {}) {
  return requestBackend<T>(backendURL, token, path, options)
}

function requireMainWindow(event: IpcMainInvokeEvent): BrowserWindow {
  if (!mainWindow || event.sender !== mainWindow.webContents ||
      event.senderFrame !== mainWindow.webContents.mainFrame) {
    throw new Error('Untrusted sender')
  }
  return mainWindow
}

async function startBackend(): Promise<void> {
  const sourceLuts = app.isPackaged ? join(process.resourcesPath, 'luts') : join(app.getAppPath(), 'resources', 'luts')
  const lutDirectory = existsSync(sourceLuts) ? sourceLuts : join(__dirname, '..', 'resources', 'luts')
  const configurationPath = join(app.getPath('userData'), 'configuration.json')
  const cache = await managedCacheLocation()
  const storage = cacheFiles(cache.root)
  await assertCacheReady(cache.parent, storage.root, cache.mount)
  backendState = 'starting'
  backend = utilityProcess.fork(join(__dirname, 'backend.cjs'), [], {
    serviceName: 'Shot Manager Backend',
    env: { ...process.env, SHOT_MANAGER_TOKEN: token,
      // Finder does not inherit the shell PATH that finds Homebrew media tools.
      PATH: [...new Set([...(process.env.PATH ?? '').split(':'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'].filter(Boolean))].join(':'),
      SHOT_MANAGER_THUMBNAIL_CACHE: storage.thumbnails, SHOT_MANAGER_FINGERPRINT_DIRECTORY: storage.fingerprints,
      SHOT_MANAGER_ORGANIZATION_FILE: storage.metadata, SHOT_MANAGER_CACHE_ROOT: storage.root,
      SHOT_MANAGER_CACHE_PARENT: cache.parent, SHOT_MANAGER_CACHE_MOUNT: cache.mount,
      SHOT_MANAGER_CONFIGURATION_FILE: configurationPath, SHOT_MANAGER_LUT_DIRECTORY: lutDirectory }
  })
  const started = new Promise<void>((resolve, reject) => {
    backend!.on('message', (message: unknown) => { if (typeof message === 'object' && message !== null && 'type' in message && message.type === 'ready') resolve() })
    backend!.once('exit', code => reject(new Error(`Backend exited before ready (${code}).`)))
  })
  backend.on('message', (message: unknown) => {
    if (typeof message === 'object' && message !== null && 'type' in message &&
        message.type === 'ingestion:changed' && 'status' in message) {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('ingestion:changed', message.status)
      return
    }
    if (typeof message === 'object' && message !== null && 'type' in message &&
        (message.type === 'shots:changed' || message.type === 'library:changed') && 'change' in message) {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(message.type, message.change)
      return
    }
    if (typeof message === 'object' && message !== null && 'type' in message &&
        message.type === 'ready' && 'url' in message && typeof message.url === 'string') {
      backendURL = message.url
      console.info(`Backend ready at ${backendURL}`)
    }
  })
  backend.on('exit', (code) => {
    backend = null
    backendURL = null
    backendState = 'unavailable'
    console.info(`Backend exited (${code})`)
    if (backendStopping) {
      shutdownComplete = true
      mainWindow?.destroy()
      app.quit()
    }
  })
  return started
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1800,
    height: 1080,
    minWidth: 1100,
    minHeight: 560,
    title: 'OWMO Shot Manager',
    backgroundColor: '#111318',
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  mainWindow.webContents.on('will-navigate', (event, url) => {
    // Clear Cache restarts the backend and reloads this page to reset snapshot revisions.
    if (url !== mainWindow?.webContents.getURL()) event.preventDefault()
  })
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.key.toLowerCase() === 'q' && input.meta && !input.control && !input.alt && !input.shift) {
      event.preventDefault()
      app.quit()
    }
  })
  mainWindow.on('close', event => {
    if (!shutdownComplete) { event.preventDefault(); app.quit() }
  })
  mainWindow.on('closed', () => { mainWindow = null })

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow?.isMinimized()) mainWindow.restore()
    mainWindow?.show()
    mainWindow?.focus()
  })

  app.whenReady().then(() => {
    installApplicationMenu()
    const validateIngestIds = (value: unknown): string[] => {
      if (!Array.isArray(value) || !value.length || value.length > 1000 || value.some(id => typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id))) throw new Error('Invalid commit selection')
      return [...new Set(value)]
    }
    handle('workspace:cancel', async (event, value: unknown) => {
      requireMainWindow(event)
      const shotIds = validateIngestIds(value)
      await flushDrafts()
      return organizationWrites.run(() => backendRequest('/api/workspace/cancel', {
        method: 'POST', body: JSON.stringify({ shotIds })
      }))
    })
    handle('workspace:eject', async (event, value: unknown) => {
      requireMainWindow(event)
      const shotIds = validateIngestIds(value)
      await flushDrafts()
      return organizationWrites.run(() => backendRequest('/api/workspace/eject', {
        method: 'POST', body: JSON.stringify({ shotIds })
      }))
    })
    handle('ingestion:status', event => { requireMainWindow(event); return backendRequest('/api/ingestion') })
    handle('library:list', event => { requireMainWindow(event); return backendRequest('/api/library') })
    handle('sync:choose-destination', async event => {
      const owner = requireMainWindow(event)
      const result = await dialog.showOpenDialog(owner, { title: 'Choose Export Destination', buttonLabel: 'Choose Destination', properties: ['openDirectory'] })
      if (result.canceled || !result.filePaths[0]) return null
      return backendRequest('/api/sync/destinations', { method: 'POST', body: JSON.stringify({ path: await realpath(result.filePaths[0]) }) })
    })
    for (const action of ['review', 'start'] as const) handle(`sync:${action}`, async (event, first: unknown, second: unknown) => {
      requireMainWindow(event)
      const shotIds = validateIngestIds(action === 'review' ? first : second)
      const token = action === 'review' ? second : first
      if (typeof token !== 'string' || !/^[a-f0-9-]{36}$/.test(token)) throw new Error('Invalid Export review or destination')
      await flushDrafts()
      return organizationWrites.run(() => backendRequest(`/api/sync/${action}`, { method: 'POST', body: JSON.stringify(action === 'review' ? { shotIds, destinationToken: token } : { shotIds, token }) }))
    })
    handle('library:vocabulary', event => { requireMainWindow(event); return backendRequest('/api/library/vocabulary') })
    handle('library:refresh', async event => { requireMainWindow(event); await flushDrafts(); return backendRequest('/api/library/refresh', { method: 'POST' }) })
    for (const action of ['review', 'revert'] as const) handle(`library:${action}`, async (event, value: unknown) => {
      requireMainWindow(event); const shotIds = validateIngestIds(value); await flushDrafts()
      return organizationWrites.run(() => backendRequest(`/api/library/${action}`, { method: 'POST', body: JSON.stringify({ shotIds }) }))
    })
    handle('library:commit', async (event, reviewToken: unknown, value: unknown) => {
      requireMainWindow(event); const shotIds = validateIngestIds(value)
      if (typeof reviewToken !== 'string' || reviewToken.length > 64) throw new Error('Invalid Library review')
      await flushDrafts()
      return backendRequest('/api/library/commit', { method: 'POST', body: JSON.stringify({ token: reviewToken, shotIds }) })
    })
    handle('library:delete-review', async (event, value: unknown) => {
      requireMainWindow(event); const shotIds = validateIngestIds(value)
      await flushDrafts()
      return organizationWrites.run(() => backendRequest('/api/library/delete/review', { method: 'POST', body: JSON.stringify({ shotIds }) }))
    })
    handle('library:delete', async (event, token: unknown, value: unknown) => {
      requireMainWindow(event); const shotIds = validateIngestIds(value)
      if (typeof token !== 'string' || !token || token.length > 64) throw new Error('Invalid Delete review')
      await flushDrafts()
      // Serialize with Cache clearing and location changes, as well as draft writes.
      return organizationWrites.run(() => backendRequest('/api/library/delete', { method: 'POST', body: JSON.stringify({ token, shotIds }) }))
    })
    handle('library:update', (event, value: unknown, action: OrganizationAction) => {
      requireMainWindow(event); const shotIds = validateIngestIds(value); const normalized = validateOrganizationAction(action)
      if (normalized.field === 'skip') throw new Error('Skip is only available in Import')
      const operation = () => backendRequest('/api/library/organization', { method: 'PATCH', body: JSON.stringify({ shotIds, action: normalized }) })
      if (normalized.field === 'notes' || normalized.field === 'scene' || normalized.field === 'group' || normalized.field === 'camera') return textWrites.schedule(`library:${normalized.field}:${shotIds.sort().join(',')}`, operation)
      void textWrites.flush().catch(() => undefined)
      return draftWrites.run(operation)
    })
    for (const asset of ['thumbnail', 'details', 'lut'] as const) handle(`library:${asset}`, async (event, id: unknown) => {
      requireMainWindow(event)
      if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) throw new Error('Invalid Library clip ID')
      const result = await backendRequest<{ dataUrl: string | null }>(`/api/library/${id}/${asset}`)
      return asset === 'thumbnail' ? result.dataUrl : result
    })
    handle('library:set-thumbnail', async (event, id: unknown, dataUrl: unknown) => {
      requireMainWindow(event)
      if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) throw new Error('Invalid Library clip ID')
      if (typeof dataUrl !== 'string' || dataUrl.length > 3000000 || !dataUrl.startsWith('data:image/jpeg;base64,')) throw new Error('Invalid thumbnail')
      await flushDrafts()
      return organizationWrites.run(() => backendRequest(`/api/library/${id}/thumbnail`, { method: 'PUT', body: JSON.stringify({ dataUrl }) }))
    })
    handle('ingestion:refresh-library', event => { requireMainWindow(event); return backendRequest('/api/work/refresh', { method: 'POST' }) })
    handle('ingestion:review', async (event, value: unknown, includeSynced: unknown = false) => {
      requireMainWindow(event)
      const shotIds = validateIngestIds(value)
      if (typeof includeSynced !== 'boolean') throw new Error('Invalid Commit scope')
      await flushDrafts()
      return backendRequest('/api/ingestion/review', { method: 'POST', body: JSON.stringify({ shotIds, includeSynced }) })
    })
    handle('ingestion:start', async (event, token: unknown, value: unknown) => {
      requireMainWindow(event)
      const shotIds = validateIngestIds(value)
      if (typeof token !== 'string' || token.length > 64) throw new Error('Invalid commit review')
      await flushDrafts()
      return backendRequest('/api/ingestion', { method: 'POST', body: JSON.stringify({ token, shotIds }) })
    })
    handle('work:stop', event => { requireMainWindow(event); return backendRequest('/api/work/stop', { method: 'POST' }) })
    handle('work:resume', event => { requireMainWindow(event); return backendRequest('/api/work/resume', { method: 'POST' }) })
    handle('ingestion:dismiss-error', (event, id: unknown) => {
      requireMainWindow(event)
      if (typeof id !== 'string' || !/^[a-zA-Z0-9-]{1,64}$/.test(id)) throw new Error('Invalid error ID')
      return backendRequest(`/api/ingestion/errors/${id}`, { method: 'DELETE' })
    })
    handle('organization:save-status', event => { requireMainWindow(event); return { ...draftWrites.status(), closing: quitting } })
    handle('organization:revert', async (event, value: unknown) => {
      requireMainWindow(event)
      const shotIds = validateIngestIds(value)
      await flushDrafts()
      return organizationWrites.run(() => backendRequest('/api/organization/revert', { method: 'POST', body: JSON.stringify({ shotIds }) }))
    })
    handle('organization:retry-saves', async event => {
      requireMainWindow(event)
      await textWrites.flush().catch(() => undefined)
      await draftWrites.retry()
    })
    handle('configuration:preview-options', async (event, value: unknown) => {
      requireMainWindow(event)
      const removals = validateOptionRemovals(value)
      await flushDrafts()
      return organizationWrites.run(() => backendRequest('/api/organization/vocabulary/preview', { method: 'POST', body: JSON.stringify(removals) }))
    })
    handle('configuration:save-options', async (event, value: unknown, reviewToken: unknown) => {
      requireMainWindow(event)
      const removals = validateOptionRemovals(value)
      await flushDrafts()
      if (typeof reviewToken !== 'string' || !/^[a-f0-9]{64}$/.test(reviewToken)) throw new Error('Invalid removal review.')
      return organizationWrites.run(() => backendRequest('/api/organization/vocabulary', {
        method: 'PATCH', body: JSON.stringify({ ...removals, reviewToken })
      }))
    })
    handle('local-data:summary', (event) => {
      requireMainWindow(event)
      return backendRequest('/api/local-data')
    })
    handle('local-data:clear', async (event, value: unknown) => {
      requireMainWindow(event)
      if (!value || typeof value !== 'object' || Array.isArray(value) ||
        ['metadata', 'thumbnails', 'fingerprints', 'proxies'].some(key => typeof (value as Record<string, unknown>)[key] !== 'boolean') ||
        ((value as Record<string, unknown>).catalogue !== undefined && typeof (value as Record<string, unknown>).catalogue !== 'boolean') ||
        Object.keys(value).some(key => !['metadata', 'thumbnails', 'fingerprints', 'proxies', 'catalogue'].includes(key)) ||
        !Object.values(value).some(Boolean)) throw new Error('Choose Cache files to clear.')
      await flushDrafts()
      return organizationWrites.run(async () => {
        const configuration = await readConfiguration(join(app.getPath('userData'), 'configuration.json'))
        const cache = await managedCacheLocation()
        const storage = cacheFiles(cache.root)
        await assertCacheReady(cache.parent, storage.root, cache.mount)
        const status = await backendRequest<{ active: boolean }>('/api/ingestion')
        if (status.active) throw new Error('Wait for the sync queue to finish before clearing Cache.')
        await backendRequest('/api/work/stop', { method: 'POST' })
        if ((value as CacheSelection).thumbnails) await backendRequest('/api/thumbnail-drafts', { method: 'DELETE' })
        const restore = await backendRequest<WorkspaceRestore>('/api/workspace/restore-plan')
        let clearError: unknown
        try {
          if (backend) {
            const previous = backend
            const exited = new Promise<void>(resolve => previous.once('exit', () => resolve()))
            previous.postMessage('shutdown')
            await exited
          }
          await assertCacheReady(cache.parent, storage.root, cache.mount)
          await clearSelectedCache(storage.root, value as CacheSelection, configuration.libraryPath)
        } catch (error) { clearError = error }
        finally { await startBackend() }
        await backendRequest('/api/workspace/restore', { method: 'POST', body: JSON.stringify(restore) })
        if (clearError) throw clearError
        return { configuration, collection: await backendRequest('/api/shots'), workspaceReset: true }
      })
    })
    handle('local-data:browse', async event => {
      requireMainWindow(event)
      const cache = await managedCacheLocation()
      await assertCacheReady(cache.parent, cache.root, cache.mount)
      await mkdir(cache.root, { recursive: true, mode: 0o700 })
      const error = await shell.openPath(cache.root)
      if (error) throw new Error(`Finder could not open Cache: ${error}`)
    })
    handle('local-data:inventory', async event => {
      requireMainWindow(event)
      const cache = await managedCacheLocation()
      await assertCacheReady(cache.parent, cache.root, cache.mount)
      return cacheInventory(cache.root)
    })
    handle('organization:flush-text', event => {
      requireMainWindow(event)
      return textWrites.flush()
    })
    handle('organization:vocabulary', (event) => {
      requireMainWindow(event)
      return backendRequest('/api/organization/vocabulary')
    })
    handle('organization:update', (event, shotIds: unknown, action: OrganizationAction) => {
      requireMainWindow(event)
      if (!Array.isArray(shotIds) || !shotIds.length || shotIds.length > 1000 || shotIds.some(id => typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id))) throw new Error('Invalid selection')
      const normalized = validateOrganizationAction(action)
      const operation = () => backendRequest('/api/organization', {
        method: 'PATCH', body: JSON.stringify({ shotIds, action: normalized })
      })
      if (normalized.field === 'notes' || normalized.field === 'scene' || normalized.field === 'group' || normalized.field === 'camera') return textWrites.schedule(`${normalized.field}:${[...new Set(shotIds)].sort().join(',')}`, operation)
      void textWrites.flush().catch(() => undefined)
      return draftWrites.run(operation)
    })
    const configurationPath = join(app.getPath('userData'), 'configuration.json')
    handle('configuration:get', (event) => {
      requireMainWindow(event)
      return readConfiguration(configurationPath)
    })
    const locationChoices = new Map<string, { token: string; location: LibraryLocation; baseline: string }>()
    for (const kind of ['library'] as const) handle(`configuration:choose-${kind}`, async event => {
      const owner = requireMainWindow(event)
      if (choosingLibrary) return null
      choosingLibrary = true
      try {
        const current = await readConfiguration(configurationPath)
        const currentPath = current.libraryPath
        const result = await dialog.showOpenDialog(owner, {
          title: 'Set Library Location',
          buttonLabel: 'Set Library',
          ...(currentPath ? { defaultPath: currentPath } : {}), properties: ['openDirectory']
        })
        if (result.canceled || !result.filePaths[0]) return null
        const location = await inspectLibrary(await realpath(result.filePaths[0]))
        const choice = { token: randomBytes(24).toString('hex'), location, baseline: JSON.stringify(current) }
        locationChoices.set(kind, choice)
        return { token: choice.token, path: location.path }
      } finally { choosingLibrary = false }
    })
    handle('configuration:save-locations', async (event, changes: unknown) => {
      requireMainWindow(event)
      if (!changes || typeof changes !== 'object' || Array.isArray(changes) ||
        !Object.keys(changes).length || Object.keys(changes).some(key => key !== 'library' && key !== 'storageWaitSeconds')) throw new Error('Invalid configuration changes.')
      await flushDrafts()
      return organizationWrites.run(async () => {
        const current = await readConfiguration(configurationPath)
        const next = { ...current }
        if ('storageWaitSeconds' in changes) next.storageWaitSeconds = storageWaitSeconds((changes as Record<string, unknown>).storageWaitSeconds)
        const selected = []
        for (const kind of ['library'] as const) {
          if (!(kind in changes)) continue
          if ((changes as Record<string, unknown>)[kind] === null) {
            next.libraryPath = null; delete next.libraryMount
            selected.push(kind)
            continue
          }
          const choice = locationChoices.get(kind)
          if (!choice || choice.token !== (changes as Record<string, unknown>)[kind]) throw new Error('Choose the location again before saving.')
          if (choice.baseline !== JSON.stringify(current)) throw new Error('Configuration changed. Close Configuration and choose the locations again.')
          const location = await inspectLibrary(choice.location.path)
          if (location.identity !== choice.location.identity || location.mount !== choice.location.mount) throw new Error('The selected folder or volume changed. Choose it again.')
          next.libraryPath = location.path; next.libraryMount = location.mount
          selected.push(kind)
        }
        const workspace = await backendRequest<{ shots: { filePath: string }[] }>('/api/shots')
        const sourcePaths = [...new Set(workspace.shots.map(shot => dirname(shot.filePath)))]
        if (next.libraryPath) await inspectLibrary(next.libraryPath, sourcePaths)
        const status = await backendRequest<{ active: boolean; stopping: boolean; work?: { paused: boolean } }>('/api/ingestion')
        if (status.active || status.stopping) throw new Error('Wait for the sync queue to finish or stop it before saving locations.')
        const wasPaused = status.work?.paused === true
        await backendRequest('/api/work/stop', { method: 'POST' })
        try { await saveConfiguration(configurationPath, next) }
        catch (error) {
          if (!wasPaused) await backendRequest('/api/work/resume', { method: 'POST' }).catch(() => undefined)
          throw error
        }
        for (const kind of selected) locationChoices.delete(kind)
        try {
          await backendRequest('/api/ingestion/library/refresh', { method: 'POST' })
          if (!wasPaused) await backendRequest('/api/work/resume', { method: 'POST' })
          return { configuration: next }
        } catch (error) {
          return { configuration: next, warning: `Locations saved, but background work could not refresh. Use Refresh to resume. ${error instanceof Error ? error.message : String(error)}` }
        }
      })
    })
    handle('cache:summary', (event) => {
      requireMainWindow(event)
      return backendRequest('/api/cache')
    })
    handle('cache:clear', (event) => {
      requireMainWindow(event)
      return backendRequest('/api/cache', { method: 'DELETE' })
    })
    protocol.handle('shot-media', async (request) => {
      const url = new URL(request.url)
      const match = /^\/(shots|library)\/([a-f0-9]{64})\/original$/.exec(url.pathname)
      if (url.hostname !== 'local' || url.search || !match || !['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 404 })
      if (quitting || !backendURL) return new Response(null, { status: 503 })
      const headers = new Headers({ Authorization: `Bearer ${token}` })
      const range = request.headers.get('range')
      if (range) headers.set('Range', range)
      try {
        const response = await fetch(`${backendURL}/api/${match[1]}/${match[2]}/media/original`, {
          method: request.method, headers, signal: AbortSignal.any([request.signal, mediaShutdown.signal])
        })
        const responseHeaders = new Headers(response.headers)
        responseHeaders.set('Access-Control-Allow-Origin', '*')
        return new Response(response.body, { status: response.status, headers: responseHeaders })
      } catch { return new Response(null, { status: 503 }) }
    })
    handle('shots:lut', async (event, id: unknown) => {
      requireMainWindow(event)
      if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) throw new Error('Invalid shot ID')
      return backendRequest(`/api/shots/${id}/lut`)
    })
    handle('shots:details', async (event, id: unknown) => {
      requireMainWindow(event)
      if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) throw new Error('Invalid shot ID')
      return backendRequest(`/api/shots/${id}/details`)
    })
    handle('shots:list', async (event) => {
      requireMainWindow(event)
      return backendRequest('/api/shots')
    })
    handle('shots:thumbnail', async (event, id: unknown) => {
      requireMainWindow(event)
      if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) throw new Error('Invalid shot ID')
      const result = await backendRequest<{ dataUrl: string | null }>(`/api/shots/${id}/thumbnail`)
      return result.dataUrl
    })
    handle('shots:set-thumbnail', async (event, id: unknown, dataUrl: unknown) => {
      requireMainWindow(event)
      if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) throw new Error('Invalid shot ID')
      if (typeof dataUrl !== 'string' || dataUrl.length > 3000000 || !dataUrl.startsWith('data:image/jpeg;base64,')) throw new Error('Invalid thumbnail')
      await backendRequest(`/api/shots/${id}/thumbnail`, { method: 'PUT', body: JSON.stringify({ dataUrl }) })
    })
    handle('workspace:drop', async (event, path: unknown) => {
      requireMainWindow(event)
      await assertSourceAddingReady()
      if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0')) {
        throw new Error('Drop a video file or folder from your computer')
      }
      await flushDrafts()
      return backendRequest('/api/workspace/discover', { method: 'POST', body: JSON.stringify({ path }) })
    })
    handle('workspace:choose', async (event) => {
      const owner = requireMainWindow(event)
      await assertSourceAddingReady()
      if (choosingSource) return null
      choosingSource = true
      try {
        const result = await dialog.showOpenDialog(owner, {
          title: 'Add Clips',
          buttonLabel: 'Add Clips',
          message: 'Choose the root of a mounted card, or a folder containing video files.',
          properties: ['openDirectory']
        })
        if (result.canceled || !result.filePaths[0]) return null
        await flushDrafts()
        return await backendRequest('/api/workspace/discover', { method: 'POST', body: JSON.stringify({ path: result.filePaths[0] }) })
      } finally {
        choosingSource = false
      }
    })
    handle('backend:status', async (event): Promise<BackendStatus> => {
      requireMainWindow(event)
      if (!backendURL) return { state: backendState, message: backendState === 'starting' ? 'Starting backend…' : 'Backend stopped. Relaunch the app to reconnect.' }
      try {
        const response = await fetch(`${backendURL}/api/health`, {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(2000)
        })
        if (!response.ok) throw new Error(`Health check failed (${response.status})`)
        const health = await response.json() as BackendHealth
        let application: ApplicationStatus
        try {
          application = await backendRequest<ApplicationStatus>('/api/application-status')
        } catch {
          application = { level: 'error', message: 'Status Unavailable', detail: 'Could not check application status. The app will retry shortly.' }
        }
        return { state: 'connected', health, application }
      } catch {
        return { state: 'unavailable', message: 'Backend is not responding.' }
      }
    })
    void startBackend().catch(error => {
      backendState = 'unavailable'
      console.error('Backend could not start.', error)
    })
    createWindow()
    app.on('activate', () => { if (!mainWindow) createWindow() })
  }).catch((error: unknown) => {
    console.error(error)
    app.quit()
  })

  app.on('window-all-closed', () => app.quit())
  app.on('before-quit', (event) => {
    if (shutdownComplete) return
    event.preventDefault()
    if (quitting) return
    quitting = true
    publishSaveStatus()
    void (async () => {
      await textWrites.flush().catch(() => undefined)
      await Promise.allSettled([...pendingIPC])
      await organizationWrites.drain()
      while (draftWrites.status().failed) {
        const choice = await dialog.showMessageBox({
          type: 'warning', title: 'Unsaved changes',
          message: 'Some clip changes could not be saved.',
          detail: 'Keep working to review them, retry saving, or explicitly discard them before quitting.',
          buttons: ['Keep Working', 'Retry Saves', 'Quit Without Saving'], defaultId: 0, cancelId: 0
        })
        if (choice.response === 0) { quitting = false; publishSaveStatus(); return }
        if (choice.response === 2) { draftWrites.discard(); break }
        await draftWrites.retry().catch(() => undefined)
      }
      // Accepted edits have settled successfully or were explicitly discarded.
      mediaShutdown.abort()
      backendStopping = true
      publishSaveStatus()
      if (!backend) { shutdownComplete = true; mainWindow?.destroy(); app.quit(); return }
      backend.postMessage('shutdown')
      setTimeout(() => {
        backend?.kill()
        shutdownComplete = true
        app.exit(0)
      }, 10000).unref()
    })().catch(error => { console.error(error); quitting = false; publishSaveStatus() })
  })
  process.on('SIGINT', () => app.quit())
  process.on('SIGTERM', () => app.quit())
}
