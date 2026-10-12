import { cp, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = fileURLToPath(new URL('../../', import.meta.url))
const source = join(repo, 'packages/web/dist')
const target = join(repo, 'packages/server/dist/web')
await mkdir(join(repo, 'packages/server/dist'), { recursive: true })
await rm(target, { recursive: true, force: true })
await cp(source, target, { recursive: true })
