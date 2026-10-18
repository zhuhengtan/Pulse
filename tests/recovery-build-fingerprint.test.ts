import { mkdtemp, mkdir, readFile, rm, writeFile, cp } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it } from 'vitest'
import { recoveryBuildFingerprint, recoveryCompatibility, prepareRecovery } from '../packages/server/src/recovery-contract.js'
import { FileRuntimePersistenceBackend, PulseRuntime } from '@hunterzhu/pulse-runtime'

it.each(['server/task-controller/state.ts', 'server/task-controller/acceptance.ts', 'runtime/dsl/program.js', 'adapters/tools/filesystem.js', 'sdk/index.js'])('detects a change in an execution dependency: %s', async path => {
  const root = await mkdtemp(join(tmpdir(), 'pulse-build-closure-'))
  const roots = ['server', 'runtime', 'adapters', 'sdk'].map(name => ({ name, directory: join(root, name) }))
  try {
    for (const item of roots) { await mkdir(item.directory); await writeFile(join(item.directory, 'index.js'), 'export const version = 1') }
    const target = join(root, path); await mkdir(join(target, '..'), { recursive: true }); await writeFile(target, 'export const maxStageAttempts = 4')
    const before = recoveryBuildFingerprint(roots)
    await writeFile(target, 'export const maxStageAttempts = 1')
    const after = recoveryBuildFingerprint(roots)
    expect(after).not.toBe(before)
    const previous = { build: before, tools: {}, policy: 'same-policy' }, current = { ...previous, build: after }
    expect(recoveryCompatibility(previous, current).status).toBe('migratable')
    const backend = new FileRuntimePersistenceBackend(join(root, 'runtime.json'))
    await new PulseRuntime({ recoveryFingerprints: previous }).persist(backend)
    const saved = await readFile(join(root, 'runtime.json'), 'utf8')
    await expect(prepareRecovery(backend, root, current)).rejects.toThrow('RECOVERY_BUILD_MIGRATION_REQUIRED')
    expect(await readFile(join(root, 'runtime.json'), 'utf8')).toBe(saved)
    await expect(prepareRecovery(backend, root, current, { from: before, to: after })).resolves.toMatchObject({ status: 'migratable' })
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('uses stable relative identities across relocated code trees and detects module deletion', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pulse-build-location-'))
  try {
    const source = join(root, 'source'), relocated = join(root, 'relocated')
    await mkdir(join(source, 'nested'), { recursive: true })
    await writeFile(join(source, 'index.js'), 'import "./nested/state.js"')
    await writeFile(join(source, 'nested/state.js'), 'export const state = 1')
    await cp(source, relocated, { recursive: true })
    const before = recoveryBuildFingerprint([{ name: 'server', directory: source }])
    expect(recoveryBuildFingerprint([{ name: 'server', directory: relocated }])).toBe(before)
    await rm(join(relocated, 'nested/state.js'))
    expect(recoveryBuildFingerprint([{ name: 'server', directory: relocated }])).not.toBe(before)
  } finally { await rm(root, { recursive: true, force: true }) }
})
