import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { h5DaemonArguments, h5RuntimeOptions, runH5Command } from '../packages/cli/src/commands/h5.js'
import { DEFAULT_H5_PORT } from '../packages/server/src/h5/server.js'
import { parse } from '../packages/cli/src/bin.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('H5 CLI Command', () => {
  it('uses a separate port from Jarvis and preserves custom ports in daemon arguments', () => {
    expect(DEFAULT_H5_PORT).toBe(7332)
    const args = h5DaemonArguments('/node', '/pulse/bin.js', 8042)
    expect(parse(args.slice(2))).toMatchObject({ command: 'h5', positionals: ['daemon'], options: { port: '8042' } })
  })

  it('rejects invalid or ephemeral installed ports before touching service management', async () => {
    expect(await runH5Command({}, ['install'], { port: 'invalid' })).toBe(1)
    expect(await runH5Command({}, ['install'], { port: '0' })).toBe(1)
  })
  it('parses h5 commands and subcommands correctly', () => {
    const parsed = parse(['h5', 'devices'])
    expect(parsed.command).toBe('h5')
    expect(parsed.positionals).toEqual(['devices'])

    const parsedQr = parse(['h5', 'qr'])
    expect(parsedQr.command).toBe('h5')
    expect(parsedQr.positionals).toEqual(['qr'])
  })

  it('runs pulse h5 devices with empty device store without error', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'h5-cli-test-'))
    temporaryDirectories.push(dir)

    const code = await runH5Command({ dataDir: dir, root: dir }, ['devices'])
    expect(code).toBe(0)
  })

  it('reports status cleanly when launchd service is not installed', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'h5-cli-test-'))
    temporaryDirectories.push(dir)

    const code = await runH5Command({ dataDir: dir, root: dir }, ['status'])
    expect(code).toBe(0)
  })

  it('rejects unknown subcommands without starting a server', async () => {
    const code = await runH5Command({ dataDir: '/tmp', root: '/tmp' }, ['definitely-not-a-command'])
    expect(code).toBe(1)
  })

  it('does not inherit auto approval unless the h5 command asks for it', () => {
    expect(h5RuntimeOptions({ approvalMode: 'auto' }).approvalMode).toBe('ask')
    expect(h5RuntimeOptions({ approvalMode: 'auto' }, { 'approval-mode': 'auto' }).approvalMode).toBe('auto')
    expect(h5RuntimeOptions({ approvalMode: 'read-only' }).approvalMode).toBe('read-only')
  })
})
