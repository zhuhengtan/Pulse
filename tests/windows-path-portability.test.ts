import { expect, it, vi } from 'vitest'
// Exercise the Windows native path API on every runner, including macOS/Linux.
vi.mock('node:path', async importOriginal => {
  const path = await importOriginal<typeof import('node:path')>()
  return { ...path, join: path.win32.join, parse: path.win32.parse }
})
import { hostBreadcrumbs } from '../packages/server/src/h5/host-filesystem.js'
import { mapTransferredArguments } from '../packages/server/src/conversation-bundle.js'

it('keeps explicit POSIX breadcrumbs independent of the host native path API', () => {
  expect(hostBreadcrumbs('/Users/me/project', false).map(item => item.path)).toEqual(['/', '/Users', '/Users/me', '/Users/me/project'])
})
it('relocates paths using the destination format rather than the native host API', () => {
  expect(mapTransferredArguments('fs.read', { path: '/old/project/note.txt' }, '/old/project', '/new/project')).toEqual({ path: '/new/project/note.txt' })
  expect(mapTransferredArguments('fs.move', { source: 'C:\\old\\note.txt', destination: 'C:\\old\\moved.txt' }, 'C:\\old', '/new')).toEqual({ source: '/new/note.txt', destination: '/new/moved.txt' })
  expect(mapTransferredArguments('fs.read', { path: '/old/note.txt' }, '/old', 'D:\\new')).toEqual({ path: 'D:\\new\\note.txt' })
})
