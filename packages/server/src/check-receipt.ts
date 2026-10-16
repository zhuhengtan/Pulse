import { promises as fs } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, extname, join, relative, resolve, sep } from 'node:path'
import { FilesystemTool } from '@hunterzhu/pulse-adapters'

export interface CheckReceipt {
  schemaVersion: 1
  command: string
  args: string[]
  cwd: string
  files: Record<string, string>
  definitions: Record<string, string>
  environment: { platform: string; node: string }
  stable: boolean
  definitionChanged: boolean
}
export const isCheck = (command: string, args: string[]) => /(?:--(?:test|check)|(?:test|check|verify|lint|typecheck|pytest|vitest|jest)(?:[.\s/\\-]|$))/i.test([command, ...args].join(' '))
const hash = (text: string) => createHash('sha256').update(text).digest('hex')

/** Named checks include their local import closure. Project scripts use a conservative source tree. */
export async function captureCheck(root: string, cwd: string, command: string, args: string[], allDefinitions = false): Promise<CheckReceipt> {
  root = await fs.realpath(root)
  cwd = await fs.realpath(cwd)
  const files = new FilesystemTool(root), versions: Record<string, string> = {}, definitions: Record<string, string> = {}
  const pending = args.filter(arg => !arg.startsWith('-') && /\.(?:[cm]?[jt]sx?|py|sh)$/.test(arg)).map(arg => resolve(cwd, arg))
  const named = pending.length > 0
  if (!named) {
    const visit = async (dir: string): Promise<void> => {
      for (const item of await fs.readdir(dir, { withFileTypes: true })) {
        if (/^(?:\.|node_modules$|dist$|build$|coverage$|data$|logs$)/.test(item.name)) continue
        const path = join(dir, item.name)
        if (item.isDirectory()) await visit(path)
        else if (item.isFile() && /\.(?:[cm]?[jt]sx?|py|sh|json|toml|yaml|yml)$/.test(item.name)) pending.push(path)
        if (pending.length > 20_000) throw Object.assign(new Error('Check scope exceeds bounded manifest; use a named check.'), { code: 'CHECK_SCOPE_TOO_LARGE' })
      }
    }
    await visit(cwd)
  }
  for (const name of ['package.json', 'pnpm-lock.yaml', 'package-lock.json', 'tsconfig.json']) pending.push(join(cwd, name))
  let bytes = 0
  while (pending.length) {
    const path = pending.pop()!, key = relative(root, path)
    if (key.startsWith(`..${sep}`) || key === '..' || versions[key]) continue
    let text: string
    try { const read = await files.readLimited(path, 1_000_000); if (read.truncated) throw Object.assign(new Error('Check input exceeds per-file manifest bound.'), { code: 'CHECK_SCOPE_TOO_LARGE' }); text = read.content } catch (e) { if ((e as { code?: string }).code === 'ENOENT') continue; throw e }
    bytes += Buffer.byteLength(text)
    if (bytes > 64 * 1024 * 1024) throw Object.assign(new Error('Check manifest exceeds byte budget.'), { code: 'CHECK_SCOPE_TOO_LARGE' })
    versions[key] = hash(text)
    if (/(?:test|spec|check|verify|lint)/i.test(key)) definitions[key] = versions[key]!
    if (/(?:^|[/\\])package\.json$/.test(key)) {
      const body = JSON.parse(text) as { scripts?: Record<string, string> }
      const script = args.filter(arg => !arg.startsWith('-')); const selected = script[0] === 'run' ? script[1] : script[0]
      for (const [name, scriptCommand] of Object.entries(body.scripts ?? {})) if (allDefinitions || /^(?:npm|pnpm|yarn|bun)$/.test(command) && name === selected) definitions[`${key}#scripts:${name}`] = hash(scriptCommand)
    }
    if (named) for (const match of text.matchAll(/(?:from\s*|import\s*(?:\(\s*)?|require\s*\()\s*['"](\.[^'"]+)['"]/g)) {
      const base = resolve(dirname(path), match[1]!)
      for (const candidate of [base, base.replace(/\.js$/, '.ts'), ...['.ts', '.js', '.mjs', '.tsx', '/index.ts', '/index.js'].map(ext => base + ext)]) {
        if ((await fs.stat(candidate).catch(() => undefined))?.isFile()) { pending.push(candidate); break }
      }
    }
  }
  return { schemaVersion: 1, command, args, cwd: relative(root, cwd) || '.', files: versions, definitions, environment: { platform: process.platform, node: process.version }, stable: true, definitionChanged: false }
}

/** First observed check definition is frozen in Host data, never in the agent workspace. */
export async function finishCheck(root: string, before: CheckReceipt, store?: string): Promise<CheckReceipt> {
  const after = await captureCheck(root, resolve(root, before.cwd), before.command, before.args)
  before.stable = JSON.stringify(before.files) === JSON.stringify(after.files)
  if (store) {
    await fs.mkdir(store, { recursive: true })
    const path = join(store, `${hash(JSON.stringify([before.command, before.args, before.cwd]))}.json`)
    let initial: Record<string, string>
    try { await fs.writeFile(path, JSON.stringify(before.definitions), { flag: 'wx', mode: 0o600 }); initial = before.definitions }
    catch (e) { if ((e as { code?: string }).code !== 'EEXIST') throw e; initial = JSON.parse(await fs.readFile(path, 'utf8')) }
    before.definitionChanged = JSON.stringify(initial) !== JSON.stringify(before.definitions)
    try {
      const original = JSON.parse(await fs.readFile(join(store, 'original.json'), 'utf8')) as Record<string, string>
      for (const [path, hash] of Object.entries(original)) if (before.definitions[path] !== undefined && before.definitions[path] !== hash) before.definitionChanged = true
    } catch (error) { if ((error as { code?: string }).code !== 'ENOENT') throw error }
  }
  return before
}

export async function freezeCheckDefinitions(root: string, store: string): Promise<void> {
  try { await fs.access(join(store, 'original.json')); return } catch { /* New run. */ }
  const receipt = await captureCheck(root, root, 'node', ['--test'], true)
  await fs.mkdir(store, { recursive: true })
  await fs.writeFile(join(store, 'original.json'), JSON.stringify(receipt.definitions), { flag: 'wx', mode: 0o600 }).catch(error => { if (error.code !== 'EEXIST') throw error })
}
