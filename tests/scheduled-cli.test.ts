import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parse } from '../packages/cli/src/bin.js'
import { runScheduledCommand } from '../packages/cli/src/commands/scheduled.js'
import { ScheduledTaskStore } from '../packages/server/src/scheduled-tasks.js'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
  vi.restoreAllMocks()
})

describe('scheduled-task CLI', () => {
  it('parses the schedule command and persists explicit recurring tasks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pulse-schedule-cli-'))
    roots.push(root)
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const parsed = parse(['schedule', 'add', '--every', '15m', '--name', 'Daily health check', 'Inspect the workspace'])
    expect(parsed.command).toBe('schedule')
    expect(await runScheduledCommand({ cwd: root, dataDir: join(root, 'data') }, parsed.positionals, parsed.options)).toBe(0)
    const store = new ScheduledTaskStore(join(root, 'data', 'scheduled-tasks.json'))
    await expect(store.list()).resolves.toMatchObject([{ name: 'Daily health check', instruction: 'Inspect the workspace', intervalMs: 900_000 }])
    expect(stdout).toHaveBeenCalled()
    expect(JSON.parse(await readFile(join(root, 'data', 'scheduled-tasks.json'), 'utf8')).tasks).toHaveLength(1)
  })

  it('requires an explicit unattended approval mode before starting a worker', async () => {
    await expect(runScheduledCommand({ approvalMode: 'ask' }, ['run-once'], {})).rejects.toThrow('SCHEDULED_EXECUTION_REQUIRES_READ_ONLY_OR_AUTO_APPROVAL')
    await expect(runScheduledCommand({}, ['daemon'], {})).rejects.toThrow('SCHEDULED_EXECUTION_REQUIRES_READ_ONLY_OR_AUTO_APPROVAL')
  })

  it('executes in the workspace where the schedule was created', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pulse-schedule-workspace-'))
    roots.push(root)
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const original = join(root, 'original')
    const other = join(root, 'other')
    const dataDir = join(root, 'data')
    await mkdir(original); await mkdir(other)
    await runScheduledCommand({ cwd: original, dataDir }, ['add', 'Write the report'], { every: '1h' })
    const file = join(dataDir, 'scheduled-tasks.json')
    const document = JSON.parse(await readFile(file, 'utf8'))
    document.tasks[0].nextRunAt = 0
    await writeFile(file, JSON.stringify(document))
    await runScheduledCommand({ cwd: other, dataDir, approvalMode: 'auto', mockToolCalls: [{ name: 'fs.write', input: { path: 'report.txt', content: 'correct workspace' } }] }, ['run-once'], {})
    expect(await readFile(join(original, 'report.txt'), 'utf8')).toBe('correct workspace')
    await expect(readFile(join(other, 'report.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('returns a nonzero status when run-once records failed tasks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pulse-schedule-failure-'))
    roots.push(root)
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const dataDir = join(root, 'data')
    const store = new ScheduledTaskStore(join(dataDir, 'scheduled-tasks.json'))
    await store.create({ name: 'unverifiable', instruction: 'Do a task', intervalMs: 1_000 })
    const file = join(dataDir, 'scheduled-tasks.json')
    const document = JSON.parse(await readFile(file, 'utf8')) as { tasks: Array<{ nextRunAt: number }> }
    document.tasks[0]!.nextRunAt = 0
    await writeFile(file, JSON.stringify(document))
    await expect(runScheduledCommand({ cwd: root, dataDir, approvalMode: 'auto', mockResponse: 'Done.' }, ['run-once'], {})).resolves.toBe(1)
  })

})
