import { readConfiguration } from '../desktop/configuration';
import { ApplicationMonitor } from './applicationStatus';
import { assertCacheReady, pruneManagedCache } from './cacheFiles';
import { inspectLibrary } from './library';
import { ProxyQueue } from './proxies';
import { rsyncFile } from './rsync';
import { IngestQueue } from './ingestion';
import Fastify from 'fastify'
import type { AppConfiguration, BackendHealth } from '../shared/desktop'
import type { IngestStatus } from '../shared/ingestion';
import type { ShotChange } from '../shared/shots'
import { SourceRegistry } from './sources'
import { pruneThumbnailCache } from './thumbnails'
import { sendVideo } from './media'
import { viewingProfile } from '../shared/viewing'
import { loadViewingLut } from './viewing'
import { validateOptionRemovals, validateOrganizationAction } from '../shared/organization'
import type { OrganizationAction, TagVocabulary } from '../shared/organization'

export function createServer(token: string, onShotsChanged?: (change: ShotChange) => void, thumbnailCacheDirectory?: string, fingerprintDirectory?: string, organizationFile?: string, configurationFile?: string, onIngestChanged?: (status: IngestStatus) => void) {
  const server = Fastify({ logger: true })
  const configuration = async (): Promise<AppConfiguration> => {
    const saved = configurationFile ? await readConfiguration(configurationFile) : { version: 1 as const, libraryPath: null }
    return process.env.SHOT_MANAGER_CACHE_PARENT && process.env.SHOT_MANAGER_CACHE_MOUNT
      ? { ...saved, scratchPath: process.env.SHOT_MANAGER_CACHE_PARENT, scratchMount: process.env.SHOT_MANAGER_CACHE_MOUNT }
      : saved
  }
  const cacheRoot = process.env.SHOT_MANAGER_CACHE_ROOT
  const assertWritable = cacheRoot && process.env.SHOT_MANAGER_CACHE_PARENT && process.env.SHOT_MANAGER_CACHE_MOUNT
    ? () => assertCacheReady(process.env.SHOT_MANAGER_CACHE_PARENT!, cacheRoot, process.env.SHOT_MANAGER_CACHE_MOUNT!) : undefined
  const sources = new SourceRegistry(thumbnailCacheDirectory, fingerprintDirectory, organizationFile, assertWritable)
  const proxies = new ProxyQueue(sources.scanner, configuration)
  const application = new ApplicationMonitor(configuration, () => sources.list(), () => proxies.status().error)
  const ingestion = new IngestQueue(sources.scanner, async () => (await configuration()).libraryPath, async (path, roots) => {
    const configured = await configuration()
    if (!configured.libraryMount) throw new Error('Choose the Library location again in Configuration to confirm its volume.')
    const location = await inspectLibrary(path, roots)
    if (configured.libraryPath !== path || configured.libraryMount !== location.mount) throw new Error('The configured Library volume is not mounted at its expected location. Choose the Library again if it has changed.')
    return location
  }, rsyncFile, proxies)
  ingestion.onChange = onIngestChanged
  const ids = { type: 'array', minItems: 1, maxItems: 1000, uniqueItems: true, items: { type: 'string', pattern: '^[a-f0-9]{64}$' } }
  server.post<{ Body: { shotIds: string[] } }>('/api/organization/revert', {
    schema: { body: { type: 'object', required: ['shotIds'], additionalProperties: false, properties: { shotIds: ids } } }
  }, async request => {
    try { return await ingestion.revert(request.body.shotIds) }
    catch (error) { throw Object.assign(error as Error, { statusCode: 409 }) }
  })
  server.get('/api/ingestion', () => ingestion.status())
  server.post('/api/ingestion/library/refresh', () => { application.invalidate(); return ingestion.refreshLibrary() })
  server.post<{ Body: { shotIds: string[] } }>('/api/ingestion/review', {
    schema: { body: { type: 'object', required: ['shotIds'], additionalProperties: false, properties: { shotIds: ids } } }
  }, async request => {
    try { return await ingestion.preview(request.body.shotIds) }
    catch (error) { throw Object.assign(error as Error, { statusCode: 409 }) }
  })
  server.post<{ Body: { token: string; shotIds: string[] } }>('/api/ingestion', {
    schema: { body: { type: 'object', required: ['token', 'shotIds'], additionalProperties: false,
      properties: { shotIds: ids, token: { type: 'string', maxLength: 64 } } } }
  }, async request => {
    try { return await ingestion.submit(request.body.token, request.body.shotIds) }
    catch (error) { throw Object.assign(error as Error, { statusCode: 409 }) }
  })
  server.post('/api/ingestion/stop', () => ingestion.cancelSync())
  server.post('/api/work/stop', () => ingestion.stop())
  server.post('/api/work/refresh', () => ingestion.refreshWork())
  server.delete<{ Params: { id: string } }>('/api/ingestion/errors/:id', {
    schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'string', maxLength: 64 } } } }
  }, (request, reply) => { ingestion.dismissError(request.params.id); return reply.code(204).send() })
  server.post('/api/work/resume', () => ingestion.resume())
  server.post('/api/work/configure', () => { if (!proxies.status().paused) proxies.resume(); else proxies.schedule(); return ingestion.status() })
  sources.scanner.onChange = change => { onShotsChanged?.(change); proxies.schedule(); ingestion.backgroundChanged() }
  server.addHook('onReady', async () => { sources.startMonitoring(); void ingestion.status().catch(error => server.log.warn(error)) })

  if (thumbnailCacheDirectory && !cacheRoot) {
    server.addHook('onClose', async () => {
      await ingestion.close()
      try {
        await assertWritable?.()
        const result = await pruneThumbnailCache(thumbnailCacheDirectory)
        if (result.removed) server.log.info({ removed: result.removed }, 'Expired thumbnail cache files removed')
        if (result.failed) server.log.warn({ failed: result.failed }, 'Some expired thumbnail cache files could not be removed')
      } catch (error) {
        server.log.warn({ err: error }, 'Thumbnail cache cleanup failed')
      }
    })
  }

  server.addHook('onRequest', async (request, reply) => {
    if (request.headers.authorization !== `Bearer ${token}`) {
      await reply.code(401).send({ error: 'Unauthorized' })
    }
  })

  server.get('/api/health', async (): Promise<BackendHealth> => ({
    status: 'ok',
    service: 'shot-manager-backend',
    mode: 'development-only'
  }))

  server.get('/api/sources', () => sources.list())
  server.get('/api/application-status', () => application.status())
  server.get('/api/organization/vocabulary', () => sources.scanner.vocabulary())
  const optionProperties = Object.fromEntries(['identity', 'project', 'tags'].map(field => [field, {
    type: 'array', maxItems: 1000, items: { type: 'string', maxLength: 128 }
  }]))
  server.post<{ Body: TagVocabulary }>('/api/organization/vocabulary/preview', {
    schema: { body: { type: 'object', required: ['identity', 'project', 'tags'], additionalProperties: false, properties: optionProperties } }
  }, request => {
    let removals: TagVocabulary
    try { removals = validateOptionRemovals(request.body) }
    catch (error) { throw Object.assign(error as Error, { statusCode: 400 }) }
    return sources.previewOptions(removals)
  })
  server.patch<{ Body: TagVocabulary & { reviewToken: string } }>('/api/organization/vocabulary', {
    schema: { body: { type: 'object', required: ['identity', 'project', 'tags', 'reviewToken'], additionalProperties: false,
      properties: { ...optionProperties, reviewToken: { type: 'string', pattern: '^[a-f0-9]{64}$' } } } }
  }, request => {
    const { reviewToken, ...values } = request.body
    let removals: TagVocabulary
    try { removals = validateOptionRemovals(values) }
    catch (error) { throw Object.assign(error as Error, { statusCode: 400 }) }
    return sources.saveOptions(removals, reviewToken)
  })
  server.patch<{ Body: { shotIds: string[]; action: OrganizationAction } }>('/api/organization', {
    schema: { body: { type: 'object', required: ['shotIds', 'action'], additionalProperties: false, properties: {
      shotIds: { type: 'array', minItems: 1, maxItems: 1000, items: { type: 'string', pattern: '^[a-f0-9]{64}$' } },
      action: { type: 'object', required: ['field', 'operation', 'value'], additionalProperties: false, properties: {
        field: { type: 'string', enum: ['identity', 'project', 'scene', 'tags', 'notes', 'skip', 'all'] },
        operation: { type: 'string', enum: ['add', 'remove', 'set', 'clear'] }, value: { type: 'string', maxLength: 10000 }
      } }
    } } }
  }, (request) => {
    let action: OrganizationAction
    try { action = validateOrganizationAction(request.body.action) }
    catch (error) { throw Object.assign(error as Error, { statusCode: 400 }) }
    return sources.scanner.updateOrganization(request.body.shotIds, action)
  })
  server.post<{ Params: { id: string }; Body: { path: string } }>('/api/sources/:id/relink', {
    schema: {
      params: { type: 'object', required: ['id'], additionalProperties: false, properties: { id: { type: 'string', pattern: '^[a-zA-Z0-9-]+$' } } },
      body: { type: 'object', required: ['path'], additionalProperties: false, properties: { path: { type: 'string', minLength: 1 } } }
    }
  }, (request) => sources.relink(request.params.id, request.body.path))
  server.get('/api/cache', () => sources.scanner.cacheSummary())
  server.delete('/api/cache', () => sources.scanner.clearCache())
  server.get('/api/local-data', () => sources.localDataSummary())
  server.delete('/api/local-data', {
    schema: { body: { type: 'object', required: ['confirm'], additionalProperties: false,
      properties: { confirm: { type: 'boolean', const: true } } } }
  }, async () => {
    sources.scanner.assertNoIngestion()
    const paused = proxies.status().paused
    await proxies.stop()
    try { return await sources.clearLocalData() }
    finally { if (!paused) proxies.resume() }
  })
  server.post<{ Params: { id: string } }>('/api/sources/:id/refresh', (request) => sources.refresh(request.params.id))
  server.get('/api/shots', () => sources.scanner.snapshot())
  server.get<{ Params: { id: string } }>('/api/shots/:id/lut', async (request) => {
    const details = await sources.scanner.details(request.params.id)
    const profile = viewingProfile(details.metadata)
    return profile ? loadViewingLut(profile) : null
  })
  server.get<{ Params: { id: string } }>('/api/shots/:id/details', (request) => sources.scanner.details(request.params.id))
  server.get<{ Params: { id: string } }>('/api/shots/:id/media/original', {
    schema: { params: { type: 'object', required: ['id'], properties: {
      id: { type: 'string', pattern: '^[a-f0-9]{64}$' }
    } } }
  }, async (request, reply) => {
    const asset = await sources.scanner.openVideo(request.params.id)
    return sendVideo(request, reply, asset.file, asset.path)
  })
  server.get<{ Params: { id: string } }>('/api/shots/:id/thumbnail', async (request) => ({
    dataUrl: await sources.scanner.thumbnail(request.params.id)
  }))
  server.put<{ Params: { id: string }; Body: { dataUrl: string } }>('/api/shots/:id/thumbnail', {
    bodyLimit: 3000100,
    schema: {
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: '^[a-f0-9]{64}$' } } },
      body: { type: 'object', required: ['dataUrl'], additionalProperties: false, properties: {
        dataUrl: { type: 'string', maxLength: 3000000, pattern: '^data:image/jpeg;base64,' }
      } }
    }
  }, async (request, reply) => {
    await sources.scanner.setThumbnail(request.params.id, request.body.dataUrl)
    return reply.code(204).send()
  })
  server.addHook('onClose', async () => {
    const activeClipIds = new Set(sources.scanner.snapshot().shots.map(shot => shot.id))
    await ingestion.close(); await proxies.close(); await sources.close()
    if (cacheRoot) {
      try {
        await assertWritable?.()
        const result = await pruneManagedCache(cacheRoot, 90, Date.now(), activeClipIds)
        if (result.removed) server.log.info({ removed: result.removed }, 'Expired Cache files removed')
        if (result.failed) server.log.warn({ failed: result.failed }, 'Some expired Cache files could not be removed')
      } catch (error) { server.log.warn({ err: error }, 'Cache retention cleanup failed') }
    }
  })
  server.post<{ Body: { path: string } }>('/api/sources', {
    schema: { body: { type: 'object', required: ['path'], additionalProperties: false, properties: { path: { type: 'string', minLength: 1 } } } }
  }, (request) => sources.add(request.body.path))
  server.delete<{ Params: { id: string } }>('/api/sources/:id', async (request, reply) => {
    await sources.remove(request.params.id)
    return reply.code(204).send()
  })

  return server
}
