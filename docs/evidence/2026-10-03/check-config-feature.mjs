// Independent behavioral oracle for the multi-file live regression.
// Usage: node docs/evidence/2026-10-03/check-config-feature.mjs /absolute/generated/workspace
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { resolve } from 'node:path'

const cwd = resolve(process.argv[2])
const require = createRequire(resolve(cwd, 'oracle.cjs'))
const { parseConfig } = require('./src/config.js')
// The contract specifies key/value behavior, not Object.prototype identity.
const entries = (text) => Object.fromEntries(Object.entries(parseConfig(text)))
assert.deepEqual(entries(''), {})
assert.deepEqual(entries('  \n # comment\n\t'), {})
assert.deepEqual(entries(' a = 1 \n# c\nx=a=b\na=2\nempty=\nname= 张三 '), {
  a: '2', x: 'a=b', empty: '', name: '张三',
})
assert.throws(() => parseConfig('missing-equals'), Error)
assert.throws(() => parseConfig('=value'), Error)
assert.throws(() => parseConfig(' \t =value'), Error)
const run = (...args) => spawnSync(process.execPath, args, { cwd, encoding: 'utf8', timeout: 10_000 })
const ok = run('src/cli.js', 'sample.conf')
assert.equal(ok.status, 0, ok.stderr)
assert.deepEqual(JSON.parse(ok.stdout), { mode: 'prod', token: 'a=b' })
assert.equal(readFileSync(resolve(cwd, 'sample.conf'), 'utf8'), '# test\n mode = local \n token = a=b \nmode=prod\n')
for (const args of [[], ['oracle-missing.conf']]) {
  const result = run('src/cli.js', ...args)
  assert.equal(result.error, undefined)
  assert.notEqual(result.status, 0)
}
const invalid = resolve(cwd, 'oracle-invalid.conf')
writeFileSync(invalid, 'invalid line\n', { flag: 'wx' })
try {
  const result = run('src/cli.js', invalid)
  assert.equal(result.error, undefined)
  assert.notEqual(result.status, 0)
} finally { unlinkSync(invalid) }
assert.equal(existsSync(resolve(cwd, 'test/config.test.js')), true)
const tests = run('--test')
assert.equal(tests.status, 0, tests.stdout + tests.stderr)
assert.equal(existsSync(resolve(cwd, 'node_modules')), false)
assert.equal(existsSync(resolve(cwd, 'package-lock.json')), false)
console.log(JSON.stringify({ behavioralChecks: 'passed', generatedTests: tests.stdout.trim(), sampleUnchanged: true, dependenciesInstalled: false }))
