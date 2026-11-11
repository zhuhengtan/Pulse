import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defaultPulseConfig, loadPulseConfig, mergePulseConfigs, parseTaskAdmission, sanitizeWorkspaceConfig } from '../packages/cli/src/config.js'
import { hostOptions, parse } from '../packages/cli/src/bin.js'
import { h5RuntimeOptions } from '../packages/cli/src/commands/h5.js'

const directories: string[] = []
afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'pulse-admission-config-'))
  directories.push(root)
  vi.stubEnv('PULSE_HOME', join(root, 'home'))
  vi.stubEnv('PULSE_CONFIG', '')
  const workspace = join(root, 'workspace')
  await mkdir(join(workspace, '.pulse'), { recursive: true })
  return { root, workspace }
}

describe('host-owned task admission config', () => {
  it('leaves defaults to the admission store and accepts partial limits', () => {
    expect(defaultPulseConfig).not.toHaveProperty('taskAdmission')
    expect(parseTaskAdmission(undefined)).toBeUndefined()
    expect(parseTaskAdmission({})).toEqual({})
    expect(parseTaskAdmission({ maxRunning: 16, maxQueued: 0 })).toEqual({ maxRunning: 16, maxQueued: 0 })
    expect(parseTaskAdmission({ maxRunning: 1, maxQueued: 256 })).toEqual({ maxRunning: 1, maxQueued: 256 })
    expect(parseTaskAdmission({ maxQueued: 8 })).toEqual({ maxQueued: 8 })
  })
  it.each([null, [], true, '2', 2])('rejects a malformed config: %j', value => {
    expect(() => parseTaskAdmission(value)).toThrow('INVALID_TASK_ADMISSION_CONFIG')
  })
  it.each([
    ['maxRunning', 0], ['maxRunning', 17], ['maxRunning', 1.5], ['maxRunning', '2'],
    ['maxQueued', -1], ['maxQueued', 257], ['maxQueued', 0.5], ['maxQueued', false],
    ['maxRunning', NaN], ['maxQueued', Infinity], ['maxQueued', null],
  ])('rejects invalid %s limit %j', (key, value) => {
    expect(() => parseTaskAdmission({ [key]: value })).toThrow(`INVALID_TASK_ADMISSION_LIMIT:${key}`)
  })
  it('strips workspace limits without mutating the input', () => {
    const value = { taskAdmission: { maxRunning: 16, maxQueued: 256 } }
    expect(sanitizeWorkspaceConfig(value)).not.toHaveProperty('taskAdmission')
    expect(mergePulseConfigs([{ trust: 'user', value: { taskAdmission: { maxRunning: 2 } } }, { trust: 'workspace', value }]).taskAdmission).toEqual({ maxRunning: 2 })
    expect(value.taskAdmission.maxRunning).toBe(16)
  })
  it.each([false, true])('ignores even malformed workspace admission with trustWorkspace=%s', async trust => {
    const { workspace } = await fixture()
    await writeFile(join(workspace, '.pulse/config.json'), JSON.stringify({ taskAdmission: { maxRunning: 'untrusted' } }))
    expect((await loadPulseConfig(workspace, undefined, trust)).value).not.toHaveProperty('taskAdmission')
  })
  it.each(['all', 'host'] as const)('validates host configuration in %s scope', async scope => {
    const { root, workspace } = await fixture()
    const path = join(root, 'host.json')
    await writeFile(path, JSON.stringify({ taskAdmission: { maxQueued: 257 } }))
    await expect(loadPulseConfig(workspace, path, true, scope)).rejects.toThrow('INVALID_TASK_ADMISSION_LIMIT:maxQueued')
  })
  it('maps host limits through the common CLI and H5 options without invoking a model', async () => {
    const { root, workspace } = await fixture()
    const path = join(root, 'host.json')
    const taskAdmission = { maxRunning: 3, maxQueued: 0 }
    await writeFile(path, JSON.stringify({ ...defaultPulseConfig, taskAdmission }))
    await writeFile(join(workspace, '.pulse/config.json'), JSON.stringify({ taskAdmission: { maxRunning: 16 } }))
    const options = await hostOptions(parse(['--config', path, '--cwd', workspace, '--trust-workspace']))
    expect(options.taskAdmission).toEqual(taskAdmission)
    expect(h5RuntimeOptions(options).taskAdmission).toEqual(taskAdmission)
  })
})
