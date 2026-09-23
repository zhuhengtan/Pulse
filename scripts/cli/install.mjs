import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

const args = process.argv.slice(2)
const archiveIndex = args.indexOf('--archive')
const archive = archiveIndex >= 0 ? args[archiveIndex + 1] : undefined
if (!archive) {
  console.error('Usage: pnpm cli:install -- --archive <path>')
  process.exit(2)
}

const root = process.env.PULSE_HOME ?? process.env.PULSE_INSTALL_ROOT ?? join(homedir(), '.pulse')
const temp = await mkdtemp(join(tmpdir(), 'pulse-install-'))
try {
  const extracted = spawnSync('tar', ['-xzf', archive, '-C', temp], { stdio: 'inherit' })
  if (extracted.status !== 0) process.exitCode = extracted.status ?? 1
  else {
    const manifest = JSON.parse(await readFile(join(temp, 'pulse/manifest.json'), 'utf8'))
    if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(manifest.version)) {
      throw new Error(`Invalid Pulse package version: ${manifest.version}`)
    }
    const target = join(root, 'versions/pulse', manifest.version)
    const versionRoot = join(root, 'versions/pulse')
    const windows = process.platform === 'win32'
    const launcher = join(root, 'bin', windows ? 'pulse.cmd' : 'pulse')
    const existing = await stat(launcher).catch(() => undefined)
    if (existing) {
      const content = await readFile(launcher, 'utf8').catch(() => '')
      const managed = windows
        ? content.includes('REM Pulse CLI managed launcher') && content.includes('versions\\pulse\\')
        : content.includes('Pulse CLI managed launcher') && content.includes('versions/pulse/')
      if (!managed) throw new Error(`${launcher} already exists and is not managed by Pulse; refusing to overwrite`)
    }

    await mkdir(versionRoot, { recursive: true })
    await cp(join(temp, 'pulse'), target, { recursive: true, force: true })
    await mkdir(join(root, 'bin'), { recursive: true })

    if (windows) {
      const relativeTarget = `..\\versions\\pulse\\${manifest.version}\\bin\\pulse.js`
      await writeFile(launcher, `@echo off\r\nREM Pulse CLI managed launcher\r\nsetlocal DisableDelayedExpansion\r\nnode "%~dp0${relativeTarget}" %*\r\nexit /b %errorlevel%\r\n`)
    } else {
      await writeFile(launcher, `#!/bin/sh\n# Pulse CLI managed launcher\nexec node "${target}/bin/pulse.js" "$@"\n`, { mode: 0o755 })
    }

    console.log(`Installed Pulse ${manifest.version} to ${target}`)
    console.log(`Ensure ${join(root, 'bin')} is on PATH.`)
  }
} finally {
  await rm(temp, { recursive: true, force: true })
}
