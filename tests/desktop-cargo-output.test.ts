import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'

it('copies and hashes the supervisor from the actual Cargo target directory, including an external CI cache', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pulse desktop output '))
  try {
    const scripts = join(root, 'scripts/automation'), native = join(root, 'native/desktop-helper')
    await mkdir(scripts, { recursive: true }); await mkdir(native, { recursive: true })
    for (const name of ['build-desktop.mjs', 'build-srt-win.mjs', 'macos-permission-brand.mjs']) await copyFile(join(process.cwd(), 'scripts/automation', name), join(scripts, name))
    for (const name of ['windows.ps1', 'linux.py']) await writeFile(join(native, name), 'fixture ' + name)
    // Execute the real build entrypoint with a scripted Cargo and Linux target;
    // no compiler, signing, download or native-platform claim in this test.
    await writeFile(join(root, 'build'), `const fs=require('node:fs'),p=require('node:path');const a=process.argv.slice(2);const get=k=>a[a.indexOf(k)+1];if(!a.includes('--locked')||get('--manifest-path')!=='native/desktop-helper/Cargo.toml')process.exit(7);const d=p.join(get('--target-dir'),get('--target'),'release');fs.mkdirSync(d,{recursive:true});fs.writeFileSync(p.join(d,'pulse-desktop-helper'),'fixture-supervisor');`)
    for (const cache of [undefined, join(root, 'outside cache')]) {
      const destination = join(root, cache ? 'output-external' : 'output-default')
      const env: NodeJS.ProcessEnv = { ...process.env, PULSE_CARGO: process.execPath, PULSE_DESKTOP_ARCH: 'x64', PULSE_DESKTOP_TARGET: 'x86_64-unknown-linux-gnu', PULSE_DESKTOP_OUTPUT_DIR: destination }
      delete env.PULSE_DESKTOP_CARGO_TARGET_DIR
      if (cache) env.PULSE_DESKTOP_CARGO_TARGET_DIR = cache
      const code = `Object.defineProperty(process,'platform',{value:'linux'});await import(${JSON.stringify(pathToFileURL(join(scripts, 'build-desktop.mjs')).href)})`
      const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: root, env, encoding: 'utf8', timeout: 15000 })
      expect(result.status, result.stdout + result.stderr).toBe(0)
      const expected = Buffer.from('fixture-supervisor')
      expect(await readFile(join(cache ?? join(native, 'target'), 'x86_64-unknown-linux-gnu/release/pulse-desktop-helper'))).toEqual(expected)
      expect(await readFile(join(destination, 'pulse-desktop-helper'))).toEqual(expected)
      const manifest = JSON.parse(await readFile(join(destination, 'manifest.json'), 'utf8'))
      expect(manifest).toMatchObject({ protocolVersion: 1, platform: 'linux', arch: 'x64', hashes: { 'pulse-desktop-helper': createHash('sha256').update(expected).digest('hex') } })
    }
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
}, 45000)
