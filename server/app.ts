import Fastify from 'fastify'
import type { BackendHealth } from '../shared/desktop'
import { SourceRegistry } from './sources'

export function createServer(token: string) {
  const server = Fastify({ logger: true })
  const sources = new SourceRegistry()

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
  server.post<{ Body: { path: string } }>('/api/sources', {
    schema: { body: { type: 'object', required: ['path'], additionalProperties: false, properties: { path: { type: 'string', minLength: 1 } } } }
  }, (request) => sources.add(request.body.path))
  server.delete<{ Params: { id: string } }>('/api/sources/:id', async (request, reply) => {
    await sources.remove(request.params.id)
    return reply.code(204).send()
  })

  return server
}
