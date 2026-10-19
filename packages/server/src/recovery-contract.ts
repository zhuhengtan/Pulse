import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import type { ToolRegistry } from '@hunterzhu/pulse-tool-sdk'
import type { RuntimePersistenceBackend } from '@hunterzhu/pulse-runtime'

export interface RecoveryFingerprints { build: string; tools: Record<string, string>; policy: string }
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
function source(name: string): string {
  try { return readFileSync(new URL(`./${name}.js`, import.meta.url), 'utf8') }
  catch { return readFileSync(new URL(`./${name}.ts`, import.meta.url), 'utf8') }
}

/** Hash the deployed code trees, including helper modules and embedded data. */
export function recoveryBuildFingerprint(roots: ReadonlyArray<{ name: string; directory: string }>): string {
  const files: Array<[string, string]> = []
  const byName = (a: { name: string }, b: { name: string }) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0
  for (const root of [...roots].sort(byName)) {
    const visit = (directory: string, prefix: string): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true }).sort(byName)) {
        const path = join(directory, entry.name), name = `${prefix}${entry.name}`
        if (entry.isSymbolicLink()) throw new Error(`RECOVERY_BUILD_SYMLINK_UNSUPPORTED:${root.name}/${name}`)
        if (entry.isDirectory()) visit(path, `${name}/`)
        else if (entry.isFile() && /\.(?:[cm]?[jt]sx?|json)$/.test(entry.name) && !/\.d\.[cm]?ts$/.test(entry.name)) files.push([`${root.name}/${name}`, createHash('sha256').update(readFileSync(path)).digest('hex')])
      }
    }
    visit(root.directory, '')
  }
  return digest(files)
}

export function currentRecoveryBuild(): string {
  const require = createRequire(import.meta.url)
  const sourceMode = import.meta.url.endsWith('.ts')
  const dependencies = ['@hunterzhu/pulse-runtime', '@hunterzhu/pulse-adapters', '@hunterzhu/pulse-tool-sdk'].map(name => {
    const deployed = dirname(require.resolve(name)), sources = join(deployed, '..', 'src')
    return { name, directory: sourceMode && existsSync(sources) ? sources : deployed }
  })
  return recoveryBuildFingerprint([{ name: '@hunterzhu/pulse-server', directory: dirname(fileURLToPath(import.meta.url)) }, ...dependencies])
}
export function recoveryPolicyFingerprint(policy: unknown): string {
  return digest([policy, source('verification-policy'), source('plan-confirmation'), source('security')])
}
export function recoveryFingerprints(registry: ToolRegistry, policy: unknown, relocation?: { source: string; target: string }): RecoveryFingerprints {
  return { build: currentRecoveryBuild(),
    tools: Object.fromEntries(registry.list().map(tool => {
      const permissions = structuredClone(tool.permissions ?? {})
      // Compare the same workspace permission across machines without broadening the registry's actual roots.
      if (relocation && permissions.workspaceRoots) permissions.workspaceRoots = permissions.workspaceRoots.map(root => root === relocation.target ? relocation.source : root)
      return [tool.name, digest({ input: tool.inputSchema, output: tool.outputSchema, retry: tool.retrySafety, effects: tool.sideEffectPolicy, permissions })]
    })), policy: recoveryPolicyFingerprint(policy) }
}
export function recoveryCompatibility(previous: RecoveryFingerprints | undefined, current: RecoveryFingerprints) {
  if (!previous) return { status: 'migratable' as const, reasons: ['Legacy run has no fingerprints; preserve its snapshot and bind the current contract.'] }
  const reasons = Object.entries(previous.tools).filter(([name, hash]) => current.tools[name] !== hash).map(([name]) => `TOOL_SCHEMA_INCOMPATIBLE:${name}`)
  if (previous.policy !== current.policy) reasons.push('RECOVERY_POLICY_INCOMPATIBLE')
  return reasons.length ? { status: 'incompatible' as const, reasons } : { status: previous.build === current.build ? 'compatible' as const : 'migratable' as const, reasons: previous.build === current.build ? [] : ['Build changed; tool schemas and policy remain compatible.'] }
}
/** Preflight only. No effects, approvals, question answers or ownership are replayed by migration. */
export async function prepareRecovery(backend: RuntimePersistenceBackend, directory: string, current: RecoveryFingerprints, authorization?: { from: string; to: string }) {
  const snapshot = await backend.load()
  const result = recoveryCompatibility(snapshot?.compatibility?.fingerprints as RecoveryFingerprints | undefined, current)
  if (result.status === 'incompatible') throw new Error(result.reasons.join('; '))
  const previousBuild = snapshot?.compatibility?.fingerprints?.build
  if (previousBuild && previousBuild !== current.build && (authorization?.from !== previousBuild || authorization?.to !== current.build)) throw new Error(`RECOVERY_BUILD_MIGRATION_REQUIRED: from=${previousBuild} to=${current.build}. Review the build change, then authorize this exact pair.`)
  if (snapshot && result.status === 'migratable') {
    await mkdir(directory, { recursive: true })
    const body = JSON.stringify(snapshot)
    const id = digest(body)
    // Content-addressed original makes a crash between journal writes harmless.
    await writeFile(join(directory, `recovery-original-${id}.json`), body, { flag: 'wx', mode: 0o600 }).catch(async error => { if (error.code !== 'EEXIST') throw error; if (await readFile(join(directory, `recovery-original-${id}.json`), 'utf8') !== body) throw new Error('RECOVERY_BACKUP_CONFLICT') })
    const journal = join(directory, `recovery-${id}-${digest(current)}.json`)
    await writeFile(journal, JSON.stringify({ schemaVersion: 1, status: 'prepared', result, originalHash: id, target: current, preservesBudget: true, replaysEffects: false }), { flag: 'wx', mode: 0o600 }).catch(error => { if (error.code !== 'EEXIST') throw error })
    return { ...result, journal }
  }
  return { ...result, journal: undefined }
}

export async function finishRecovery(journal: string): Promise<void> {
  const prepared = JSON.parse(await readFile(journal, 'utf8'))
  await writeFile(`${journal}.committed`, JSON.stringify({ ...prepared, status: 'committed' }), { flag: 'wx', mode: 0o600 }).catch(error => { if (error.code !== 'EEXIST') throw error })
}
