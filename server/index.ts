import { createServer } from './app'

const token = process.env.SHOT_MANAGER_TOKEN
if (!token || !process.parentPort) throw new Error('Backend must be started by Shot Manager')

const server = createServer(token, (change) => {
  process.parentPort?.postMessage({ type: 'shots:changed', change })
}, process.env.SHOT_MANAGER_THUMBNAIL_CACHE, process.env.SHOT_MANAGER_FINGERPRINT_DIRECTORY, process.env.SHOT_MANAGER_ORGANIZATION_FILE, process.env.SHOT_MANAGER_CONFIGURATION_FILE, status => {
  process.parentPort?.postMessage({ type: 'ingestion:changed', status })
})
let stopping = false

async function shutdown() {
  if (stopping) return
  stopping = true
  await server.close()
  process.exit(0)
}

process.parentPort.on('message', ({ data }) => {
  if (data === 'shutdown') void shutdown()
})
process.on('SIGTERM', () => void shutdown())
process.on('SIGINT', () => void shutdown())

server.listen({ host: '127.0.0.1', port: 0 }).then((url) => {
  process.parentPort?.postMessage({ type: 'ready', url })
}).catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
