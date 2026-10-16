import { PagedEventArchive } from './event-archive.js'
import { access } from 'node:fs/promises'
import { join } from 'node:path'
import { FileRuntimePersistenceBackend, FileRuntimeContentStore, SqliteRuntimePersistenceBackend, type RuntimePersistenceBackend } from '@hunterzhu/pulse-runtime'

/** Existing runs select their original format. A changed default never silently converts data. */
export async function runPersistence(directory: string, requested: 'json' | 'sqlite' | 'external-files' = 'external-files'): Promise<RuntimePersistenceBackend> {
  const exists = (path: string) => access(path).then(() => true, () => false)
  if (await exists(join(directory, 'runtime.sqlite')) && await exists(join(directory, 'runtime.json'))) throw new Error('RUNTIME_PERSISTENCE_FORMAT_CONFLICT: both JSON and SQLite snapshots exist; select an explicit migration source.')
  if (await exists(join(directory, 'runtime.sqlite'))) return Object.assign(new SqliteRuntimePersistenceBackend(join(directory, 'runtime.sqlite')), { lazyResultBodies: true, checkpointEventInterval: 256 })
  const file = new FileRuntimePersistenceBackend(join(directory, 'runtime.json'))
  const external = await exists(join(directory, 'runtime-results'))
  const existingJson = await exists(file.filePath)
  if (requested === 'sqlite' && !existingJson) return Object.assign(new SqliteRuntimePersistenceBackend(join(directory, 'runtime.sqlite')), { lazyResultBodies: true, checkpointEventInterval: 256 })
  if (external || !existingJson && requested === 'external-files') {
    return Object.assign(file, { resultStore: new FileRuntimeContentStore(join(directory, 'runtime-results')), eventArchive: new PagedEventArchive(join(directory, 'runtime-events')), lazyResultBodies: true, checkpointEventInterval: 256 })
  }
  return file
}
