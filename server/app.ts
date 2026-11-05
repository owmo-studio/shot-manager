import Fastify from 'fastify'
import type { BackendHealth } from '../shared/desktop'
import type { ShotChange } from '../shared/shots'
import { SourceRegistry } from './sources'
import { pruneThumbnailCache } from './thumbnails'
import { sendVideo } from './media'
import { viewingProfile } from '../shared/viewing'
import { loadViewingLut } from './viewing'
import { validateOptionRemovals, validateOrganizationAction } from '../shared/organization'
import type { OrganizationAction, TagVocabulary } from '../shared/organization'

export function createServer(token: string, onShotsChanged?: (change: ShotChange) => void, thumbnailCacheDirectory?: string, fingerprintDirectory?: string, organizationFile?: string) {
  const server = Fastify({ logger: true })
  const sources = new SourceRegistry(thumbnailCacheDirectory, fingerprintDirectory, organizationFile)
  sources.scanner.onChange = onShotsChanged
  server.addHook('onReady', async () => { sources.startMonitoring() })

  if (thumbnailCacheDirectory) {
    server.addHook('onClose', async () => {
      try {
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
  }, () => sources.clearLocalData())
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
  server.addHook('onClose', () => sources.close())
  server.post<{ Body: { path: string } }>('/api/sources', {
    schema: { body: { type: 'object', required: ['path'], additionalProperties: false, properties: { path: { type: 'string', minLength: 1 } } } }
  }, (request) => sources.add(request.body.path))
  server.delete<{ Params: { id: string } }>('/api/sources/:id', async (request, reply) => {
    await sources.remove(request.params.id)
    return reply.code(204).send()
  })

  return server
}
