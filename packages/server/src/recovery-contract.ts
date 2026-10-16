import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import type { ToolRegistry } from '@hunterzhu/pulse-tool-sdk'
import type { RuntimePersistenceBackend } from '@hunterzhu/pulse-runtime'

export interface RecoveryFingerprints { build: string; tools: Record<string, string>; policy: string }
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
function source(name: string): string {
  try { return readFileSync(new URL(`./${name}.js`, import.meta.url), 'utf8') }
  catch { return readFileSync(new URL(`./${name}.ts`, import.meta.url), 'utf8') }
}
export function recoveryFingerprints(registry: ToolRegistry, policy: unknown): RecoveryFingerprints {
  const runtimeRoot = dirname(createRequire(import.meta.url).resolve('@hunterzhu/pulse-runtime'))
  const runtimeBuild = readFileSync(join(runtimeRoot, 'scheduler/runtime.js'), 'utf8')
  return { build: digest([source('index'), source('editing'), source('task-controller/program'), runtimeBuild]),
    tools: Object.fromEntries(registry.list().map(tool => [tool.name, digest({ input: tool.inputSchema, output: tool.outputSchema, retry: tool.retrySafety, effects: tool.sideEffectPolicy, permissions: tool.permissions ?? {} })])),
    policy: digest([policy, source('verification-policy'), source('plan-confirmation'), source('security')]) }
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
