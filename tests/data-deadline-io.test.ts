import { it, expect, vi } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { ConversationData, dataEndpoint } from '../packages/data/src/index.js'

async function fixture(deadlineMs = 1000) {
  const root = await mkdtemp(join(tmpdir(), 'pulse-data-deadline-')), endpoint = dataEndpoint(root), log = join(root, 'requests.jsonl')
  if (process.platform !== 'win32') await mkdir(dirname(endpoint), { recursive: true, mode: 0o700 })
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import {createServer} from 'node:net'; import {appendFileSync} from 'node:fs';
    const held=[];
    const reply=(socket,r)=>socket.write(JSON.stringify({id:r.id,value:42})+'\\n',()=>appendFileSync(${JSON.stringify(log)},JSON.stringify({id:r.id,kind:'ack',time:Date.now()})+'\\n'));
    const server=createServer(socket=>{let b='';socket.on('error',()=>{});socket.on('data',chunk=>{b+=chunk;let n;while((n=b.indexOf('\\n'))>=0){const r=JSON.parse(b.slice(0,n));b=b.slice(n+1);appendFileSync(${JSON.stringify(log)},JSON.stringify({id:r.id,method:r.method})+'\\n');if(r.method==='disconnect')socket.end(JSON.stringify({id:r.id,value:{lastClient:false}})+'\\n');else if(r.method==='hold')held.push([socket,r]);else reply(socket,r);}})});
    process.on('message',()=>{for(const [socket,r] of held.splice(0))reply(socket,r);process.send('released')});
    server.listen(${JSON.stringify(endpoint)},()=>process.send('ready'));
  `], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
  const data = new ConversationData(root)
  let shorten = false
  const nativeTimeout = globalThis.setTimeout
  const timer = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn, ms, ...args) => nativeTimeout(fn, shorten && ms === 10000 ? deadlineMs : ms, ...args)) as typeof setTimeout)
  try {
    await new Promise<void>((resolve, reject) => { child.once('message', () => resolve()); child.once('error', reject); child.once('exit', code => reject(new Error('FIXTURE_DATA_SERVER_EXIT:' + code))) })
    await data.call('revision')
  } catch (error) { timer.mockRestore(); child.kill(); await rm(root, { recursive: true, force: true }); throw error }
  return {
    data, log, child,
    start: async (method: string) => {
      shorten = true
      const result = data.call(method).then(value => ({ value }), error => ({ error: error.message }))
      await Promise.resolve(); await Promise.resolve()
      return { result }
    },
    normalDeadline: () => { shorten = false },
    close: async () => { shorten = false; timer.mockRestore(); await data.close(); await new Promise<void>(resolve => { if (child.exitCode !== null || child.signalCode !== null) resolve(); else { child.once('exit', () => resolve()); child.kill() } }); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) },
  }
}

it('processes an IPC acknowledgement written before a deadline while the client event loop is blocked', async () => {
  const f = await fixture()
  try {
    const started = Date.now(), { result } = await f.start('revision')
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1250)
    const acks = (await readFile(f.log, 'utf8')).trim().split('\n').map(JSON.parse)
    const ack = acks.find(item => item.id === 2 && item.kind === 'ack')
    expect(ack).toBeDefined()
    expect(ack.time - started).toBeLessThan(1000)
    expect(await result).toEqual({ value: 42 })
  } finally { await f.close() }
})

it('still times out missing replies, ignores late ACKs, and never resends an uncertain request', async () => {
  const f = await fixture(100)
  try {
    const { result } = await f.start('hold')
    expect(await result).toEqual({ error: 'DATA_REQUEST_TIMEOUT' })
    f.normalDeadline()
    const released = new Promise(resolve => f.child.once('message', resolve))
    f.child.send('release'); await released
    expect(await f.data.call('revision')).toBe(42)
    const requests = (await readFile(f.log, 'utf8')).trim().split('\n').map(JSON.parse)
    expect(requests.filter(item => item.method === 'hold')).toHaveLength(1)
  } finally { await f.close() }
})
