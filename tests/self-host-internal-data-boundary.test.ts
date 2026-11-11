/** Synthetic repositories only. Never opens real Pulse data or rewrites user history. */
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { H5WorkspaceManager } from '../packages/server/src/h5/workspaces.js'

const exec = promisify(execFile), roots: string[] = []
const git = async (cwd: string, ...args: string[]) => (await exec('git', args, { cwd, encoding: 'utf8' })).stdout
const put = async (file: string, body = 'SYNTHETIC_INTERNAL_HISTORY\n') => { await mkdir(dirname(file), { recursive: true }); await writeFile(file, body) }
async function fixture(options: { inside?: boolean; custom?: boolean } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pulse-data-boundary-'))); roots.push(root)
  const project = join(root, 'project'), data = options.inside ? join(project, options.custom ? 'private-state' : '.pulse-data') : join(root, 'data')
  await mkdir(project); await mkdir(join(root, 'hooks'))
  await git(project, 'init', '--quiet'); await git(project, 'config', 'user.name', 'Fixture'); await git(project, 'config', 'user.email', 'fixture@localhost')
  await git(project, 'config', 'core.hooksPath', join(root, 'hooks')); await git(project, 'config', 'commit.gpgSign', 'false'); await git(project, 'config', 'core.autocrlf', 'false')
  await put(join(project, 'code.txt'), 'base\n'); await put(join(project, 'user.txt'), 'base\n')
  await put(join(project, '.gitignore'), '.pulse/\n.pulse-*/\nprivate-state/\n')
  await git(project, 'add', '.'); await git(project, 'commit', '--quiet', '-m', 'fixture baseline')
  const manager = new H5WorkspaceManager(data)
  return { root, project, data, manager }
}
async function userEdits(project: string) {
  await put(join(project, 'user.txt'), 'staged\n'); await git(project, 'add', 'user.txt'); await put(join(project, 'user.txt'), 'unstaged\n'); await put(join(project, 'new.txt'), 'untracked\n')
}
async function state(project: string) {
  return { head: await git(project, 'rev-parse', 'HEAD'), index: await readFile(join(project, '.git/index')), staged: await git(project, 'diff', '--cached', '--binary'), code: await readFile(join(project, 'code.txt')), user: await readFile(join(project, 'user.txt')) }
}
const prepare = (f: Awaited<ReturnType<typeof fixture>>) => f.manager.prepare('conv', 'project', f.project, { isolated: true, externalValidation: true })
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

describe('self-host known internal-data boundary', () => {
  it.each(['untracked-ignored', 'untracked-visible', 'tracked-ignored', 'tracked-workspaces', 'untracked-uppercase', 'tracked-uppercase'])('rejects %s before creating a candidate and preserves user state', async mode => {
    const f = await fixture({ inside: true })
    const internal = mode === 'tracked-workspaces' ? '.pulse-data/workspaces/archive/history.txt' : mode.endsWith('uppercase') ? '.PULSE/conversations/history.txt' : '.pulse/conversations/history.txt'
    if (mode === 'untracked-visible') await put(join(f.project, '.gitignore'), '')
    await put(join(f.project, internal))
    if (mode.startsWith('tracked')) { await git(f.project, 'add', '-f', internal); await git(f.project, 'commit', '--quiet', '-m', 'synthetic history') }
    await userEdits(f.project); const before = await state(f.project)
    await expect(prepare(f)).rejects.toThrow('SELF_HOST_INTERNAL_DATA_PRESENT')
    expect(await f.manager.get('conv')).toBeUndefined(); expect(await state(f.project)).toEqual(before)
    expect(await readFile(join(f.project, internal), 'utf8')).toBe('SYNTHETIC_INTERNAL_HISTORY\n')
    await f.manager.close()
  })

  it.each(['ancestor', 'other-branch', 'reflog-only'])('rejects protected %s history even with a clean current tree', async mode => {
    const f = await fixture(), initial = (await git(f.project, 'symbolic-ref', '--short', 'HEAD')).trim()
    if (mode !== 'ancestor') await git(f.project, 'checkout', '--quiet', '-b', 'synthetic-private')
    await put(join(f.project, '.pulse/conversations/history.txt')); await git(f.project, 'add', '-f', '.pulse'); await git(f.project, 'commit', '--quiet', '-m', 'synthetic history')
    if (mode === 'ancestor') { await git(f.project, 'rm', '-r', '--quiet', '.pulse'); await git(f.project, 'commit', '--quiet', '-m', 'remove synthetic history') }
    else { await git(f.project, 'checkout', '--quiet', initial); if (mode === 'reflog-only') await git(f.project, 'branch', '-D', 'synthetic-private') }
    await userEdits(f.project); const before = await state(f.project)
    await expect(prepare(f)).rejects.toThrow('SELF_HOST_INTERNAL_HISTORY_PRESENT')
    expect(await state(f.project)).toEqual(before); expect(await f.manager.get('conv')).toBeUndefined(); await f.manager.close()
  })

  it.each(['shallow', 'partial', 'replacement', 'alternates', 'grafts'])('fails closed for %s history without changing the repository', async mode => {
    const f = await fixture(), head = (await git(f.project, 'rev-parse', 'HEAD')).trim()
    if (mode === 'shallow') await put(join(f.project, '.git/shallow'), head + '\n')
    if (mode === 'partial') await git(f.project, 'config', 'remote.fixture.promisor', 'true')
    if (mode === 'replacement') await git(f.project, 'update-ref', 'refs/replace/' + head, head)
    if (mode === 'alternates') { const objects = join(f.root, 'empty-objects'); await mkdir(objects); await put(join(f.project, '.git/objects/info/alternates'), objects + '\n') }
    if (mode === 'grafts') await put(join(f.project, '.git/info/grafts'), head + '\n')
    const before = await readFile(join(f.project, '.git/index'))
    await expect(prepare(f)).rejects.toThrow('SELF_HOST_HISTORY_UNVERIFIABLE')
    expect(await readFile(join(f.project, '.git/index'))).toEqual(before); await f.manager.close()
  })

  it('recognizes a custom data directory, even when ignored', async () => {
    const f = await fixture({ inside: true, custom: true }); await put(join(f.data, 'conversations/history.txt'))
    await expect(prepare(f)).rejects.toThrow('SELF_HOST_INTERNAL_DATA_PRESENT'); await f.manager.close()
  })

  it('allows clean code with only its own untracked runtime workspaces and preserves the user index', async () => {
    const f = await fixture({ inside: true }); await userEdits(f.project); const before = await state(f.project)
    const candidate = await prepare(f); await put(join(candidate.cwd, 'code.txt'), 'task\n')
    expect((await f.manager.finishVerified('conv', async () => {})).status).toBe('merged')
    const after = await state(f.project); expect({ ...after, code: before.code }).toEqual(before); expect(after.code.toString()).toBe('task\n'); await f.manager.close()
  }, 30_000)

  it.each(['project', 'candidate', 'custom-candidate'])('blocks new internal files in the %s before staging or validation', async mode => {
    const f = await fixture({ inside: mode === 'custom-candidate', custom: true }), candidate = await prepare(f)
    await put(join(candidate.cwd, 'code.txt'), 'task\n')
    const file = join(mode === 'project' ? f.project : candidate.cwd, mode === 'custom-candidate' ? 'private-state/history.txt' : '.pulse/history.txt')
    await put(file); const before = await state(f.project); const indexBefore = await git(candidate.cwd, 'diff', '--cached', '--binary')
    let calls = 0
    await expect(f.manager.finishVerified('conv', async () => { calls++ })).rejects.toMatchObject({ message: 'SELF_HOST_INTERNAL_DATA_PRESENT', selfHostMerge: 'not_applied' })
    expect(calls).toBe(0); expect(await state(f.project)).toEqual(before); expect(await git(candidate.cwd, 'diff', '--cached', '--binary')).toBe(indexBefore)
    expect(await readFile(file, 'utf8')).toBe('SYNTHETIC_INTERNAL_HISTORY\n'); await f.manager.close()
  })

  it('rechecks ignored internal data added during integration validation', async () => {
    const f = await fixture(), candidate = await prepare(f); await put(join(candidate.cwd, 'code.txt'), 'task\n'); const before = await state(f.project)
    await expect(f.manager.finishVerified('conv', async cwd => { await put(join(cwd, '.pulse/history.txt')) })).rejects.toMatchObject({ message: 'SELF_HOST_INTERNAL_DATA_PRESENT', selfHostMerge: 'not_applied' })
    expect(await state(f.project)).toEqual(before); await f.manager.close()
  })

  it('rechecks an existing candidate on resume', async () => {
    const f = await fixture(), candidate = await prepare(f); await put(join(candidate.cwd, '.pulse/history.txt'))
    await expect(prepare(f)).rejects.toThrow('SELF_HOST_INTERNAL_DATA_PRESENT'); await f.manager.close()
  })

  it('does not change ordinary isolated task behavior', async () => {
    const f = await fixture(); await put(join(f.project, '.gitignore'), ''); await put(join(f.project, '.pulse/history.txt'))
    const candidate = await f.manager.prepare('ordinary', 'project', f.project, { isolated: true })
    expect(await readFile(join(candidate.cwd, '.pulse/history.txt'), 'utf8')).toBe('SYNTHETIC_INTERNAL_HISTORY\n'); await f.manager.close()
  })
})


it('cannot upgrade a shared workspace into self-host isolation on resume', async () => {
  const f = await fixture(); await f.manager.prepare('conv', 'project', f.project)
  await expect(prepare(f)).rejects.toThrow('SELF_HOST_ISOLATION_REQUIRED')
  expect((await f.manager.get('conv'))?.kind).toBe('shared'); await f.manager.close()
})

it('persists validation requirements when upgrading an ordinary isolated candidate', async () => {
  const f = await fixture(); const candidate = await f.manager.prepare('conv', 'project', f.project, { isolated: true })
  await prepare(f); expect((await f.manager.get('conv'))?.externalValidation).toBe(true)
  await put(join(candidate.cwd, 'code.txt'), 'task\n')
  expect(await f.manager.finish('conv', true)).toEqual({ status: 'pending' })
  expect(await readFile(join(f.project, 'code.txt'), 'utf8')).toBe('base\n'); await f.manager.close()
})
