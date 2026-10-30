import { cpSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../', import.meta.url))
const source = join(root, 'packages/adapters/src/documents/pptx-parse.cjs')
const target = join(root, 'packages/adapters/dist/documents/pptx-parse.cjs')
mkdirSync(dirname(target), { recursive: true })
cpSync(source, target)
