import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, expect, it } from 'vitest'
// @ts-expect-error standalone script
import { SelfHostRuntime, PROTOCOL } from '../scripts/self-host-runtime.mjs'
// @ts-expect-error standalone script
import { createSnapshot } from '../scripts/self-host-snapshot.mjs'

let tmp: string
const specs: Record<string, any> = {}
beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'pulse-runtime-'))
  for (const kind of ['good', 'second', 'busy', 'fail', 'badIdentity', 'silentResume', 'silentStop', 'healthError', 'healthNoOk', 'wrongPid', 'wrongVersion', 'wrongPort', 'envError']) {
    const source = path.join(tmp, kind)
    await fs.mkdir(source)
    await fs.writeFile(path.join(source, 'package.json'), JSON.stringify({ name: `fixture-${kind}`, version: '1.0.0', bin: 'cli.cjs', selfHostRuntimeProtocol: 1, selfHostRuntimeCommand: 'self-host-runtime' }))
    await fs.writeFile(path.join(source, 'cli.cjs'), `
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
net.connect = net.createConnection = () => { throw new Error('offline fixture'); };
if (process.env.PULSE_DATA_IPC_ROOT !== path.join(process.cwd(), 'ipc') || !fs.statSync(process.env.PULSE_DATA_IPC_ROOT).isDirectory()) throw new Error('isolated IPC directory required');
const writer = path.join(process.env.PULSE_DATA_DIR, 'writer');
let leaseId = 'lease', active = false;
const serverInstanceId = require('node:crypto').randomUUID();
function release() { if (active) { fs.unlinkSync(writer); active = false; } }
process.on('disconnect', () => { release(); process.exit(0); });
process.on('message', m => {
  if (m.type === 'stop') { if (${JSON.stringify(kind)} === 'silentStop') return; release(); process.exit(0); }
  let result = { ok: true, mode: 'maintenance', idle: true, leaseId, serverPid: process.pid, serverInstanceId, port: 12345, serverVersion: '1.0.0' };
  if (${JSON.stringify(kind)} === 'wrongPid') result.serverPid++;
  if (${JSON.stringify(kind)} === 'wrongVersion') result.serverVersion = '2.0.0';
  if (${JSON.stringify(kind)} === 'wrongPort') result.port = 0;
  if (m.type === 'quiesce' && ${JSON.stringify(kind)} === 'busy') result = { mode: 'active', busy: true };
  else if (m.type === 'quiesce') release();
  if (m.type === 'probe') result.ok = ${JSON.stringify(kind)} !== 'fail';
  if (m.type === 'resume') { fs.writeFileSync(writer, String(process.pid), {flag:'wx'}); active = true; result = {ok:true, mode:'active'}; }
  if (m.type === 'initialize' && ${JSON.stringify(kind)} === 'envError') result = {error: 'ISOLATED_ENV_NOT_CLEAN'};
  if (m.type === 'initialize' && ${JSON.stringify(kind)} === 'healthError') result.error = 'not healthy';
  if (m.type === 'initialize' && ${JSON.stringify(kind)} === 'healthNoOk') delete result.ok;
  if (m.type === 'resume' && ${JSON.stringify(kind)} === 'silentResume') return;
  if (${JSON.stringify(kind)} === 'badIdentity') m.identity.nonce = 'wrong';
  process.send({protocol:m.protocol, version:1, type:m.type+':result', requestId:m.requestId, identity:m.identity, ...result});
});
`)
    const built = await createSnapshot({ cliEntry: path.join(source, 'cli.cjs'), snapshot: path.join(tmp, `${kind}-capsule`), cwd: source })
    specs[kind] = { capsulePath: built.snapshot, expectedDigest: built.runtimeDigest, protocol: PROTOCOL, version: 1 }
  }
}, 20000)
afterAll(async () => { await fs.rm(tmp, { recursive: true, force: true }) })

it('switches real digest-verified children with a single writer and rolls back a failed probe', async () => {
  const root = path.join(tmp, 'run')
  const runtime = new SelfHostRuntime({ controlRoot: root })
  try {
    const first = await runtime.start(specs.good)
    const second = await runtime.switch(specs.second)
    expect(second.identity.pid).not.toBe(first.identity.pid)
    expect(second.identity.digest).toBe(specs.second.expectedDigest)
    expect(second.identity.nonce).not.toBe(first.identity.nonce)
    const rollback = await runtime.switch(specs.fail)
    expect(rollback.rolledBack).toBe(true)
    const audit = JSON.parse(await fs.readFile(path.join(root, 'state', 'journal.json'), 'utf8'))
    expect(audit.history.some((item: any) => item.phase === 'rolling_back')).toBe(true)
    expect(audit.rollbackReason).toBe('CANDIDATE_PROBE_FAILED')
    expect(audit.failedCandidate.expectedDigest).toBe(specs.fail.expectedDigest)
    expect(rollback.identity.digest).toBe(specs.second.expectedDigest)
    expect(await fs.readFile(path.join(root, 'data', 'writer'), 'utf8')).toBe(String(rollback.identity.pid))
    expect((await runtime.close()).phase).toBe('closed')
    await expect(fs.stat(path.join(root, 'data', 'writer'))).rejects.toThrow()
  } finally { if (runtime.status().phase === 'active') await runtime.close() }
})
it('rejects external digest changes, arbitrary launch arguments and pre-existing roots', async () => {
  const runtime = new SelfHostRuntime({ controlRoot: path.join(tmp, 'reject') })
  await expect(runtime.start({ ...specs.good, expectedDigest: '0'.repeat(64) })).rejects.toThrow()
  await expect(runtime.start({ ...specs.good, args: ['--config=/real/config'] })).rejects.toThrow()
  await expect(new SelfHostRuntime({ controlRoot: tmp }).start(specs.good)).rejects.toThrow()
})
it('keeps a busy owned child running and refuses concurrent operations', async () => {
  const runtime = new SelfHostRuntime({ controlRoot: path.join(tmp, 'busy-run') })
  try {
    const start = runtime.start(specs.busy)
    await expect(runtime.close()).rejects.toThrow('operation in progress')
    const original = await start
    const result = await runtime.switch(specs.good)
    expect(result.busy).toBe(true)
    expect(result.identity).toEqual(original.identity)
    expect((await runtime.close()).busy).toBe(true)
  } finally {
    // Fixture-only cleanup: disconnect owns this ChildProcess, whose handler exits.
    const child = runtime.child.process
    const exited = new Promise(resolve => child.once('exit', resolve))
    child.disconnect()
    await exited
  }
})

for (const kind of ['badIdentity', 'silentResume', 'silentStop', 'healthError', 'healthNoOk', 'wrongPid', 'wrongVersion', 'wrongPort']) {
  it(`blocks conservatively on ${kind}, retaining the lock without launching a replacement`, async () => {
    const root = path.join(tmp, `blocked-${kind}`)
    const runtime = new SelfHostRuntime({ controlRoot: root, timeoutMs: 200 })
    try {
      if (kind === 'silentStop') {
        await runtime.start(specs[kind])
        await expect(runtime.switch(specs.good)).rejects.toThrow('stop exit unconfirmed')
      } else await expect(runtime.start(specs[kind])).rejects.toThrow()
      expect(runtime.status().phase).toBe('blocked')
      expect(runtime.status().identity.digest).toBe(specs[kind].expectedDigest)
      expect((await fs.stat(path.join(root, 'state', 'lock'))).isDirectory()).toBe(true)
      await expect(runtime.switch(specs.good)).rejects.toThrow('runtime not active')
      await expect(new SelfHostRuntime({ controlRoot: root }).start(specs.good)).rejects.toThrow()
    } finally {
      const child = runtime.child.process
      if (!runtime.child.exited) {
        const exited = new Promise(resolve => child.once('exit', resolve))
        child.disconnect()
        await exited
      }
    }
  })
}

it('rejects overlapping capsule and sandbox paths before creating state', async () => {
  await expect(new SelfHostRuntime({ controlRoot: path.join(specs.good.capsulePath, 'run') }).start(specs.good)).rejects.toThrow('overlap')
})

for (const boundary of ['before-launch', 'after-health']) {
  it(`revalidates immutable capsule at ${boundary}`, async () => {
    const capsulePath = path.join(tmp, `mutable-${boundary}`)
    await fs.cp(specs.second.capsulePath, capsulePath, { recursive: true })
    const spec = { ...specs.second, capsulePath }
    const runtime = new SelfHostRuntime({ controlRoot: path.join(tmp, `mutation-${boundary}`) })
    const mutate = async () => { await fs.writeFile(path.join(capsulePath, 'unexpected-file'), 'tampered') }
    try {
      await runtime.start(specs.good)
      if (boundary === 'before-launch') {
        const stop = runtime.stop.bind(runtime)
        let once = false
        runtime.stop = async () => { await stop(); if (!once) { once = true; await mutate() } }
        const result = await runtime.switch(spec)
        expect(result.rolledBack).toBe(true)
        expect(result.identity.digest).toBe(specs.good.expectedDigest)
      } else {
        const request = runtime.request.bind(runtime)
        runtime.request = async (...args: any[]) => { const result = await request(...args); if (args[0] === 'probe') await mutate(); return result }
        await expect(runtime.switch(spec)).rejects.toThrow()
        expect(runtime.status().phase).toBe('blocked')
        expect(await fs.readdir(path.join(runtime.root, 'data'))).not.toContain('writer')
      }
      const journal = JSON.parse(await fs.readFile(path.join(runtime.root, 'state', 'journal.json'), 'utf8'))
      expect(journal.previous.expectedDigest).toBe(specs.good.expectedDigest)
      expect(journal.candidate.capsulePath).toBe(capsulePath)
      expect(journal.history.some((entry: any) => entry.phase === 'launch_planned')).toBe(true)
    } finally {
      if (runtime.status().phase === 'active') await runtime.close()
      else if (runtime.child && !runtime.child.exited) {
        const child = runtime.child.process
        const exited = new Promise(resolve => child.once('exit', resolve))
        child.disconnect(); await exited
      }
    }
  })
}

it('marks unexpected active disconnect blocked and never claims alive', async () => {
  const runtime = new SelfHostRuntime({ controlRoot: path.join(tmp, 'disconnect') })
  await runtime.start(specs.good)
  const child = runtime.child.process
  const exited = new Promise(resolve => child.once('exit', resolve))
  child.disconnect()
  await exited
  expect(runtime.status().alive).toBe(false)
  expect(runtime.status().phase).toBe('blocked')
})

it('does not spawn if the planned journal write fails', async () => {
  const runtime = new SelfHostRuntime({ controlRoot: path.join(tmp, 'journal-failure') })
  const journal = runtime.journal.bind(runtime)
  runtime.journal = async (phase: string, extra: any) => {
    if (phase === 'launch_planned') throw new Error('simulated journal failure')
    return journal(phase, extra)
  }
  await expect(runtime.start(specs.good)).rejects.toThrow('simulated journal failure')
  expect(runtime.child).toBe(null)
  expect(runtime.status().phase).toBe('blocked')
})

it('serializes delayed active journal writes before a disconnect blocked journal', async () => {
  const runtime = new SelfHostRuntime({ controlRoot: path.join(tmp, 'late-journal') })
  const journal = runtime.journal.bind(runtime)
  let disconnected: Promise<unknown> | undefined
  runtime.journal = async (phase: string, extra: any) => {
    if (phase !== 'active') return journal(phase, extra)
    // Stall the write queue, not the phase transition, to reproduce overlapping renames.
    runtime.journalQueue = runtime.journalQueue.then(() => new Promise(resolve => setTimeout(resolve, 60)))
    const active = journal(phase, extra)
    const child = runtime.child.process
    disconnected = new Promise(resolve => child.once('exit', resolve))
    child.disconnect()
    await active
  }
  await expect(runtime.start(specs.good)).rejects.toThrow('child lost during active journal commit')
  await disconnected
  await runtime.journalQueue
  const saved = JSON.parse(await fs.readFile(path.join(runtime.root, 'state', 'journal.json'), 'utf8'))
  expect(saved.phase).toBe('blocked')
  expect(runtime.status().phase).toBe('blocked')
  expect(runtime.status().alive).toBe(false)
})

it('reports safe phase-specific child failure without logging arbitrary child error text', async () => {
  const runtime = new SelfHostRuntime({ controlRoot: path.join(tmp, 'safe-error') })
  try {
    await expect(runtime.start(specs.envError)).rejects.toThrow('initialize failed: ISOLATED_ENV_NOT_CLEAN')
    expect(runtime.status().phase).toBe('blocked')
    expect(() => runtime.responseError('probe', {error: 'secret-token-or-path'})).toThrow('probe failed: CHILD_ERROR_REDACTED')
  } finally {
    const child = runtime.child.process
    const exited = new Promise(resolve => child.once('exit', resolve))
    child.disconnect(); await exited
  }
})
