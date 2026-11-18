import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { AppConfiguration } from '../shared/desktop'

export async function readConfiguration(path: string): Promise<AppConfiguration> {
  try {
    const value = JSON.parse(await readFile(path, 'utf8'))
    if (value.version !== 1 || !(value.libraryPath === null ||
      (typeof value.libraryPath === 'string' && isAbsolute(value.libraryPath) && !value.libraryPath.includes('\0'))) ||
        (value.libraryMount !== undefined && (typeof value.libraryMount !== 'string' || !value.libraryMount || value.libraryMount.includes('\0'))) ||
        (value.scratchPath !== undefined && value.scratchPath !== null && (typeof value.scratchPath !== 'string' || !isAbsolute(value.scratchPath) || value.scratchPath.includes('\0'))) ||
        (value.scratchMount !== undefined && (typeof value.scratchMount !== 'string' || !value.scratchMount || value.scratchMount.includes('\0')))) {
      throw new Error('Invalid configuration')
    }
    return { version: 1, libraryPath: value.libraryPath,
      ...(value.libraryMount ? { libraryMount: value.libraryMount } : {}),
      ...(value.scratchPath !== undefined ? { scratchPath: value.scratchPath } : {}), ...(value.scratchMount ? { scratchMount: value.scratchMount } : {}) }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, libraryPath: null }
    throw new Error('Could not read application configuration. Existing settings have been preserved.')
  }
}

export async function saveConfiguration(path: string, configuration: AppConfiguration) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, JSON.stringify(configuration, null, 2) + '\n', { mode: 0o600, flush: true })
    await rename(temporary, path)
  } finally { await unlink(temporary).catch(() => undefined) }
}
