import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { FilesystemTool } from '@hunterzhu/pulse-adapters'
import { captureCheck } from './check-receipt.js'

async function dependencyNames(root: string): Promise<Record<string, string[]>> {
  const receipt = await captureCheck(root, root, 'node', ['--test'])
  const files = new FilesystemTool(root), manifests: Record<string, string[]> = {}
  for (const path of Object.keys(receipt.files).filter(path => /(?:^|[/\\])package\.json$/.test(path))) {
    const body = JSON.parse(await files.read(path)) as Record<string, unknown>
    manifests[path] = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'].flatMap(group => Object.keys(body[group] ?? {}).map(name => `${group}:${name}`)).sort()
  }
  return manifests
}
/** Host data baseline. It is never supplied by or editable through a model tool. */
export async function freezeConstraintBaseline(root: string, runDirectory: string): Promise<void> {
  const path = join(runDirectory, 'constraint-baseline.json')
  try { await fs.access(path); return } catch { /* New run. */ }
  await fs.mkdir(runDirectory, { recursive: true })
  await fs.writeFile(path, JSON.stringify({ dependencies: await dependencyNames(root) }), { flag: 'wx', mode: 0o600 }).catch(error => { if (error.code !== 'EEXIST') throw error })
}
export async function violatedConstraints(root: string, runDirectory: string, descriptions: string[]): Promise<string[]> {
  if (!descriptions.some(text => /禁止新增依赖|不得新增依赖|不要.{0,3}(?:增加|新增)依赖|no new dependenc|do not add dependenc|without (?:adding )?(?:new )?dependenc/i.test(text))) return []
  const baseline = JSON.parse(await fs.readFile(join(runDirectory, 'constraint-baseline.json'), 'utf8')) as { dependencies: Record<string, string[]> }
  const current = await dependencyNames(root)
  return Object.entries(current).flatMap(([path, names]) => names.filter(name => !baseline.dependencies[path]?.includes(name)).map(name => `${path}: added ${name}`))
}
