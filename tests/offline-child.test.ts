import {execFileSync} from 'node:child_process'
import {expect,it} from 'vitest'
it('keeps provider requests offline in a real child process',()=>{
  const output=execFileSync(process.execPath,['--input-type=module','-e',`try { await fetch('https://example.com/'); process.exitCode=1 } catch(error) { console.log(error.message) }`],{encoding:'utf8'})
  expect(output.trim()).toBe('OFFLINE_TEST_CHILD_NETWORK_BLOCKED')
})
