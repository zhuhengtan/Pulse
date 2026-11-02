import { cpSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../', import.meta.url))
for (const asset of ['documents/pptx-parse.cjs', 'tools/windows-pty-bridge.cjs', 'tools/windows-pty-protocol.cjs', 'tools/windows-sandbox-worker.cjs']) {
  const source = join(root, 'packages/adapters/src', asset)
  const target = join(root, 'packages/adapters/dist', asset)
  mkdirSync(dirname(target), { recursive: true })
  cpSync(source, target)
}

mkdirSync(join(root, 'packages/server/dist/lsp'), { recursive: true })
cpSync(join(root, 'packages/server/src/lsp/worker.cjs'), join(root, 'packages/server/dist/lsp/worker.cjs'))
