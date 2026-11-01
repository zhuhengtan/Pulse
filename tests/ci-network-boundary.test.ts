import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
it('permits local fixtures and blocks sockets and DNS in scrubbed Node children', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pulse-ci-boundary-'))
  try {
    const log = join(root, 'probe.jsonl'), guard = fileURLToPath(new URL('../scripts/ci/network-guard.mjs', import.meta.url))
    const source = `
      import net from 'node:net'; import dns from 'node:dns'; import {spawnSync} from 'node:child_process';
      process.env.PULSE_CI_NETWORK_LOG=${JSON.stringify(log)};
      const server=net.createServer(socket=>socket.end());
      await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
      const address=server.address(); await new Promise((resolve,reject)=>{const s=net.connect(address.port,'127.0.0.1');s.on('close',resolve);s.on('error',reject)}); server.close();
      for (const action of [()=>net.connect(443,'203.0.113.1'),()=>dns.lookup('example.invalid')]) {
        try {action();throw Error('BOUNDARY_BYPASSED')} catch(e) {if(e.code!=='OFFLINE_NETWORK_BLOCKED')throw e;}
      }
      const child=spawnSync(process.execPath,['--input-type=module','-e',${JSON.stringify(`import net from 'node:net'; process.env.PULSE_CI_NETWORK_LOG=${JSON.stringify(log)}; try { net.connect(443,'203.0.113.2'); process.exit(9) } catch(e) { if(e.code!=='OFFLINE_NETWORK_BLOCKED') throw e; console.log('scrubbed child blocked'); }`)}],{env:{},encoding:'utf8'});
      if(child.status!==0||!child.stdout.includes('scrubbed child blocked'))throw Error(child.stderr||'CHILD_BOUNDARY_BYPASSED');
      console.log('local fixture passed; external access blocked');
    `
    const result = spawnSync(process.execPath, ['--import=' + guard, '--input-type=module', '-e', source], { env: { PULSE_CI_NETWORK_LOG: log }, encoding: 'utf8', timeout: 10000 })
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('local fixture passed; external access blocked')
    const attempts = (await readFile(log, 'utf8')).trim().split('\n').map(JSON.parse)
    expect(attempts.map(x => x.host)).toEqual(['203.0.113.1', 'example.invalid', '203.0.113.2'])
  } finally { await rm(root, { recursive: true, force: true }) }
})
