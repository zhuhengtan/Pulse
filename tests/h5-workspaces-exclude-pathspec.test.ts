import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { H5WorkspaceManager } from '../packages/server/src/h5/workspaces.js'

const exec = promisify(execFile)
const roots: string[] = []

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await exec('git', args, { cwd, encoding: 'utf8' })).stdout
}

/** Real fixture repository: fixture-local Git settings only, never the user's. */
async function repository(gitignore: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'pulse-workspace-exclude-'))
  roots.push(root)
  await git(root, 'init', '--quiet')
  await git(root, 'config', 'core.autocrlf', 'false')
  await git(root, 'config', 'user.name', 'Pulse Test')
  await git(root, 'config', 'user.email', 'pulse-test@localhost')
  await writeFile(join(root, '.gitignore'), gitignore)
  await writeFile(join(root, 'code.txt'), 'base one\nbase two\n')
  await writeFile(join(root, 'staged.txt'), 'base\n')
  await git(root, 'add', '.')
  await git(root, 'commit', '--quiet', '-m', 'baseline')
  return root
}

/** The merge path records the latest worktree snapshot as an unreachable
 * commit, so its tree is the only durable record of what `git add -A` staged. */
async function snapshotTrees(root: string): Promise<string[][]> {
  const unreachable = await git(root, 'fsck', '--unreachable', '--no-progress')
  const commits = unreachable.split(/\r?\n/)
    .filter(line => /(?:unreachable|dangling) commit [0-9a-f]{40,64}$/.test(line.trim()))
    .map(line => line.trim().split(' ').pop() as string)
  const trees: string[][] = []
  for (const commit of commits) {
    const body = await git(root, 'cat-file', 'commit', commit).catch(() => '')
    if (!body.includes('Pulse latest project snapshot')) continue
    trees.push((await git(root, 'ls-tree', '-r', '--name-only', commit)).split(/\r?\n/).filter(Boolean))
  }
  return trees
}

afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

describe('H5 snapshot excludes only the runtime directories Git would stage', () => {
  it('merges the task when its data directory sits inside an ignored parent directory', async () => {
    const project = await repository('.pulse-dev/\n')
    const dataDir = join(project, '.pulse-dev', 'h5', 'data')
    const manager = new H5WorkspaceManager(dataDir)
    const prepared = await manager.prepare('conv-ignored-data', 'project-1', project)
    expect(prepared.isolated).toBe(true)
    await writeFile(join(prepared.cwd, 'code.txt'), 'task result\n')
    await writeFile(join(prepared.cwd, 'task.txt'), 'task output\n')

    // The user keeps working while the task runs: ignore rules, a staged file
    // and an untracked file all belong to the user, not to this merge.
    await writeFile(join(project, '.gitignore'), '.pulse-dev/\nartifacts/*\n')
    await writeFile(join(project, 'staged.txt'), 'user staged\n')
    await git(project, 'add', 'staged.txt')
    const indexBefore = await git(project, 'diff', '--cached', '--binary')
    const gitignoreBefore = await readFile(join(project, '.gitignore'), 'utf8')

    const merged = await manager.finish('conv-ignored-data', true)
    expect(merged, JSON.stringify(merged)).toMatchObject({ status: 'merged' })
    expect(await readFile(join(project, 'code.txt'), 'utf8')).toBe('task result\n')
    expect(await readFile(join(project, 'task.txt'), 'utf8')).toBe('task output\n')
    expect(await readFile(join(project, '.gitignore'), 'utf8')).toBe(gitignoreBefore)
    expect(await git(project, 'diff', '--cached', '--binary')).toBe(indexBefore)
    expect((await git(project, 'config', '--local', '--get', 'user.name')).trim()).toBe('Pulse Test')
    await manager.close()
  }, process.platform === 'win32' ? 120_000 : 60_000)

  it('keeps an unignored runtime workspace out of the merge snapshot', async () => {
    const project = await repository('artifacts/*\n')
    const dataDir = join(project, '.pulse-data')
    const manager = new H5WorkspaceManager(dataDir)
    const prepared = await manager.prepare('conv-unignored-data', 'project-1', project)
    expect(prepared.isolated).toBe(true)
    await writeFile(join(prepared.cwd, 'task.txt'), 'task output\n')

    await writeFile(join(project, '.gitignore'), 'artifacts/*\n.local-cache/\n')
    await writeFile(join(project, 'staged.txt'), 'user staged\n')
    await git(project, 'add', 'staged.txt')
    await writeFile(join(project, 'untracked.txt'), 'user untracked\n')
    const indexBefore = await git(project, 'diff', '--cached', '--binary')
    const gitignoreBefore = await readFile(join(project, '.gitignore'), 'utf8')

    const merged = await manager.finish('conv-unignored-data', true)
    expect(merged, JSON.stringify(merged)).toMatchObject({ status: 'merged' })
    expect(await readFile(join(project, 'task.txt'), 'utf8')).toBe('task output\n')
    expect(await readFile(join(project, '.gitignore'), 'utf8')).toBe(gitignoreBefore)
    expect(await git(project, 'diff', '--cached', '--binary')).toBe(indexBefore)

    // `.pulse-data` is untracked here and not ignored, so only the explicit
    // exclude pathspec can keep the runtime workspaces out of the snapshot.
    const trees = await snapshotTrees(project)
    expect(trees.length, 'no Pulse latest project snapshot commit was created').toBeGreaterThan(0)
    for (const files of trees) {
      expect(files, 'git add -A did not pick up the user worktree at all').toContain('untracked.txt')
      expect(files.filter(path => path === '.pulse-data' || path.startsWith('.pulse-data/'))).toEqual([])
    }
    expect(JSON.parse(await readFile(join(dataDir, 'workspaces', 'records', 'conv-unignored-data.json'), 'utf8')).status).toBe('merged')
    await manager.close()
  }, process.platform === 'win32' ? 120_000 : 60_000)
})
