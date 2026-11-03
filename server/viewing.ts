import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { ViewingLut, ViewingProfile } from '../shared/viewing'

const files: Record<ViewingProfile, string> = {
  'sony-slog3-cine': 'sony-s709.cube',
  'apple-log': 'apple-log-rec709.cube'
}
const loaded = new Map<string, Promise<ViewingLut>>()

export function viewingLutPath(profile: ViewingProfile) {
  return join(process.env.SHOT_MANAGER_LUT_DIRECTORY ?? join(process.cwd(), 'resources', 'luts'), files[profile])
}

export async function loadViewingLut(profile: ViewingProfile): Promise<ViewingLut> {
  const path = viewingLutPath(profile)
  const info = await stat(path)
  if (info.size > 24 * 1024 * 1024) throw new Error('Viewing LUT is too large.')
  const key = `${path}:${info.size}:${info.mtimeMs}`
  if (!loaded.has(key)) {
    const promise = readFile(path, 'utf8').then((text) => {
      let size = 0
      const values: number[] = []
      for (const raw of text.split(/\r?\n/)) {
        const line = raw.replace(/#.*/, '').trim()
        if (!line || line.startsWith('TITLE')) continue
        const fields = line.split(/\s+/)
        if (fields[0] === 'LUT_3D_SIZE') { size = Number(fields[1]); continue }
        if (fields[0] === 'DOMAIN_MIN' && fields.slice(1).every((v) => Number(v) === 0)) continue
        if (fields[0] === 'DOMAIN_MAX' && fields.slice(1).every((v) => Number(v) === 1)) continue
        if (fields.length !== 3 || fields.some((v) => !Number.isFinite(Number(v)))) throw new Error('Unsupported viewing LUT.')
        values.push(...fields.map(Number))
      }
      if (!Number.isInteger(size) || size < 2 || size > 65 || values.length !== size ** 3 * 3) throw new Error('Invalid viewing LUT grid.')
      return { profile, size, values, fingerprint: createHash('sha256').update(text).digest('hex') }
    })
    loaded.set(key, promise)
    promise.catch(() => loaded.delete(key))
  }
  return loaded.get(key)!
}
