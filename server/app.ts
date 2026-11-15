import { readConfiguration } from '../desktop/configuration';
import { ApplicationMonitor } from './applicationStatus';
import { assertCacheReady, pruneManagedCache } from './cacheFiles';
import { inspectLibrary } from './library';
import { ProxyQueue } from './proxies';
import { rsyncFile } from './rsync';
import { IngestQueue } from './ingestion';
import { LibraryCatalogue } from './catalogue';
import { LibrarySync } from './sync';
import { dirname, join } from 'node:path';
import Fastify from 'fastify'
import type { AppConfiguration, BackendHealth } from '../shared/desktop'
import type { IngestStatus } from '../shared/ingestion';
import type { ShotChange, WorkspaceRestore } from '../shared/shots'
import { WorkspaceManager } from './workspace'
import { pruneThumbnailCache } from './thumbnails'
import { sendVideo } from './media'
import { viewingProfile } from '../shared/viewing'
import { loadViewingLut } from './viewing'
import { validateOptionRemovals, validateOrganizationAction } from '../shared/organization'
import type { OrganizationAction, TagVocabulary } from '../shared/organization'

export function createServer(token: string, onShotsChanged?: (change: ShotChange) => void, thumbnailCacheDirectory?: string, fingerprintDirectory?: string, organizationFile?: string, configurationFile?: string, onIngestChanged?: (status: IngestStatus) => void, onLibraryChanged?: (change: ShotChange) => void) {
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
  const workspace = new WorkspaceManager(thumbnailCacheDirectory, fingerprintDirectory, organizationFile, assertWritable)
  const proxies = new ProxyQueue(workspace.scanner, configuration)
  const application = new ApplicationMonitor(configuration, () => {
    const available = new Map(workspace.scanner.snapshot().shots.map(shot => [shot.id, shot.available]))
    return workspace.scanner.directoryAvailability().map(directory => ({
      id: directory.path, path: directory.path, name: `${directory.clipIds.length} clips`,
      available: directory.available && directory.clipIds.every(id => available.get(id)),
    }))
  }, () => proxies.status().error)
  const inspectConfigured = async (path: string, roots: string[] = []) => {
    const configured = await configuration()
    if (!configured.libraryMount) throw new Error('Choose the Library location again in Configuration to confirm its volume.')
    const location = await inspectLibrary(path, roots)
    if (configured.libraryPath !== path || configured.libraryMount !== location.mount) throw new Error('The configured Library volume is not mounted at its expected location. Choose the Library again if it has changed.')
    return location
  }
  const ingestion = new IngestQueue(workspace.scanner, async () => (await configuration()).libraryPath, inspectConfigured, rsyncFile, proxies)
  const catalogue = new LibraryCatalogue(workspace.scanner, async () => (await configuration()).libraryPath, async () => {
    const path = (await configuration()).libraryPath
    if (!path) throw new Error('Library Not Set')
    return inspectConfigured(path)
  }, ingestion, organizationFile ? join(dirname(organizationFile), 'catalogue.json') : undefined,
  organizationFile ? join(dirname(organizationFile), 'library-thumbnails') : undefined, assertWritable)
  let libraryRevision = 0
  const sync = new LibrarySync(catalogue, workspace.scanner, ingestion, async () => {
    const path = (await configuration()).libraryPath
    if (!path) throw new Error('Library Not Set')
    return inspectConfigured(path)
  })
  catalogue.onChange = () => onLibraryChanged?.({ revision: ++libraryRevision, vocabularyRevision: libraryRevision })
  workspace.scanner.organization.onChange = () => { catalogue.changed(); void workspace.scanner.reloadOrganizations().catch(error => server.log.warn(error)) }
  let catalogueQueueState = '', catalogueTransferProgress = ''
  ingestion.onChange = status => {
    onIngestChanged?.(status)
    // Membership changes reload drafts; Library transfer progress only needs a
    // new local snapshot. Import/proxy progress must not reload the catalogue.
    const next = JSON.stringify([status.active, status.stopping, status.current?.id, status.exportCurrent?.id, status.total, status.completed, status.waiting, status.tasks?.transfersRemaining, status.tasks?.syncsRemaining])
    const libraryCommit = status.current && workspace.scanner.workKind(status.current.id) === 'commit' ? status.current : undefined
    const progress = JSON.stringify([libraryCommit?.id, libraryCommit?.percent, status.exportCurrent?.id, status.exportCurrent?.percent])
    if (next !== catalogueQueueState) {
      catalogueQueueState = next; catalogue.changed()
      void workspace.scanner.reloadOrganizations().catch(error => server.log.warn(error))
    } else if (progress !== catalogueTransferProgress) catalogue.changed()
    catalogueTransferProgress = progress
  }
  ingestion.onPublished = async (metadata, location, names) => {
    await catalogue.published(metadata, location, names)
    workspace.scanner.retireCommitted(metadata.id)
  }
  const ids = { type: 'array', minItems: 1, maxItems: 1000, uniqueItems: true, items: { type: 'string', pattern: '^[a-f0-9]{64}$' } }
  const clipIdsBody = { body: { type: 'object', required: ['shotIds'], additionalProperties: false, properties: { shotIds: ids } } }
  const assetParams = { params: { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: '^[a-f0-9]{64}$' } } } }
  // Only main calls this authenticated registration route after a native picker.
  server.post<{ Body: { path: string } }>('/api/sync/destinations', { schema: { body: { type: 'object', required: ['path'], additionalProperties: false, properties: { path: { type: 'string', minLength: 1, maxLength: 4096 } } } } }, request => sync.choose(request.body.path))
  server.post<{ Body: { shotIds: string[]; destinationToken: string } }>('/api/sync/review', { schema: { body: { type: 'object', required: ['shotIds', 'destinationToken'], additionalProperties: false, properties: { shotIds: ids, destinationToken: { type: 'string', maxLength: 64 } } } } }, request => sync.preview(request.body.shotIds, request.body.destinationToken))
  server.post<{ Body: { shotIds: string[]; token: string } }>('/api/sync/start', { schema: { body: { type: 'object', required: ['shotIds', 'token'], additionalProperties: false, properties: { shotIds: ids, token: { type: 'string', maxLength: 64 } } } } }, request => sync.submit(request.body.token, request.body.shotIds))
  server.get('/api/library', () => catalogue.snapshot())
  server.post('/api/library/refresh', () => catalogue.refresh())
  server.get('/api/library/vocabulary', () => catalogue.vocabulary())
  server.post<{ Body: { shotIds: string[] } }>('/api/library/review', { schema: clipIdsBody }, request => catalogue.preview(request.body.shotIds))
  server.post<{ Body: { token: string; shotIds: string[] } }>('/api/library/commit', {
    schema: { body: { type: 'object', required: ['token', 'shotIds'], additionalProperties: false, properties: { shotIds: ids, token: { type: 'string', maxLength: 64 } } } }
  }, request => catalogue.submit(request.body.token, request.body.shotIds))
  server.post<{ Body: { shotIds: string[] } }>('/api/library/revert', { schema: clipIdsBody }, request => catalogue.revert(request.body.shotIds))
  server.patch<{ Body: { shotIds: string[]; action: OrganizationAction } }>('/api/library/organization', {
    schema: { body: { type: 'object', required: ['shotIds', 'action'], additionalProperties: false, properties: { shotIds: ids,
      action: { type: 'object', required: ['field', 'operation', 'value'], additionalProperties: false, properties: {
        field: { type: 'string', enum: ['identity', 'project', 'scene', 'group', 'camera', 'rating', 'tags', 'notes', 'all'] }, operation: { type: 'string', enum: ['add', 'remove', 'set', 'clear'] }, value: { type: 'string', maxLength: 10000 }
      } } } } }
  }, request => catalogue.update(request.body.shotIds, validateOrganizationAction(request.body.action)))
  server.get<{ Params: { id: string } }>('/api/library/:id/thumbnail', { schema: assetParams }, async request => ({ dataUrl: await catalogue.thumbnail(request.params.id) }))
  server.put<{ Params: { id: string }; Body: { dataUrl: string } }>('/api/library/:id/thumbnail', {
    bodyLimit: 3000100,
    schema: { ...assetParams, body: { type: 'object', required: ['dataUrl'], additionalProperties: false, properties: {
      dataUrl: { type: 'string', maxLength: 3000000, pattern: '^data:image/jpeg;base64,' }
    } } }
  }, async (request, reply) => { await catalogue.setThumbnail(request.params.id, request.body.dataUrl); return reply.code(204).send() })
  server.delete('/api/thumbnail-drafts', async (_, reply) => {
    workspace.scanner.assertNoIngestion()
    await workspace.scanner.organization.clearThumbnailDrafts()
    return reply.code(204).send()
  })
  server.get<{ Params: { id: string } }>('/api/library/:id/details', { schema: assetParams }, request => catalogue.details(request.params.id))
  server.get<{ Params: { id: string } }>('/api/library/:id/lut', { schema: assetParams }, async request => {
    const profile = viewingProfile((await catalogue.details(request.params.id)).metadata)
    return profile ? loadViewingLut(profile) : null
  })
  server.get<{ Params: { id: string } }>('/api/library/:id/media/original', { schema: assetParams }, async (request, reply) => {
    const asset = await catalogue.openVideo(request.params.id)
    return sendVideo(request, reply, asset.file, asset.path)
  })
  server.post<{ Body: { shotIds: string[] } }>('/api/workspace/eject', {
    schema: { body: { type: 'object', required: ['shotIds'], additionalProperties: false,
      properties: { shotIds: ids } } }
  }, async request => {
    try { return await ingestion.eject(request.body.shotIds) }
    catch (error) { throw Object.assign(error as Error, { statusCode: (error as { status?: number }).status ?? 409 }) }
  })
  server.post<{ Body: { shotIds: string[] } }>('/api/workspace/cancel', {
    schema: { body: { type: 'object', required: ['shotIds'], additionalProperties: false, properties: { shotIds: ids } } }
  }, async request => ingestion.cancel(request.body.shotIds))
  // Only Electron main calls this after Cache clearing, using paths from the previous backend snapshot.
  const restorePath = { type: 'string', pattern: '^/', maxLength: 32768 }
  const restoreFiles = { type: 'array', maxItems: 10000, items: restorePath }
  server.get('/api/workspace/restore-plan', () => workspace.scanner.restorePlan())
  server.post<{ Body: WorkspaceRestore }>('/api/workspace/restore', {
    bodyLimit: 8 * 1024 * 1024,
    schema: { body: { type: 'object', required: ['files', 'scans', 'excludedIds'], additionalProperties: false,
      properties: { files: restoreFiles, excludedIds: { ...ids, minItems: 0, maxItems: 10000 }, scans: { type: 'array', maxItems: 1000,
        items: { type: 'object', required: ['path'], additionalProperties: false, properties: { path: restorePath, files: restoreFiles } } } } } }
  }, request => { workspace.scanner.restoreWorkspace(request.body); return workspace.scanner.snapshot() })
  server.post<{ Body: { shotIds: string[] } }>('/api/organization/revert', {
    schema: { body: { type: 'object', required: ['shotIds'], additionalProperties: false, properties: { shotIds: ids } } }
  }, async request => {
    try { return await ingestion.revert(request.body.shotIds) }
    catch (error) { throw Object.assign(error as Error, { statusCode: 409 }) }
  })
  server.get('/api/ingestion', () => ingestion.status())
  server.post('/api/ingestion/library/refresh', () => { application.invalidate(); return ingestion.refreshLibrary() })
  server.post<{ Body: { shotIds: string[]; includeSynced?: boolean } }>('/api/ingestion/review', {
    schema: { body: { type: 'object', required: ['shotIds'], additionalProperties: false, properties: { shotIds: ids, includeSynced: { type: 'boolean' } } } }
  }, async request => {
    try { return await ingestion.preview(request.body.shotIds, request.body.includeSynced) }
    catch (error) { throw Object.assign(error as Error, { statusCode: 409 }) }
  })
  server.post<{ Body: { token: string; shotIds: string[] } }>('/api/ingestion', {
    schema: { body: { type: 'object', required: ['token', 'shotIds'], additionalProperties: false,
      properties: { shotIds: ids, token: { type: 'string', maxLength: 64 } } } }
  }, async request => {
    try { return await ingestion.submit(request.body.token, request.body.shotIds) }
    catch (error) { throw Object.assign(error as Error, { statusCode: 409 }) }
  })
  server.post('/api/work/stop', () => ingestion.stop())
  server.post('/api/work/refresh', () => ingestion.refreshWork())
  server.delete<{ Params: { id: string } }>('/api/ingestion/errors/:id', {
    schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'string', maxLength: 64 } } } }
  }, (request, reply) => { ingestion.dismissError(request.params.id); return reply.code(204).send() })
  server.post('/api/work/resume', () => ingestion.resume())
  server.post('/api/work/configure', () => { if (!proxies.status().paused) proxies.resume(); else proxies.schedule(); return ingestion.status() })
  workspace.scanner.onChange = change => { onShotsChanged?.(change); proxies.schedule(); ingestion.backgroundChanged() }
  server.addHook('onReady', async () => { workspace.startMonitoring(); void ingestion.status().catch(error => server.log.warn(error)) })

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

  server.get('/api/application-status', () => application.status())
  server.get('/api/organization/vocabulary', () => workspace.scanner.vocabulary())
  const optionProperties = Object.fromEntries(['identity', 'project', 'tags'].map(field => [field, {
    type: 'array', maxItems: 1000, items: { type: 'string', maxLength: 128 }
  }]))
  server.post<{ Body: TagVocabulary }>('/api/organization/vocabulary/preview', {
    schema: { body: { type: 'object', required: ['identity', 'project', 'tags'], additionalProperties: false, properties: optionProperties } }
  }, request => {
    let removals: TagVocabulary
    try { removals = validateOptionRemovals(request.body) }
    catch (error) { throw Object.assign(error as Error, { statusCode: 400 }) }
    return workspace.previewOptions(removals)
  })
  server.patch<{ Body: TagVocabulary & { reviewToken: string } }>('/api/organization/vocabulary', {
    schema: { body: { type: 'object', required: ['identity', 'project', 'tags', 'reviewToken'], additionalProperties: false,
      properties: { ...optionProperties, reviewToken: { type: 'string', pattern: '^[a-f0-9]{64}$' } } } }
  }, request => {
    const { reviewToken, ...values } = request.body
    let removals: TagVocabulary
    try { removals = validateOptionRemovals(values) }
    catch (error) { throw Object.assign(error as Error, { statusCode: 400 }) }
    return workspace.saveOptions(removals, reviewToken)
  })
  server.patch<{ Body: { shotIds: string[]; action: OrganizationAction } }>('/api/organization', {
    schema: { body: { type: 'object', required: ['shotIds', 'action'], additionalProperties: false, properties: {
      shotIds: { type: 'array', minItems: 1, maxItems: 1000, items: { type: 'string', pattern: '^[a-f0-9]{64}$' } },
      action: { type: 'object', required: ['field', 'operation', 'value'], additionalProperties: false, properties: {
        field: { type: 'string', enum: ['identity', 'project', 'scene', 'group', 'camera', 'rating', 'tags', 'notes', 'skip', 'all'] },
        operation: { type: 'string', enum: ['add', 'remove', 'set', 'clear'] }, value: { type: 'string', maxLength: 10000 }
      } }
    } } }
  }, (request) => {
    let action: OrganizationAction
    try { action = validateOrganizationAction(request.body.action) }
    catch (error) { throw Object.assign(error as Error, { statusCode: 400 }) }
    return workspace.scanner.updateOrganization(request.body.shotIds, action)
  })
  server.get('/api/cache', () => workspace.scanner.cacheSummary())
  server.delete('/api/cache', () => workspace.scanner.clearCache())
  server.get('/api/local-data', () => workspace.localDataSummary())
  server.delete('/api/local-data', {
    schema: { body: { type: 'object', required: ['confirm'], additionalProperties: false,
      properties: { confirm: { type: 'boolean', const: true } } } }
  }, async () => {
    workspace.scanner.assertNoIngestion()
    const paused = proxies.status().paused
    await proxies.stop()
    try { return await workspace.clearLocalData() }
    finally { if (!paused) proxies.resume() }
  })
  server.get('/api/shots', () => workspace.scanner.snapshot())
  server.get<{ Params: { id: string } }>('/api/shots/:id/lut', async (request) => {
    const details = await workspace.scanner.details(request.params.id)
    const profile = viewingProfile(details.metadata)
    return profile ? loadViewingLut(profile) : null
  })
  server.get<{ Params: { id: string } }>('/api/shots/:id/details', (request) => workspace.scanner.details(request.params.id))
  server.get<{ Params: { id: string } }>('/api/shots/:id/media/original', {
    schema: { params: { type: 'object', required: ['id'], properties: {
      id: { type: 'string', pattern: '^[a-f0-9]{64}$' }
    } } }
  }, async (request, reply) => {
    const asset = await workspace.scanner.openVideo(request.params.id)
    return sendVideo(request, reply, asset.file, asset.path)
  })
  server.get<{ Params: { id: string } }>('/api/shots/:id/thumbnail', async (request) => ({
    dataUrl: await workspace.scanner.thumbnail(request.params.id)
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
    await workspace.scanner.setThumbnail(request.params.id, request.body.dataUrl)
    return reply.code(204).send()
  })
  server.addHook('onClose', async () => {
    const activeClipIds = new Set(workspace.scanner.snapshot().shots.map(shot => shot.id))
    await ingestion.close(); await proxies.close(); await catalogue.close(); await workspace.close()
    if (cacheRoot) {
      try {
        await assertWritable?.()
        const result = await pruneManagedCache(cacheRoot, 90, Date.now(), activeClipIds)
        if (result.removed) server.log.info({ removed: result.removed }, 'Expired Cache files removed')
        if (result.failed) server.log.warn({ failed: result.failed }, 'Some expired Cache files could not be removed')
      } catch (error) { server.log.warn({ err: error }, 'Cache retention cleanup failed') }
    }
  })
  server.post<{ Body: { path: string } }>('/api/workspace/discover', {
    schema: { body: { type: 'object', required: ['path'], additionalProperties: false, properties: { path: { type: 'string', pattern: '^/', minLength: 1, maxLength: 32768 } } } }
  }, (request) => workspace.add(request.body.path))

  return server
}
