import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { describeRunRecovery, recoveryDecision } from '../packages/server/src/run-recovery-preflight.js'
import { DownloadProgressWriter, readDownloadProgress } from '../packages/server/src/updates/progress.js'
import { initialState, atomicJson, statePath } from '../packages/server/src/updates/store.js'
import { UpdateManager } from '../packages/server/src/updates/manager.js'
import { DiagnosticLines, LocalDiagnosticLog, readLocalDiagnostics } from '../packages/server/src/diagnostics.js'
// @ts-expect-error Desktop uses native ESM, exercised directly by Vitest.
import { observeServiceStartup } from '../packages/desktop/src/background-service.mjs'
const dirs: string[] = []
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }) })
async function temporary() { const root = await mkdtemp(join(tmpdir(), 'pulse-reliability-')); dirs.push(root); return root }
const preflight = () => describeRunRecovery('c', 'r', 'b'.repeat(64), {build:'a'.repeat(64),policy:'same'}, 'same')
it('same-build and legacy preflight do not grant a build migration', () => {
 const same = describeRunRecovery('c','r','b',{build:'b',policy:'p'},'p')
 expect(same.status).toBe('ready'); expect(recoveryDecision(same,{})).toBeUndefined()
 expect(describeRunRecovery('c','r','b').status).toBe('ready')
 expect(() => recoveryDecision(same,{recovery:{confirmed:true}})).toThrow('STALE')
})
it('requires explicit confirmation of this exact run and both full build identities', () => {
 const p = preflight(); expect(p.status).toBe('confirmation-required'); expect(p.toolCheck).toBe('on-resume')
 for (const body of [{},{recovery:{...p,confirmed:false}},{recovery:{...p,confirmed:'true'}}]) expect(() => recoveryDecision(p,body)).toThrow('MIGRATION_REQUIRED')
 expect(recoveryDecision(p,{recovery:{runId:p.runId,from:p.from,to:p.to,confirmed:true}})).toEqual({runId:p.runId,from:p.from,to:p.to})
 for (const key of ['runId','from','to']) expect(() => recoveryDecision(p,{recovery:{runId:p.runId,from:p.from,to:p.to,confirmed:true,[key]:'changed'}})).toThrow('STALE')
})
it('policy and missing/occupied snapshots remain blockers even with build confirmation', () => {
 for (const blocker of ['RECOVERY_SNAPSHOT_MISSING','RUN_NOT_INTERRUPTED','RECOVERY_FORMAT_CONFLICT']) {
  const p = describeRunRecovery('c','r','to',undefined,undefined,[blocker]); expect(p.status).toBe('blocked'); expect(() => recoveryDecision(p,{recovery:{confirmed:true}})).toThrow(blocker)
 }
 const p=describeRunRecovery('c','r','to',{build:'from',policy:'old'},'new')
 expect(p.blockers).toEqual(['RECOVERY_POLICY_INCOMPATIBLE']); expect(() => recoveryDecision(p,{recovery:{confirmed:true}})).toThrow('POLICY')
})
it('publishes real progress read by a new manager and a separate Node process without a download', async () => {
 const root=await temporary(), dataDir=join(root,'data'), id=randomUUID(), state={...initialState(),phase:'downloading' as const,downloadId:id}
 await atomicJson(statePath(root,dataDir),state)
 const writer=new DownloadProgressWriter(root,dataDir,id); await writer.start(); writer.update({component:'frontend',received:50,total:100})
 await vi.waitFor(async()=>expect(await readDownloadProgress(root,dataDir,id,'downloading')).toEqual({component:'frontend',received:50,total:100}))
 const manager=new UpdateManager({root,dataDir,backendVersion:'1.0.0'})
 expect((await manager.status()).progress?.received).toBe(50)
 const entry=new URL('../packages/server/dist/updates/manager.js',import.meta.url).href
 const script=`import {UpdateManager} from ${JSON.stringify(entry)};console.log(JSON.stringify((await new UpdateManager(${JSON.stringify({root,dataDir,backendVersion:'1.0.0'})}).status()).progress))`
 const result=await promisify(execFile)(process.execPath,['--input-type=module','-e',script],{timeout:10000})
 expect(JSON.parse(result.stdout)).toEqual({component:'frontend',received:50,total:100})
 await writer.finish(); expect((await manager.status()).progress).toBeUndefined()
})
it('throttles writes, rejects regressions, and starts the next component independently', async () => {
 const root=await temporary(),id=randomUUID(); let now=Date.now()
 const writer=new DownloadProgressWriter(root,root,id,()=>now); await writer.start(); writer.update({component:'backend',received:10,total:100})
 await vi.waitFor(async()=>expect((await readDownloadProgress(root,root,id,'downloading',now))?.received).toBe(10))
 now+=10; writer.update({component:'backend',received:20,total:100})
 now+=300; writer.update({component:'backend',received:5,total:100})
 expect((await readDownloadProgress(root,root,id,'downloading',now))?.received).toBe(10)
 writer.update({component:'backend',received:25,total:100})
 await vi.waitFor(async()=>expect((await readDownloadProgress(root,root,id,'downloading',now))?.received).toBe(25))
 writer.update({component:'frontend',received:0,total:200})
 await vi.waitFor(async()=>expect((await readDownloadProgress(root,root,id,'downloading',now))?.component).toBe('frontend'))
 await writer.finish()
})
it('old cleanup and late callbacks cannot remove or overwrite another download', async () => {
 const root=await temporary(),old=new DownloadProgressWriter(root,root,randomUUID()),next=new DownloadProgressWriter(root,root,randomUUID())
 await old.start(); await next.start(); old.update({component:'frontend',received:1,total:10}); next.update({component:'frontend',received:8,total:10})
 await old.finish(); old.update({component:'frontend',received:9,total:10})
 await vi.waitFor(async()=>expect((await readDownloadProgress(root,root,next.id,'downloading'))?.received).toBe(8))
 expect(await readDownloadProgress(root,root,old.id,'downloading')).toBeUndefined(); await next.finish()
})
it('ignores expired, future, corrupt, mismatched, invalid and terminal progress', async () => {
 const root=await temporary(),id=randomUUID(),file=statePath(root,root)+`.progress-${id}.json`,now=Date.now()
 const good={id,component:'frontend',received:5,total:10,updatedAt:now}
 for(const patch of [{updatedAt:now-60001},{updatedAt:now+5001},{id:randomUUID()},{received:11},{received:-1},{total:0},{received:1.5},{component:'other'}]) {
  await atomicJson(file,{...good,...patch}); expect(await readDownloadProgress(root,root,id,'downloading',now)).toBeUndefined()
 }
 await writeFile(file,'bad json'); expect(await readDownloadProgress(root,root,id,'downloading',now)).toBeUndefined()
 await atomicJson(file,good)
 for(const phase of ['ready','failed','idle','waiting']) expect(await readDownloadProgress(root,root,id,phase,now)).toBeUndefined()
 expect(await readDownloadProgress(root,root,undefined,'downloading',now)).toBeUndefined()
})
it('cleans terminal state after an empty selection and a local manifest failure, without network', async () => {
 const root=await temporary(),dataDir=join(root,'data'),manager=new UpdateManager({root,dataDir,backendVersion:'1.0.0'})
 await manager.download(); expect((await manager.status()).phase).toBe('idle'); expect((await manager.status()).downloadId).toBeUndefined()
 // Invalid local manifest is rejected before artifact download. No fetch or installation is performed.
 vi.spyOn(manager,'select').mockReturnValue([{component:'frontend',version:'9.0.0',artifact:{sha256:'a'.repeat(64)}} as never])
 await manager.download(); const status=await manager.status(); expect(status.phase).toBe('failed'); expect(status.downloadId).toBeUndefined(); expect(status.progress).toBeUndefined()
 expect((await readdir(join(root,'updates/scopes'))).some(name=>name.includes('.progress-'))).toBe(false)
})
it('progress I/O failure is optional and finish handles queued failure safely', async () => {
 const root=await temporary(),obstruction=join(root,'file'); await writeFile(obstruction,'not a directory')
 const writer=new DownloadProgressWriter(obstruction,root,randomUUID()); await writer.start(); writer.update({component:'frontend',received:1,total:10}); await writer.finish()
 expect(await readDownloadProgress(obstruction,root,writer.id,'downloading')).toBeUndefined()
})
it('redacts split ordinary credentials and URL query values before storing lines', async () => {
 const root=await temporary(),log=new LocalDiagnosticLog(root),lines=new DiagnosticLines(log,'stderr')
 lines.write('connect failed token=FAKE_'); lines.write('TEST_VALUE https://example.invalid/?token=FAKE_QUERY\n'); lines.write('Authorization: Bear'); lines.write('er FAKE_AUTH_VALUE\n')
 const output=(await readFile(log.path,'utf8')); expect(output).not.toContain('FAKE_TEST_VALUE'); expect(output).not.toContain('FAKE_QUERY'); expect(output).not.toContain('FAKE_AUTH_VALUE'); expect(output).toContain('REDACTED')
 expect(output).toContain('connect failed')
})
it('omits multiline key material and oversized lines and recovers at the next line', async () => {
 const root=await temporary(),log=new LocalDiagnosticLog(root),lines=new DiagnosticLines(log,'stderr')
 lines.write('-----BEGIN PRIVATE KEY-----\nFAKE_PRIVATE_BODY\n-----END PRIVATE KEY-----\n'); lines.write('X'.repeat(9000)); lines.write('still omitted\nnormal exit\n')
 const text=readLocalDiagnostics(root).text; expect(text).not.toContain('FAKE_PRIVATE_BODY'); expect(text).not.toContain('still omitted'); expect(text).toContain('normal exit'); expect(text).toContain('oversized output omitted')
})
it('bounds local rotation/files and does not read unrelated files', async () => {
 const root=await temporary(); for(let i=0;i<12;i++){ const log=new LocalDiagnosticLog(root,`desktop-service-${i}.log`,512);for(let n=0;n<20;n++)log.record('error',`line${n} ${'x'.repeat(70)}`) }
 await writeFile(join(root,'unrelated.txt'),'not a Pulse diagnostic')
 const names=(await readdir(root)).filter(name=>name.endsWith('.log')||name.endsWith('.log.1')); expect(names.length).toBeLessThanOrEqual(8)
 for(const name of names) expect(Buffer.byteLength(await readFile(join(root,name)))).toBeLessThanOrEqual(512)
 expect(readLocalDiagnostics(root).text).not.toContain('not a Pulse diagnostic')
 expect(readLocalDiagnostics(join(root,'missing')).text).toContain('暂无')
})
it('reports spawn failure and exit code immediately from the owned child only', () => {
 const child=new EventEmitter(),log={record:vi.fn()},failure=observeServiceStartup(child,log)
 expect(failure()).toBeUndefined(); child.emit('error',Object.assign(new Error('missing runtime'),{code:'ENOENT'})); expect(failure()).toBe('PULSE_SERVICE_START_ERROR:ENOENT'); expect(log.record).toHaveBeenCalledOnce()
 const other=new EventEmitter(),exited=observeServiceStartup(other,log); other.emit('exit',42,null); expect(exited()).toBe('PULSE_SERVICE_EXITED:42')
})

it('prunes abandoned progress journals to a bounded per-scope history', async () => {
 const root=await temporary();
 for(let i=0;i<11;i++){const writer=new DownloadProgressWriter(root,root,randomUUID());await writer.start();writer.update({component:'frontend',received:i,total:20});await vi.waitFor(async()=>expect(await readDownloadProgress(root,root,writer.id,'downloading')).toBeDefined())}
 const files=(await readdir(join(root,'updates/scopes'))).filter(name=>name.includes('.progress-'));expect(files.length).toBeLessThanOrEqual(8)
})

it('a detached-service style Node process records its own redacted output and exit without an Electron launcher', async () => {
 const root=await temporary(),entry=new URL('../packages/server/dist/diagnostics.js',import.meta.url).href;
 const script=`import {installProcessDiagnostics} from ${JSON.stringify(entry)};installProcessDiagnostics(${JSON.stringify(root)});process.stderr.write('startup failure token=FAKE_PROCESS_TOKEN\\n');process.exit(7)`;
 let code:unknown;try{await promisify(execFile)(process.execPath,['--input-type=module','-e',script],{timeout:10000})}catch(error){code=(error as {code?:unknown}).code}
 expect(code).toBe(7);const text=readLocalDiagnostics(root).text;expect(text).toContain('process-start');expect(text).toContain('process-exit');expect(text).toContain('startup failure');expect(text).not.toContain('FAKE_PROCESS_TOKEN');expect(text).toContain('REDACTED');expect(text).toContain('\\"code\\":7')
})
