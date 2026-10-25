import { access, lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { atomicJson } from './store.js'
import { sha256 } from './security.js'

const marker = 'Pulse Desktop managed launcher'
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'"
export async function installManagedLauncher(root: string, runtime: string, dataDir: string, configPath?: string): Promise<string> {
  const node = join(runtime, process.platform === 'win32' ? 'node.exe' : 'node'), launcher = join(runtime, 'app/node_modules/@hunterzhu/pulse-server/dist/updates/launcher.js')
  await access(launcher)
  const basePath = join(root, 'updates', 'bootstrap.json')
  const prior = await readFile(basePath, 'utf8').then(JSON.parse).catch(error => { if (error.code === 'ENOENT') return undefined; throw error })
  // Keep a working, immutable bootstrap even when a new backend becomes active.
  const healthy = prior?.directory && await (async () => {
    try {
      const manifest = JSON.parse(await readFile(join(prior.directory, 'desktop-runtime.json'), 'utf8'))
      if (!Array.isArray(manifest.critical) || !manifest.critical.length) return false
      for (const name of manifest.critical) { const file = manifest.files[name]; if (!file || await sha256(join(prior.directory, name)) !== file.sha256) return false }
      return true
    } catch { return false }
  })()
  const base = healthy ? prior.directory : runtime
  if (!healthy) await atomicJson(basePath, { schema: 1, directory: runtime })
  const stableNode = join(base, process.platform === 'win32' ? 'node.exe' : 'node'), stableEntry = join(base, 'app/node_modules/@hunterzhu/pulse-server/dist/updates/launcher.js')
  const variables = { PULSE_HOME: root, PULSE_DATA_DIR: dataDir, ...(configPath ? { PULSE_CONFIG: configPath } : {}) }
  const env = process.platform === 'win32' ? Object.entries(variables).map(([key, value]) => `if not defined ${key} set "${key}=${value.replaceAll('%', '%%')}"\r\n`).join('') : Object.entries(variables).map(([key, value]) => `if [ -z "\${${key}+x}" ]; then ${key}=${quote(value)}; export ${key}; fi\n`).join('')
  const text = process.platform === 'win32' ? `@echo off\r\nREM ${marker}\r\nsetlocal DisableDelayedExpansion\r\n${env}"${stableNode.replaceAll('%', '%%')}" "${stableEntry.replaceAll('%', '%%')}" "${root.replaceAll('%', '%%')}" "${base.replaceAll('%', '%%')}" %*\r\nexit /b %errorlevel%\r\n` : `#!/bin/sh\n# ${marker}\n${env}exec ${quote(stableNode)} ${quote(stableEntry)} ${quote(root)} ${quote(base)} "$@"\n`
  for (const name of ['pulse', 'pulse-desktop']) {
    const path = join(root, 'bin', name + (process.platform === 'win32' ? '.cmd' : ''))
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    const info = await lstat(path).catch(error => { if (error.code !== 'ENOENT') throw error; return undefined })
    const existing = info?.isFile() ? await readFile(path, 'utf8') : undefined
    if (info && (!info.isFile() || !existing?.includes(marker))) continue
    const temporary = path + '.' + randomUUID()
    await writeFile(temporary, text, { mode: 0o755 }); await rename(temporary, path)
    return path
  }
  throw new Error('CLI_ENTRY_CONFLICT')
}

/** Rewrite only recognisable Pulse service definitions. The live process keeps running. */
export async function migrateManagedServices(root: string, runtime: string, home = homedir()): Promise<string[]> {
  const bootstrap = await readFile(join(root, 'updates/bootstrap.json'), 'utf8').then(JSON.parse)
  const base = bootstrap.directory as string
  const node = join(base, process.platform === 'win32' ? 'node.exe' : 'node'), entry = join(base, 'app/node_modules/@hunterzhu/pulse-server/dist/updates/launcher.js')
  const changed: string[] = []
  const xml = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
  const systemd = (value: string) => '"' + value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%').replaceAll('$', '$$') + '"'
  for (const kind of ['launchd', 'systemd']) {
    const path = kind === 'launchd' ? join(home, 'Library/LaunchAgents/com.hunterzhu.pulse.h5.plist') : join(home, '.config/systemd/user/pulse-h5.service')
    const info = await lstat(path).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error })
    if (!info?.isFile() || info.isSymbolicLink()) continue
    const before = await readFile(path, 'utf8')
    if (before.includes(entry)) continue
    let after = before
    if (kind === 'launchd' && before.includes('<string>com.hunterzhu.pulse.h5</string>')) {
      after = before.replace(/(<key>ProgramArguments<\/key>\s*<array>\s*)<string>[^<]*<\/string>\s*<string>[^<]*<\/string>(\s*<string>h5<\/string>)/, `$1${[node, entry, root, base].map(value => `<string>${xml(value)}</string>`).join('\n')}$2`)
    } else if (kind === 'systemd' && before.includes('Description=Pulse H5 mobile web assistant service')) {
      after = before.replace(/^ExecStart=.*?\s("h5"\s.*)$/m, `ExecStart=${[node, entry, root, base].map(systemd).join(' ')} $1`)
    }
    if (after !== before) { await atomicJson(path + '.before-managed-update.json', { content: before }); const temp = path + '.' + randomUUID(); await writeFile(temp, after, { mode: info.mode & 0o777 }); await rename(temp, path); changed.push(path) }
  }
  return changed
}
