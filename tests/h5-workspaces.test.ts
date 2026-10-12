import { execFile } from 'node:child_process'
import { mkdtemp, readFile, mkdir, rm, writeFile } from 'node:fs/promises'
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

async function repository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'pulse-workspace-test-'))
  roots.push(root)
  await git(root, 'init', '--quiet')
  // Fixture assertions compare exact bytes, independent of the user's Git defaults.
  await git(root, 'config', 'core.autocrlf', 'false')
  await git(root, 'config', 'user.name', 'Pulse Test')
  await git(root, 'config', 'user.email', 'pulse-test@localhost')
  await writeFile(join(root, 'code.txt'), 'base one\nbase two\n')
  await writeFile(join(root, 'staged.txt'), 'base\n')
  await git(root, 'add', '.')
  await git(root, 'commit', '--quiet', '-m', 'baseline')
  return root
}

afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

describe('H5 isolated project workspaces', () => {
  it('merges task commits even when the task worktree is clean', async () => {
    const project = await repository()
    const manager = new H5WorkspaceManager(join(project, '.pulse-data'))
    const prepared = await manager.prepare('conv-committed', 'project-1', project)
    await writeFile(join(prepared.cwd, 'code.txt'), 'committed result\n')
    await git(prepared.cwd, 'add', '.')
    await git(prepared.cwd, 'commit', '--quiet', '-m', 'Task commit')
    expect(await manager.finish('conv-committed', true)).toMatchObject({ status: 'merged' })
    expect(await readFile(join(project, 'code.txt'), 'utf8')).toBe('committed result\n')
    await manager.close()
  })

  it('retries an already committed conflict without discarding its result', async () => {
    const project = await repository()
    const manager = new H5WorkspaceManager(join(project, '.pulse-data'))
    const prepared = await manager.prepare('conv-retry', 'project-1', project)
    await writeFile(join(prepared.cwd, 'code.txt'), 'task result\n')
    await writeFile(join(project, 'code.txt'), 'conflicting user result\n')
    expect((await manager.finish('conv-retry', true)).status).toBe('conflict')
    await writeFile(join(project, 'code.txt'), 'base one\nbase two\n')
    await manager.prepare('conv-retry', 'project-1', project)
    expect((await manager.finish('conv-retry', true)).status).toBe('merged')
    expect(await readFile(join(project, 'code.txt'), 'utf8')).toBe('task result\n')
    await manager.close()
  })

  it.each([false, true])('reacquires the non-Git lock after failure (legacy record: %s)', async (legacy) => {
    const parent = await mkdtemp(join(tmpdir(), 'pulse-workspace-retry-'))
    roots.push(parent)
    const project = join(parent, 'project')
    await mkdir(project)
    const data = join(parent, 'data')
    const first = new H5WorkspaceManager(data)
    await first.prepare('conv-retry', 'project-1', project)
    await first.finish('conv-retry', false)
    await first.close()
    if (legacy) {
      const path = join(data, 'workspaces', 'records', 'conv-retry.json')
      const record = JSON.parse(await readFile(path, 'utf8'))
      delete record.kind
      await writeFile(path, JSON.stringify(record))
    }
    const resumed = new H5WorkspaceManager(data)
    const other = new H5WorkspaceManager(data)
    try {
      expect(await resumed.prepare('conv-retry', 'project-1', project)).toMatchObject({ isolated: false })
      await expect(other.prepare('conv-other', 'project-1', project)).rejects.toThrow('PROJECT_DIRECTORY_BUSY')
      expect((await resumed.finish('conv-retry', true)).status).toBe('merged')
      expect(await other.prepare('conv-other', 'project-1', project)).toMatchObject({ isolated: false })
    } finally { await resumed.close(); await other.close() }
  })

  it('starts from staged, unstaged and untracked content, then merges without changing the original index', async () => {
    const project = await repository()
    const dataDir = join(project, '.pulse-data')
    const manager = new H5WorkspaceManager(dataDir)
    await writeFile(join(project, 'staged.txt'), 'user staged\n')
    await git(project, 'add', 'staged.txt')
    await writeFile(join(project, 'code.txt'), 'user one\nbase two\n')
    await writeFile(join(project, 'untracked.txt'), 'user untracked\n')
    const indexBefore = await git(project, 'diff', '--cached', '--binary')

    const prepared = await manager.prepare('conv-merge', 'project-1', project)
    expect(prepared.isolated).toBe(true)
    expect(await readFile(join(prepared.cwd, 'staged.txt'), 'utf8')).toBe('user staged\n')
    expect(await readFile(join(prepared.cwd, 'code.txt'), 'utf8')).toBe('user one\nbase two\n')
    expect(await readFile(join(prepared.cwd, 'untracked.txt'), 'utf8')).toBe('user untracked\n')
    await writeFile(join(prepared.cwd, 'code.txt'), 'user one\ntask two\n')
    await writeFile(join(prepared.cwd, 'task.txt'), 'task output\n')

    const merged = await manager.finish('conv-merge', true)
    expect(merged, JSON.stringify(merged)).toMatchObject({ status: 'merged' })
    expect(await readFile(join(project, 'code.txt'), 'utf8')).toBe('user one\ntask two\n')
    expect(await readFile(join(project, 'task.txt'), 'utf8')).toBe('task output\n')
    expect(await git(project, 'diff', '--cached', '--binary')).toBe(indexBefore)
    await manager.close()
  })

  it('keeps conflicting output in its worktree and leaves the project untouched', async () => {
    const project = await repository()
    const manager = new H5WorkspaceManager(join(project, '.pulse-data'))
    const prepared = await manager.prepare('conv-conflict', 'project-1', project)
    await writeFile(join(prepared.cwd, 'code.txt'), 'task edit\nbase two\n')
    await writeFile(join(project, 'code.txt'), 'user edit\nbase two\n')

    const result = await manager.finish('conv-conflict', true)
    expect(result.status).toBe('conflict')
    expect(result.conflictPaths).toContain('code.txt')
    expect(await readFile(join(project, 'code.txt'), 'utf8')).toBe('user edit\nbase two\n')
    expect(await readFile(join(prepared.cwd, 'code.txt'), 'utf8')).toBe('task edit\nbase two\n')
    await manager.close()
  })

  it('serializes non-Git projects and rejects another concurrent worker', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'pulse-workspace-shared-'))
    roots.push(parent)
    const project = join(parent, 'project')
    await mkdir(project)
    const manager = new H5WorkspaceManager(join(parent, 'data'))
    const first = await manager.prepare('conv-shared-1', 'project-1', project)
    expect(first).toMatchObject({ cwd: await import('node:fs/promises').then(fs => fs.realpath(project)), isolated: false })
    await expect(manager.prepare('conv-shared-2', 'project-1', project)).rejects.toThrow('PROJECT_DIRECTORY_BUSY')
    await manager.finish('conv-shared-1', false)
    await expect(manager.prepare('conv-shared-2', 'project-1', project)).resolves.toMatchObject({ isolated: false })
    await manager.close()
  })
})
