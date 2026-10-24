import { expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const exec = promisify(execFile)
it.runIf(process.platform === 'darwin')('checks target selection, window coordinates and secure AX formatting without accessing the UI', async()=>{
 const dir=await mkdtemp(join(tmpdir(),'pulse-native-contract-'))
 try{
  const bin=join(dir,'contract')
  await exec('swiftc',['-module-cache-path',join(tmpdir(),'pulse-swift-cache'),'-D','PULSE_DESKTOP_TEST','-parse-as-library','native/desktop-helper/macos.swift','tests/fixtures/desktop-native-contract.swift','-o',bin],{timeout:60000})
  expect((await exec(bin,[],{timeout:5000})).stdout).toContain('15 checks')
 }finally{await rm(dir,{recursive:true,force:true})}
},70000)
