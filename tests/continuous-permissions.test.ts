import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PulseRuntime, defineLaneProgram } from '@hunterzhu/pulse-runtime'
import { approvalReuseIdentity, hasApprovalGrant } from '../packages/server/src/approval-reuse.js'
import { assertExplicitToolRestriction } from '../packages/server/src/task-controller/explicit-restrictions.js'
import { hostOptions, parse } from '../packages/cli/src/bin.js'

beforeEach(() => { vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('UNEXPECTED_MODEL_OR_NETWORK_REQUEST')) })
const dirs: string[] = []
afterEach(async () => { expect(globalThis.fetch).not.toHaveBeenCalled(); vi.restoreAllMocks(); vi.unstubAllEnvs(); await Promise.all(dirs.splice(0).map(p => rm(p, { recursive: true, force: true }))) })
async function directory() { const dir = await mkdtemp(join(tmpdir(), 'pulse-permissions-')); dirs.push(dir); return dir }

it('reuses only an identical automatic grant and invalidates changed files, contract, operation and reviewer', async () => {
  const workspace = await directory()
  await promisify(execFile)('git', ['init', '-q'], { cwd: workspace })
  await writeFile(join(workspace, 'source.txt'), 'v1')
  const runtime = new PulseRuntime(), program = defineLaneProgram({ id: 'authority', version: '57' }, b => b.addStep('wait', () => ({ actions: [], next: 'wait' })))
  const { agentId } = runtime.createAgent('task', program), agent = runtime.state.agents.get(agentId)!
  const input: Parameters<typeof approvalReuseIdentity>[0] = { runtime, effect: { agentId, ownerLaneId: agent.rootLaneId } as any, mode: 'auto', manuallyApproved: false, workspace, name: 'fs.write', args: { path: 'result.txt', content: 'same' }, intent: 'Create the requested output', model: 'mock', reviewer: { model: 'mock-review' }, manifest: { name: 'fs.write', sideEffectPolicy: 'write', version: '1' } as any }
  await writeFile(join(workspace, '.gitignore'), 'ignored.txt\n')
  await writeFile(join(workspace, 'ignored.txt'), 'untracked dependency')
  expect(await approvalReuseIdentity({ ...input, name: 'fs.apply_patch', args: { path: 'ignored.txt', find: 'a', replace: 'b' } })).toBeUndefined()
  const key = await approvalReuseIdentity(input)
  expect(key).toBeTruthy(); expect(await approvalReuseIdentity(input)).toBe(key)
  runtime.state.events.push({ type: 'effect.execution_metadata', data: { approvalFingerprint: key, approvalGranted: true } } as any)
  expect(hasApprovalGrant(runtime, await approvalReuseIdentity(input))).toBe(true)
  expect(hasApprovalGrant(runtime, await approvalReuseIdentity({ ...input, args: { path: 'other.txt', content: 'same' } }))).toBe(false)
  expect(hasApprovalGrant(runtime, await approvalReuseIdentity({ ...input, reviewer: { model: 'different' } }))).toBe(false)
  await writeFile(join(workspace, 'source.txt'), 'v2')
  expect(hasApprovalGrant(runtime, await approvalReuseIdentity(input))).toBe(false)
  await writeFile(join(workspace, 'source.txt'), 'v1')
  agent.globalVersions.set(agent.latestGlobalVersion, { taskRecord: { acceptanceCriteria: [{ description: 'Do not modify source.txt' }] } })
  expect(hasApprovalGrant(runtime, await approvalReuseIdentity(input))).toBe(false)
  expect(await approvalReuseIdentity({ ...input, manuallyApproved: true })).toBeUndefined()
  expect(await approvalReuseIdentity({ ...input, mode: 'ask' })).toBeUndefined()
})

it('refuses approval reuse without a bounded dependency snapshot or for unknown external commands', async () => {
  const workspace = await directory(), runtime = new PulseRuntime(), program = defineLaneProgram({ id: 'a', version: '57' }, b => b.addStep('wait', () => ({ actions: [], next: 'wait' })))
  const { agentId } = runtime.createAgent('task', program), ownerLaneId = runtime.state.agents.get(agentId)!.rootLaneId
  const input: Parameters<typeof approvalReuseIdentity>[0] = { runtime, effect: { agentId, ownerLaneId } as any, mode: 'auto', manuallyApproved: false, workspace, name: 'fs.write', args: {}, intent: 'task', model: 'mock', reviewer: null, manifest: { sideEffectPolicy: 'write' } as any }
  expect(await approvalReuseIdentity(input)).toBeUndefined()
  expect(await approvalReuseIdentity({ ...input, name: 'shell.exec', args: { command: 'unknown-command', args: [] }, manifest: { sideEffectPolicy: 'external' } as any })).toBeUndefined()
})

it('applies command prohibitions to asynchronous starts', () => {
  expect(() => assertExplicitToolRestriction('Do not run any commands', 'shell.start', { command: 'node', args: ['a.js'] })).toThrow()
})

it('resolves the CLI switch using an isolated mock-only configuration', async () => {
  const dir = await directory(), config = join(dir, 'config.json')
  vi.stubEnv('PULSE_HOME', dir); vi.stubEnv('PULSE_CONFIG', config)
  await writeFile(config, JSON.stringify({ providers: { local: { provider: 'mock', models: { test: { modelCode: 'mock', tools: 'supported' } } } }, activeModel: 'local/test', jarvis: { enabled: false } }))
  const options = await hostOptions(parse(['run', '--config', config, '--cwd', dir, '--task-controller-policy', 'continuous']))
  expect(options).toMatchObject({ taskControllerPolicy: 'continuous', provider: { provider: 'mock' } })
  expect((await hostOptions(parse(['run', '--config', config, '--cwd', dir]))).taskControllerPolicy).toBe('legacy')
  await expect(hostOptions(parse(['run', '--config', config, '--cwd', dir, '--task-controller-policy', 'invalid']))).rejects.toThrow('INVALID_TASK_CONTROLLER_POLICY')
})
