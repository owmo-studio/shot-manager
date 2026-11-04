import { app, BrowserWindow, dialog, ipcMain, protocol, utilityProcess } from 'electron'
import type { IpcMainInvokeEvent, UtilityProcess } from 'electron'
import { randomBytes } from 'node:crypto'
import { isAbsolute, join } from 'node:path'
import { realpath, stat } from 'node:fs/promises'
import { readConfiguration, saveConfiguration } from './configuration'
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

protocol.registerSchemesAsPrivileged([
  { scheme: 'shot-media', privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true, corsEnabled: true } }
])

async function backendRequest(path: string, options: RequestInit = {}) {
  if (!backendURL) throw new Error('Backend is not ready')
  const response = await fetch(`${backendURL}${path}`, {
    ...options,
    headers: {
      ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      Authorization: `Bearer ${token}`
    },
    signal: AbortSignal.timeout(15000)
  })
  if (!response.ok) throw new Error(`Backend request failed (${response.status})`)
  if (response.status !== 204) return response.json()
}

function requireMainWindow(event: IpcMainInvokeEvent): BrowserWindow {
  if (!mainWindow || event.sender !== mainWindow.webContents ||
      event.senderFrame !== mainWindow.webContents.mainFrame) {
    throw new Error('Untrusted sender')
  }
  return mainWindow
}

function startBackend() {
  backend = utilityProcess.fork(join(__dirname, 'backend.cjs'), [], {
    serviceName: 'Shot Manager Backend',
    env: { ...process.env, SHOT_MANAGER_TOKEN: token, SHOT_MANAGER_THUMBNAIL_CACHE: join(app.getPath('userData'), 'cache', 'thumbnails'), SHOT_MANAGER_FINGERPRINT_DIRECTORY: join(app.getPath('userData'), 'fingerprints'), SHOT_MANAGER_LUT_DIRECTORY: join(app.getAppPath(), 'resources', 'luts') }
  })
  backend.on('message', (message: unknown) => {
    if (typeof message === 'object' && message !== null && 'type' in message &&
        message.type === 'shots:changed' && 'collection' in message) {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('shots:changed', message.collection)
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
    if (quitting) {
      shutdownComplete = true
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
    const configurationPath = join(app.getPath('userData'), 'configuration.json')
    ipcMain.handle('configuration:get', (event) => {
      requireMainWindow(event)
      return readConfiguration(configurationPath)
    })
    ipcMain.handle('configuration:choose-library', async (event) => {
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
    ipcMain.handle('cache:summary', (event) => {
      requireMainWindow(event)
      return backendRequest('/api/cache')
    })
    ipcMain.handle('cache:clear', (event) => {
      requireMainWindow(event)
      return backendRequest('/api/cache', { method: 'DELETE' })
    })
    protocol.handle('shot-media', async (request) => {
      const url = new URL(request.url)
      const match = /^\/shots\/([a-f0-9]{64})\/original$/.exec(url.pathname)
      if (url.hostname !== 'local' || url.search || !match || !['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 404 })
      if (!backendURL) return new Response(null, { status: 503 })
      const headers = new Headers({ Authorization: `Bearer ${token}` })
      const range = request.headers.get('range')
      if (range) headers.set('Range', range)
      try {
        const response = await fetch(`${backendURL}/api/shots/${match[1]}/media/original`, {
          method: request.method, headers, signal: request.signal
        })
        const responseHeaders = new Headers(response.headers)
        responseHeaders.set('Access-Control-Allow-Origin', '*')
        return new Response(response.body, { status: response.status, headers: responseHeaders })
      } catch { return new Response(null, { status: 503 }) }
    })
    ipcMain.handle('shots:lut', async (event, id: unknown) => {
      requireMainWindow(event)
      if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) throw new Error('Invalid shot ID')
      return backendRequest(`/api/shots/${id}/lut`)
    })
    ipcMain.handle('shots:details', async (event, id: unknown) => {
      requireMainWindow(event)
      if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) throw new Error('Invalid shot ID')
      return backendRequest(`/api/shots/${id}/details`)
    })
    ipcMain.handle('shots:list', async (event) => {
      requireMainWindow(event)
      return backendRequest('/api/shots')
    })
    ipcMain.handle('shots:thumbnail', async (event, id: unknown) => {
      requireMainWindow(event)
      if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) throw new Error('Invalid shot ID')
      const result = await backendRequest(`/api/shots/${id}/thumbnail`)
      return result.dataUrl
    })
    ipcMain.handle('shots:set-thumbnail', async (event, id: unknown, dataUrl: unknown) => {
      requireMainWindow(event)
      if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) throw new Error('Invalid shot ID')
      if (typeof dataUrl !== 'string' || dataUrl.length > 3000000 || !dataUrl.startsWith('data:image/jpeg;base64,')) throw new Error('Invalid thumbnail')
      await backendRequest(`/api/shots/${id}/thumbnail`, { method: 'PUT', body: JSON.stringify({ dataUrl }) })
    })
    ipcMain.handle('sources:refresh', async (event, id: unknown) => {
      requireMainWindow(event)
      if (typeof id !== 'string' || !/^[a-zA-Z0-9-]+$/.test(id)) throw new Error('Invalid source ID')
      return backendRequest(`/api/sources/${encodeURIComponent(id)}/refresh`, { method: 'POST' })
    })
    ipcMain.handle('sources:relink', async (event, id: unknown) => {
      const owner = requireMainWindow(event)
      if (typeof id !== 'string' || !/^[a-zA-Z0-9-]+$/.test(id)) throw new Error('Invalid source ID')
      if (choosingSource) return null
      choosingSource = true
      try {
        const result = await dialog.showOpenDialog(owner, {
          title: 'Re-link Source', buttonLabel: 'Re-link Source', properties: ['openDirectory']
        })
        if (result.canceled || !result.filePaths[0]) return null
        return await backendRequest(`/api/sources/${encodeURIComponent(id)}/relink`, {
          method: 'POST', body: JSON.stringify({ path: result.filePaths[0] })
        })
      } finally { choosingSource = false }
    })
    ipcMain.handle('sources:list', async (event) => {
      requireMainWindow(event)
      return backendRequest('/api/sources')
    })
    ipcMain.handle('sources:drop', async (event, path: unknown) => {
      requireMainWindow(event)
      if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0')) {
        throw new Error('Drop a folder from your computer')
      }
      return backendRequest('/api/sources', { method: 'POST', body: JSON.stringify({ path }) })
    })
    ipcMain.handle('sources:remove', async (event, id: unknown) => {
      requireMainWindow(event)
      if (typeof id !== 'string' || !/^[a-zA-Z0-9-]+$/.test(id)) throw new Error('Invalid source ID')
      await backendRequest(`/api/sources/${encodeURIComponent(id)}`, { method: 'DELETE' })
    })
    ipcMain.handle('sources:choose', async (event) => {
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
        return await backendRequest('/api/sources', { method: 'POST', body: JSON.stringify({ path: result.filePaths[0] }) })
      } finally {
        choosingSource = false
      }
    })
    ipcMain.handle('backend:status', async (event): Promise<BackendStatus> => {
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
    if (shutdownComplete || !backend) return
    event.preventDefault()
    if (quitting) return
    quitting = true
    backend.postMessage('shutdown')
    setTimeout(() => backend?.kill(), 3000).unref()
  })
  process.on('SIGINT', () => app.quit())
  process.on('SIGTERM', () => app.quit())
}
