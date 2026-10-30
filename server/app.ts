import Fastify from 'fastify'
import type { BackendHealth } from '../shared/desktop'

export function createServer(token: string) {
  const server = Fastify({ logger: true })

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

  return server
}
