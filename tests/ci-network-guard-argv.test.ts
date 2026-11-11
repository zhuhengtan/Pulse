import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'

// The guard must keep every Node child offline, but must not add a second --import when the child's effective
// NODE_OPTIONS already loads the same guard (a strict process-identity check compares the real argv).
it('adds the guard argv only when the child env does not already load it, and always keeps children offline', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pulse ci argv '))
  try {
    const log = join(root, 'attempts.jsonl'), guard = join(root, 'network guard.mjs')
    await copyFile(fileURLToPath(new URL('../scripts/ci/network-guard.mjs', import.meta.url)), guard)
    const url = pathToFileURL(guard).href
    const probe = `import net from 'node:net'; let blocked='no'; try { net.connect(443,'203.0.113.9') } catch (e) { blocked=e.code }
      console.log(JSON.stringify({ execArgv: process.execArgv, blocked }))`
    const parent = `
      import { spawn, spawnSync, execFileSync, execFile } from 'node:child_process'
      import { promisify } from 'node:util'
      const url = ${JSON.stringify(url)}, log = ${JSON.stringify(log)}
      const argv = ['--input-type=module', '-e', ${JSON.stringify(probe)}]
      const environments = {
        inherited: undefined,
        explicit: { PULSE_CI_NETWORK_LOG: log, NODE_OPTIONS: '--import=' + url },
        spaced: { PULSE_CI_NETWORK_LOG: log, NODE_OPTIONS: '--import ' + url },
        cleared: { PULSE_CI_NETWORK_LOG: log },
        overridden: { PULSE_CI_NETWORK_LOG: log, NODE_OPTIONS: '--no-warnings' },
        quoted: { PULSE_CI_NETWORK_LOG: log, NODE_OPTIONS: '--title="--import=' + url + '"' },
        suffixed: { PULSE_CI_NETWORK_LOG: log, NODE_OPTIONS: '--import=' + url + '?variant=1' },
      }
      const out = {}
      const parse = text => { try { return JSON.parse(String(text).trim().split('\\n').at(-1)) } catch { throw Error('NO_CHILD_RESULT:' + text) } }
      for (const [name, env] of Object.entries(environments)) {
        const options = env ? { env, encoding: 'utf8' } : { encoding: 'utf8' }
        const asyncSpawn = await new Promise((resolve, reject) => {
          const child = spawn(process.execPath, argv, env ? { env } : {}); let text = ''
          child.stdout.on('data', chunk => text += chunk); child.on('error', reject); child.on('close', () => resolve(text))
        })
        out[name] = {
          spawnSync: parse((r => r.stdout + r.stderr)(spawnSync(process.execPath, argv, options))),
          execFileSync: parse(execFileSync(process.execPath, argv, options)),
          spawn: parse(asyncSpawn),
          promisified: parse((await promisify(execFile)(process.execPath, argv, options)).stdout),
        }
      }
      console.log('RESULT ' + JSON.stringify(out))
    `
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', parent], {
      env: { PULSE_CI_NETWORK_LOG: log, NODE_OPTIONS: '--import=' + url },
      encoding: 'utf8',
      timeout: 60000,
    })
    expect(result.status, result.stderr).toBe(0)
    const out = JSON.parse(result.stdout.split('\n').find(line => line.startsWith('RESULT '))!.slice(7)) as Record<string, Record<string, { execArgv: string[]; blocked: string }>>
    const injected = (value: { execArgv: string[] }) => value.execArgv.some(arg => arg.startsWith('--import=') && arg.includes('network%20guard.mjs'))
    for (const [name, variants] of Object.entries(out)) {
      for (const [variant, value] of Object.entries(variants)) {
        // Every child stays offline, whether the guard arrived by argv or by NODE_OPTIONS.
        expect(value.blocked, `${name}/${variant}`).toBe('OFFLINE_NETWORK_BLOCKED')
        const inherited = ['inherited', 'explicit', 'spaced'].includes(name)
        expect(injected(value), `${name}/${variant} argv ${JSON.stringify(value.execArgv)}`).toBe(!inherited)
      }
    }
    expect((await readFile(log, 'utf8')).trim().split('\n').length).toBe(Object.keys(out).length * 4)
  } finally { await rm(root, { recursive: true, force: true }) }
}, 90000)
