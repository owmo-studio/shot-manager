import Fastify from 'fastify'
import type { BackendHealth } from '../shared/desktop'
import type { ShotCollection } from '../shared/shots'
import { SourceRegistry } from './sources'
import { pruneThumbnailCache } from './thumbnails'
import { sendVideo } from './media'

export function createServer(token: string, onShotsChanged?: (collection: ShotCollection) => void, thumbnailCacheDirectory?: string) {
  const server = Fastify({ logger: true })
  const sources = new SourceRegistry(thumbnailCacheDirectory)
  sources.scanner.onChange = onShotsChanged

  if (thumbnailCacheDirectory) {
    server.addHook('onReady', async () => {
      try {
        const result = await pruneThumbnailCache(thumbnailCacheDirectory)
        if (result.removed) server.log.info({ removed: result.removed }, 'Expired thumbnail cache files removed')
        if (result.failed) server.log.warn({ failed: result.failed }, 'Some expired thumbnail cache files could not be removed')
      } catch (error) {
        server.log.warn({ err: error }, 'Thumbnail cache cleanup failed; continuing startup')
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
  server.post<{ Params: { id: string } }>('/api/sources/:id/refresh', (request) => sources.refresh(request.params.id))
  server.get('/api/shots', () => sources.scanner.snapshot())
  server.get<{ Params: { id: string } }>('/api/shots/:id/details', (request) => sources.scanner.details(request.params.id))
  server.get<{ Params: { id: string; variant: 'original' | 'proxy' } }>('/api/shots/:id/media/:variant', {
    schema: { params: { type: 'object', required: ['id', 'variant'], properties: {
      id: { type: 'string', pattern: '^[a-f0-9]{64}$' }, variant: { type: 'string', enum: ['original', 'proxy'] }
    } } }
  }, async (request, reply) => {
    const asset = await sources.scanner.openVideo(request.params.id, request.params.variant)
    return sendVideo(request, reply, asset.file, asset.path)
  })
  server.get<{ Params: { id: string }; Querystring: { fallback?: string } }>('/api/shots/:id/thumbnail', async (request) => ({
    dataUrl: await sources.scanner.thumbnail(request.params.id, request.query.fallback === '1')
  }))
  server.addHook('onClose', () => sources.scanner.close())
  server.post<{ Body: { path: string } }>('/api/sources', {
    schema: { body: { type: 'object', required: ['path'], additionalProperties: false, properties: { path: { type: 'string', minLength: 1 } } } }
  }, (request) => sources.add(request.body.path))
  server.delete<{ Params: { id: string } }>('/api/sources/:id', async (request, reply) => {
    await sources.remove(request.params.id)
    return reply.code(204).send()
  })

  return server
}
