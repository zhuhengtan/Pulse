import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const modules = [
  ['server', 'Server'], ['cli', 'CLI'], ['runtime', 'Runtime'],
  ['data', 'Data'], ['adapters', 'Adapters'], ['tool-sdk', 'Tool SDK'],
] as const
export interface ModuleVersion { name: string; title: string; version?: string }

/** Read the running bundle's metadata, rather than inferring all module versions. */
export async function backendModuleVersions(): Promise<ModuleVersion[]> {
  const root = fileURLToPath(new URL('../../', import.meta.url))
  return Promise.all(modules.map(async ([id, title]) => {
    const name = `@hunterzhu/pulse-${id}`
    const paths = id === 'server' ? [join(root, 'package.json')] : [join(root, '..', `pulse-${id}`, 'package.json'), join(root, '..', id, 'package.json')]
    try { paths.unshift(join(dirname(fileURLToPath(import.meta.resolve(name))), '..', 'package.json')) } catch { /* CLI is a sibling, not a server dependency. */ }
    for (const path of paths) {
      try {
        const value = JSON.parse(await readFile(path, 'utf8')) as { name?: string; version?: string }
        if (value.name === name && typeof value.version === 'string') return { name, title, version: value.version }
      } catch { /* Some npm deployments do not include every backend module. */ }
    }
    return { name, title }
  }))
}

export async function bundledFrontendVersion(directory?: string): Promise<string | undefined> {
  try {
    const value = JSON.parse(await readFile(directory ? join(directory, 'version.json') : new URL('../web/version.json', import.meta.url), 'utf8')) as { version?: unknown }
    return typeof value.version === 'string' ? value.version : undefined
  } catch { return undefined }
}
