import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { DesktopBackend } from '../packages/server/src/automation/desktop.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
const bounds = { x: 0, y: 0, width: 100, height: 100 }
const windows = [{ id: 'w1', title: 'Fake', app_name: 'Fake', pid: 1, is_focused: true, bounds }]

async function fakeAgent(typeBehavior: string) {
  const root = await mkdtemp(join(tmpdir(), 'pulse-fake-agent-')); roots.push(root)
  const file = join(root, 'agent-desktop')
  const script = `#!/usr/bin/env node
const args = process.argv.slice(2)
if (args.includes('list-windows')) { console.log(JSON.stringify({ ok: true, data: ${JSON.stringify(windows)} })); process.exit(0) }
${typeBehavior}
`
  await writeFile(file, script); await chmod(file, 0o755)
  await writeFile(join(root, 'manifest.json'), JSON.stringify({ backend: 'agent-desktop', version: '1.2.0', platform: process.platform, arch: process.arch, hashes: { 'agent-desktop': createHash('sha256').update(script).digest('hex') } }))
  return new DesktopBackend(file, undefined, join(root, 'state'))
}
const observation = () => ({ title: 'Fake', text: '{}', contentFingerprint: 'x', width: 100, height: 100, geometry: JSON.stringify(['w1', 1, undefined, bounds]), captureScope: 'window' as const, targetWindowId: 'w1', captureBounds: bounds, refs: ['r1'], focusedRef: 'r1' })
const large = 'x'.repeat(1024 * 1024)
// The fake agent is a shebang script, which Windows CreateProcess cannot launch directly and there is no existing
// cross-platform test launcher. Windows therefore has no real-process regression for stdin failure yet.
const posixIt = process.platform === 'win32' ? it.skip : it

posixIt('turns a child that exits before reading stdin into a controlled unknown-result error and stays usable', async () => {
  const backend = await fakeAgent(`if (args.includes('type')) process.exit(0)
console.log(JSON.stringify({ ok: true, data: {} }))`)
  await expect(backend.act({ type: 'type', text: large } as any, observation() as any)).rejects.toMatchObject({ code: 'DESKTOP_ACTION_RESULT_UNKNOWN' })
  await expect(backend.call('windows')).resolves.toHaveLength(1)
  await backend.close()
})

posixIt('does not report success when the child answers ok but never consumed the input', async () => {
  const backend = await fakeAgent(`if (args.includes('type')) { console.log(JSON.stringify({ ok: true, data: {} })); process.exit(0) }`)
  await expect(backend.act({ type: 'type', text: large } as any, observation() as any)).rejects.toMatchObject({ code: 'DESKTOP_ACTION_RESULT_UNKNOWN' })
  await backend.close()
})

posixIt('keeps the child error when it fails before reading stdin', async () => {
  const backend = await fakeAgent(`if (args.includes('type')) { console.log(JSON.stringify({ ok: false, error: { code: 'PERM_DENIED', message: 'no' } })); process.exit(1) }`)
  await expect(backend.act({ type: 'type', text: large } as any, observation() as any)).rejects.toMatchObject({ code: 'PERM_DENIED' })
  await backend.close()
})

posixIt('still succeeds when the child consumes the whole input', async () => {
  const backend = await fakeAgent(`if (args.includes('type')) { process.stdin.resume(); process.stdin.on('end', () => { console.log(JSON.stringify({ ok: true, data: {} })) }) }`)
  await expect(backend.act({ type: 'type', text: large } as any, observation() as any)).resolves.toBeUndefined()
  await backend.close()
})
