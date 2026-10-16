import { mkdir, open, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { RuntimeEvent, RuntimeEventArchive } from '@hunterzhu/pulse-runtime'

/** Immutable event pages: appending a checkpoint never rewrites earlier trace pages. */
export class PagedEventArchive implements RuntimeEventArchive {
  constructor(private readonly directory: string) {}
  async append(events: RuntimeEvent[]): Promise<void> {
    if (!events.length) return
    if (events.some(e => !Number.isInteger(e.seq) || e.seq < 1)) throw new Error('INVALID_RUNTIME_EVENT_ARCHIVE')
    await mkdir(this.directory, { recursive: true })
    const prior = new Map((await this.read(events[0]!.seq, events.at(-1)!.seq)).map(e => [e.seq, e]))
    for (const event of events) if (prior.has(event.seq) && JSON.stringify(prior.get(event.seq)) !== JSON.stringify(event)) throw new Error('RUNTIME_EVENT_ARCHIVE_CONFLICT')
    const fresh = events.filter(e => !prior.has(e.seq))
    if (!fresh.length) return
    const target = join(this.directory, `${String(fresh[0]!.seq).padStart(12, '0')}-${String(fresh.at(-1)!.seq).padStart(12, '0')}.json`)
    const temp = `${target}.${randomUUID()}.tmp`
    try { const file = await open(temp, 'wx', 0o600); try { await file.writeFile(JSON.stringify(fresh)); await file.sync() } finally { await file.close() }; await rename(temp, target) } finally { await rm(temp, { force: true }) }
  }
  async read(fromSeq: number, toSeq = Infinity): Promise<RuntimeEvent[]> {
    if (!Number.isInteger(fromSeq) || fromSeq < 0 || Number.isNaN(toSeq)) throw new Error('INVALID_RUNTIME_EVENT_ARCHIVE_RANGE')
    const events: RuntimeEvent[] = []
    for (const name of (await readdir(this.directory).catch(error => { if (error.code === 'ENOENT') return []; throw error })).sort()) {
      const range = name.match(/^(\d+)-(\d+)\.json$/)
      if (!range || Number(range[2]) < fromSeq || Number(range[1]) > toSeq) continue
      const page = JSON.parse(await readFile(join(this.directory, name), 'utf8')) as RuntimeEvent[]
      for (const event of page) if (event.seq >= fromSeq && event.seq <= toSeq) events.push(event)
    }
    return events
  }
}
