import { mkdtemp, readFile, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { ConversationData } from '../packages/data/src/index.js'

it('releases SQLite and the writer lock on final graceful close without stopping another client', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pulse-data-close-'))
  const first = new ConversationData(directory), second = new ConversationData(directory)
  try {
    await first.call('saveState', 'fixture', 'preserved')
    await second.call('revision')
    const owner = await readFile(join(directory, '.writer.lock'), 'utf8')
    await first.close()
    expect(await second.call('readState', 'fixture')).toBe('preserved')
    expect(await readFile(join(directory, '.writer.lock'), 'utf8')).toBe(owner)
    await second.close()
    await expect(readFile(join(directory, '.writer.lock'))).rejects.toMatchObject({ code: 'ENOENT' })
    // Windows rejects this rename if any writer still holds the SQLite file.
    await rename(join(directory, 'pulse.sqlite'), join(directory, 'closed.sqlite'))
    await expect(second.call('revision')).rejects.toThrow('DATA_CLIENT_CLOSED')
    await second.close()
  } finally {
    await first.close(); await second.close()
    await rm(directory, { recursive: true, force: true })
  }
})

it('can reopen during another client graceful close without losing persisted data', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pulse-data-reopen-'))
  let current = new ConversationData(directory)
  try {
    await current.call('saveState', 'fixture', 'preserved')
    for (let i = 0; i < 8; i++) {
      const previous = current
      current = new ConversationData(directory)
      const [, value] = await Promise.all([previous.close(), current.call('readState', 'fixture')])
      expect(value).toBe('preserved')
    }
  } finally {
    await current.close()
    await rm(directory, { recursive: true, force: true })
  }
}, 20_000)

it('joins an in-flight startup before releasing the final writer', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pulse-data-startup-close-'))
  const client = new ConversationData(directory)
  try {
    const rejected = expect(client.call('revision')).rejects.toThrow('DATA_CLIENT_CLOSED')
    await client.close()
    await rejected
    await expect(readFile(join(directory, '.writer.lock'))).rejects.toMatchObject({ code: 'ENOENT' })
    await rename(join(directory, 'pulse.sqlite'), join(directory, 'closed.sqlite'))
  } finally {
    await client.close()
    await rm(directory, { recursive: true, force: true })
  }
})
