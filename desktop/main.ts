import { app, BrowserWindow, dialog, ipcMain, protocol, utilityProcess } from 'electron'
import type { IpcMainInvokeEvent, UtilityProcess } from 'electron'
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { realpath, stat } from 'node:fs/promises'
import { readConfiguration, saveConfiguration } from './configuration'
import { validateOptionRemovals, validateOrganizationAction } from '../shared/organization'
import type { OrganizationAction } from '../shared/organization'
import { DebouncedWrites, RetainedWrites, WriteQueue } from './writeQueue'
import { installApplicationMenu } from './menu'
import { requestBackend } from './backendRequest'
import { AppError, errorDetails } from '../shared/errors'
import type { BackendHealth, BackendStatus } from '../shared/desktop'

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

function startBackend() {
  const sourceLuts = join(app.getAppPath(), 'resources', 'luts')
  const lutDirectory = existsSync(sourceLuts) ? sourceLuts : join(__dirname, '..', 'resources', 'luts')
  backend = utilityProcess.fork(join(__dirname, 'backend.cjs'), [], {
    serviceName: 'Shot Manager Backend',
    env: { ...process.env, SHOT_MANAGER_TOKEN: token, SHOT_MANAGER_THUMBNAIL_CACHE: join(app.getPath('userData'), 'cache', 'thumbnails'), SHOT_MANAGER_FINGERPRINT_DIRECTORY: join(app.getPath('userData'), 'fingerprints'), SHOT_MANAGER_ORGANIZATION_FILE: join(app.getPath('userData'), 'organization.json'), SHOT_MANAGER_LUT_DIRECTORY: lutDirectory }
  })
  backend.on('message', (message: unknown) => {
    if (typeof message === 'object' && message !== null && 'type' in message &&
        message.type === 'shots:changed' && 'change' in message) {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('shots:changed', message.change)
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
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault())
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
    handle('organization:save-status', event => { requireMainWindow(event); return { ...draftWrites.status(), closing: quitting } })
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
    handle('local-data:clear', async (event) => {
      requireMainWindow(event)
      await flushDrafts()
      return organizationWrites.run(() => backendRequest('/api/local-data', { method: 'DELETE', body: JSON.stringify({ confirm: true }) }))
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
      if (normalized.field === 'notes' || normalized.field === 'scene') return textWrites.schedule(`${normalized.field}:${[...new Set(shotIds)].sort().join(',')}`, operation)
      void textWrites.flush().catch(() => undefined)
      return draftWrites.run(operation)
    })
    const configurationPath = join(app.getPath('userData'), 'configuration.json')
    handle('configuration:get', (event) => {
      requireMainWindow(event)
      return readConfiguration(configurationPath)
    })
    handle('configuration:choose-library', async (event) => {
      const owner = requireMainWindow(event)
      if (choosingLibrary) return null
      choosingLibrary = true
      try {
        const current = await readConfiguration(configurationPath)
        const result = await dialog.showOpenDialog(owner, {
          title: 'Set Library Location', buttonLabel: 'Set Library',
          ...(current.libraryPath ? { defaultPath: current.libraryPath } : {}),
          properties: ['openDirectory']
        })
        if (result.canceled || !result.filePaths[0]) return null
        const libraryPath = await realpath(result.filePaths[0])
        if (!(await stat(libraryPath)).isDirectory()) throw new Error('Choose a folder')
        const next = { ...current, libraryPath }
        await saveConfiguration(configurationPath, next)
        return next
      } finally { choosingLibrary = false }
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
      const match = /^\/shots\/([a-f0-9]{64})\/original$/.exec(url.pathname)
      if (url.hostname !== 'local' || url.search || !match || !['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 404 })
      if (quitting || !backendURL) return new Response(null, { status: 503 })
      const headers = new Headers({ Authorization: `Bearer ${token}` })
      const range = request.headers.get('range')
      if (range) headers.set('Range', range)
      try {
        const response = await fetch(`${backendURL}/api/shots/${match[1]}/media/original`, {
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
    handle('sources:refresh', async (event, id: unknown) => {
      requireMainWindow(event)
      if (typeof id !== 'string' || !/^[a-zA-Z0-9-]+$/.test(id)) throw new Error('Invalid source ID')
      await flushDrafts()
      return backendRequest(`/api/sources/${encodeURIComponent(id)}/refresh`, { method: 'POST' })
    })
    handle('sources:relink', async (event, id: unknown) => {
      const owner = requireMainWindow(event)
      if (typeof id !== 'string' || !/^[a-zA-Z0-9-]+$/.test(id)) throw new Error('Invalid source ID')
      if (choosingSource) return null
      choosingSource = true
      try {
        const result = await dialog.showOpenDialog(owner, {
          title: 'Re-link Source', buttonLabel: 'Re-link Source', properties: ['openDirectory']
        })
        if (result.canceled || !result.filePaths[0]) return null
        await flushDrafts()
        return await backendRequest(`/api/sources/${encodeURIComponent(id)}/relink`, {
          method: 'POST', body: JSON.stringify({ path: result.filePaths[0] })
        })
      } finally { choosingSource = false }
    })
    handle('sources:list', async (event) => {
      requireMainWindow(event)
      return backendRequest('/api/sources')
    })
    handle('sources:drop', async (event, path: unknown) => {
      requireMainWindow(event)
      if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0')) {
        throw new Error('Drop a folder from your computer')
      }
      await flushDrafts()
      return backendRequest('/api/sources', { method: 'POST', body: JSON.stringify({ path }) })
    })
    handle('sources:remove', async (event, id: unknown) => {
      requireMainWindow(event)
      if (typeof id !== 'string' || !/^[a-zA-Z0-9-]+$/.test(id)) throw new Error('Invalid source ID')
      await flushDrafts()
      await backendRequest(`/api/sources/${encodeURIComponent(id)}`, { method: 'DELETE' })
    })
    handle('sources:choose', async (event) => {
      const owner = requireMainWindow(event)
      if (choosingSource) return null
      choosingSource = true
      try {
        const result = await dialog.showOpenDialog(owner, {
          title: 'Add Source',
          buttonLabel: 'Add Source',
          message: 'Choose the root of a mounted card, or a folder containing video files.',
          properties: ['openDirectory']
        })
        if (result.canceled || !result.filePaths[0]) return null
        await flushDrafts()
        return await backendRequest('/api/sources', { method: 'POST', body: JSON.stringify({ path: result.filePaths[0] }) })
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
        return { state: 'connected', health }
      } catch {
        return { state: 'unavailable', message: 'Backend is not responding.' }
      }
    })
    startBackend()
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
