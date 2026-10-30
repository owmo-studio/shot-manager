import Fastify from 'fastify'
import type { BackendHealth } from '../shared/desktop'
import type { ShotCollection } from '../shared/shots'
import { SourceRegistry } from './sources'

export function createServer(token: string, onShotsChanged?: (collection: ShotCollection) => void) {
  const server = Fastify({ logger: true })
  const sources = new SourceRegistry()
  sources.scanner.onChange = onShotsChanged

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
  server.get<{ Params: { id: string } }>('/api/shots/:id/thumbnail', async (request) => ({
    dataUrl: await sources.scanner.thumbnail(request.params.id)
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
