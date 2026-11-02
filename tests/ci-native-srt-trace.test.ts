import { spawnSync } from 'node:child_process'
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

it('classifies ACL batches using only fixed enums without disclosing input or inspecting getters', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pulse-acl-trace-')), log = join(root, 'trace.jsonl')
  const guard = pathToFileURL(fileURLToPath(new URL('../scripts/ci/network-guard.mjs', import.meta.url))).href
  const checkout = fileURLToPath(new URL('../', import.meta.url))
  try {
    const source = `
      import assert from 'node:assert/strict';import {traceSrtCall} from ${JSON.stringify(guard)};
      const sentinel={status:0},args=[['acl','stamp']],fake='private-install/pulse-srt.exe';let calls=0;
      const invoke=()=>{calls++;return sentinel};
      const input=JSON.stringify({denyRead:[${JSON.stringify(join(checkout, 'packages/cli/private-password'))},${JSON.stringify(join(checkout, '.git/private-password'))},'/outside/private-password'],denyWrite:[${JSON.stringify(join(checkout, 'node_modules/private-password'))}],password:'private-password'});
      assert.equal(traceSrtCall('spawnSync',fake,[...args,{input}],invoke),sentinel);
      assert.equal(traceSrtCall('spawnSync',fake,[['acl','grant'],{input:Buffer.from(JSON.stringify({read:[${JSON.stringify(join(checkout, 'packages/runtime/private-password'))}],write:[]}))}],invoke),sentinel);
      assert.equal(traceSrtCall('spawnSync',fake,[...args,{input:'private-password'}],invoke),sentinel);
      assert.equal(traceSrtCall('spawnSync',fake,[...args,{input:'private-password'.repeat(65536)}],invoke),sentinel);
      let getters=0;const options={};Object.defineProperty(options,'input',{get(){getters++;throw Error('private-password')}});
      assert.equal(traceSrtCall('spawnSync',fake,[...args,options],invoke),sentinel);assert.equal(getters,0);assert.equal(calls,5);
    `
    const result = spawnSync(process.execPath, ['--import=' + guard, '--input-type=module', '-e', source], { env: { PULSE_CI_SRT_LOG: log }, encoding: 'utf8', timeout: 20000 })
    expect(result.status, result.stderr).toBe(0)
    const text = await readFile(log, 'utf8'), rows = text.trim().split('\n').map(line => JSON.parse(line))
    expect(text).not.toContain('private-password')
    expect(text).not.toContain('private-install')
    expect(text).not.toContain(checkout)
    const starts = rows.filter(row => row.phase === 'start')
    expect(starts).toHaveLength(5)
    expect(rows.filter(row => row.phase === 'end')).toHaveLength(5)
    expect(starts[0].acl).toEqual({ readKinds: ['package-cli', 'checkout-git', 'other'], writeKinds: ['checkout-dependencies'] })
    expect(starts[1].acl).toEqual({ readKinds: ['package-runtime'], writeKinds: [] })
    expect(starts.slice(2).every(row => row.acl === undefined)).toBe(true)
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('records native phases without changing results, stdin, custom promises or unhandled errors, and never records payloads', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pulse srt trace ')), log = join(root, 'trace.jsonl')
  const guard = pathToFileURL(fileURLToPath(new URL('../scripts/ci/network-guard.mjs', import.meta.url))).href
  try {
    const executable = join(root, 'pulse-srt.exe')
    await copyFile(process.execPath, executable)
    const workerFile = join(root, 'native-probe.cjs')
    await writeFile(workerFile, "const {parentPort,workerData}=require('node:worker_threads');const result=require('node:child_process').spawnSync(workerData.executable,['--srt-win','acl','stamp','NEVER_LOG_THIS_PAYLOAD'],{encoding:'utf8'});parentPort.postMessage(result.status)")
    const source = `
      import assert from 'node:assert/strict';import cp from 'node:child_process';import {promisify} from 'node:util';import {Worker,SHARE_ENV} from 'node:worker_threads';import {EventEmitter} from 'node:events';import {writeFileSync,statSync} from 'node:fs';
      import {traceSrtCall} from ${JSON.stringify(guard)};
      const secret='NEVER_LOG_THIS_PAYLOAD',fake='private-install/pulse-srt.exe',rest=[['--srt-win','acl','stamp',secret],{input:secret,timeout:1234}];
      const value=traceSrtCall('spawnSync',fake,rest,()=>cp.spawnSync(process.execPath,['-e',"process.stdout.write(require('fs').readFileSync(0))"],{input:secret,encoding:'utf8'}));
      assert.equal(value.status,0);assert.equal(value.stdout,secret);
      const original=promisify(cp.execFile)(process.execPath,['-e',"process.stdout.write('partial');process.exit(7)"],{encoding:'utf8'});
      const observed=traceSrtCall('execFile',fake,rest,()=>original);assert.equal(observed,original);assert.equal(observed.child,original.child);
      await assert.rejects(observed,error=>error.code===7&&error.stdout==='partial');
      const fatal=Object.assign(new Error(secret),{code:'EACCES',status:23});
      assert.throws(()=>traceSrtCall('execFileSync',fake,rest,()=>{throw fatal}),error=>error===fatal);
      const child=new EventEmitter();assert.equal(traceSrtCall('spawn',fake,rest,()=>child),child);
      assert.throws(()=>child.emit('error',fatal),error=>error===fatal);child.emit('close',null,'SIGTERM');
      const path=process.env.PULSE_CI_SRT_LOG;delete process.env.PULSE_CI_SRT_LOG;
      const baseline=cp.spawnSync(${JSON.stringify(executable)},['--srt-win','acl','stamp',secret],{input:secret,encoding:'utf8'});
      process.env.PULSE_CI_SRT_LOG=path;
      const traced=cp.spawnSync(${JSON.stringify(executable)},['--srt-win','acl','stamp',secret],{input:secret,encoding:'utf8'});
      assert.notEqual(baseline.status,0);for(const key of ['status','signal','stdout','stderr'])assert.deepEqual(traced[key],baseline[key]);
      const nativePromise=promisify(cp.execFile)(${JSON.stringify(executable)},['--srt-win','acl','stamp',secret],{encoding:'utf8'});
      assert.equal(typeof nativePromise.child.pid,'number');await assert.rejects(nativePromise,error=>error.code===baseline.status&&error.stderr===baseline.stderr);
      await new Promise((resolve,reject)=>cp.execFile(${JSON.stringify(executable)},['--srt-win','acl','stamp',secret],{encoding:'utf8'},(error,stdout,stderr)=>{try{assert.equal(error.code,baseline.status);assert.equal(stdout,baseline.stdout);assert.equal(stderr,baseline.stderr);resolve()}catch(e){reject(e)}}));
      const worker=new Worker(${JSON.stringify(workerFile)},{env:SHARE_ENV,workerData:{executable:${JSON.stringify(executable)}},execArgv:process.execArgv.filter(arg=>!arg.startsWith('--input-type'))});
      const exited=new Promise((resolve,reject)=>{worker.once('exit',resolve);worker.once('error',reject)});
      const code=await new Promise((resolve,reject)=>{worker.once('message',resolve);worker.once('error',reject)});assert.equal(code,baseline.status);assert.equal(await exited,0);
      const privateWord='privatenativepassword';
      const unknown=traceSrtCall('spawnSync',fake,[['--srt-win','user',privateWord]],()=>({status:0}));assert.equal(unknown.status,0);
      const unknownError=Object.assign(new Error(privateWord),{code:privateWord});assert.throws(()=>traceSrtCall('execFileSync',fake,rest,()=>{throw unknownError}),error=>error===unknownError);
      // An unavailable or full diagnostics file cannot change an operation.
      process.env.PULSE_CI_SRT_LOG=${JSON.stringify(join(root, 'missing', 'trace.jsonl'))};const sentinel={once:true};
      assert.equal(traceSrtCall('spawnSync',fake,rest,()=>sentinel),sentinel);
      process.env.PULSE_CI_SRT_LOG=${JSON.stringify(join(root, 'full.jsonl'))};writeFileSync(process.env.PULSE_CI_SRT_LOG,Buffer.alloc(4*1024*1024));
      assert.equal(traceSrtCall('spawnSync',fake,rest,()=>sentinel),sentinel);assert.equal(statSync(process.env.PULSE_CI_SRT_LOG).size,4*1024*1024);
      console.log('TRACE_PROBE_OK');
    `
    const result = spawnSync(process.execPath, ['--import=' + guard, '--input-type=module', '-e', source], { env: { PULSE_CI_SRT_LOG: log, PULSE_CI_NETWORK_LOG: join(root, 'network.jsonl') }, encoding: 'utf8', timeout: 20000 })
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout.trim()).toBe('TRACE_PROBE_OK')
    const text = await readFile(log, 'utf8'), rows = text.trim().split('\n').map(line => JSON.parse(line))
    expect(text).not.toContain('NEVER_LOG_THIS_PAYLOAD')
    expect(text).not.toContain('private-install')
    expect(text).not.toContain('privatenativepassword')
    expect(rows.filter(row => row.phase === 'start')).toHaveLength(10)
    expect(rows.filter(row => row.phase === 'end')).toHaveLength(10)
    expect(rows.some(row => row.threadId > 0 && row.phase === 'end' && row.status !== 0)).toBe(true)
    expect(rows.some(row => row.status === 7)).toBe(true)
    expect(rows.some(row => row.status === 23 && row.errorCode === 'EACCES')).toBe(true)
    expect(rows.some(row => row.errorCode === 'EACCES' && row.status === undefined)).toBe(true)
    expect(rows.filter(row => row.command === 'acl').every(row => row.operation === 'stamp' && row.elapsedMs >= 0)).toBe(true)
    expect(rows.filter(row => row.command === 'user').every(row => row.operation === undefined)).toBe(true)
  } finally { await rm(root, { recursive: true, force: true }) }
})
