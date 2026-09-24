import { access, mkdir, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import type { LocalHostOptions } from '@hunterzhu/pulse-server'

const serviceId = 'com.hunterzhu.pulse.scheduler'
function checked(file: string, args: string[]): void { const result = spawnSync(file, args, { encoding: 'utf8' }); if (result.status !== 0) throw new Error(`${file} ${args[0]} failed: ${(result.stderr || result.stdout || '').trim()}`) }
function xml(value: string): string { return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;') }
function quoteSystemd(value: string): string { return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%')}"` }

export async function runServiceCommand(options: LocalHostOptions, args: string[]): Promise<number> {
  const [action] = args
  if (!['install', 'status', 'start', 'stop', 'uninstall'].includes(action ?? '')) throw new Error('SERVICE_ACTION_REQUIRED')
  const platform = process.platform
  const home = process.env.PULSE_HOME ?? homedir()
  const executable = process.execPath
  const entry = fileURLToPath(new URL('../bin.js', import.meta.url))
  const config = process.env.PULSE_CONFIG ?? join(home, '.pulse', 'config.json')
  const data = options.dataDir ?? process.env.PULSE_DATA_DIR ?? join(home, '.pulse', 'data')
  const cwd = options.cwd ?? process.cwd()
  if (action === 'install') {
    if (!['darwin', 'linux', 'win32'].includes(platform)) throw new Error(`SERVICE_PLATFORM_UNSUPPORTED:${platform}`)
    if (platform === 'darwin') {
      const directory = join(home, 'Library', 'LaunchAgents'); const file = join(directory, `${serviceId}.plist`)
      await mkdir(directory, { recursive: true })
      await writeFile(file, `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${serviceId}</string><key>ProgramArguments</key><array>${[executable, entry, 'schedule', 'daemon', '--approval-mode', options.approvalMode === 'auto' ? 'auto' : 'read-only'].map(v => `<string>${xml(v)}</string>`).join('')}</array><key>WorkingDirectory</key><string>${xml(cwd)}</string><key>EnvironmentVariables</key><dict><key>PULSE_HOME</key><string>${xml(home)}</string><key>PULSE_CONFIG</key><string>${xml(config)}</string><key>PULSE_DATA_DIR</key><string>${xml(data)}</string></dict><key>RunAtLoad</key><true/><key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict><key>ThrottleInterval</key><integer>30</integer><key>StandardOutPath</key><string>${xml(join(data, 'service.log'))}</string><key>StandardErrorPath</key><string>${xml(join(data, 'service.error.log'))}</string></dict></plist>\n`, { mode: 0o600 })
      await mkdir(data, { recursive: true }); checked('launchctl', ['bootstrap', `gui/${process.getuid?.() ?? 0}`, file])
    } else if (platform === 'linux') {
      const directory = join(home, '.config', 'systemd', 'user'); const file = join(directory, 'pulse-scheduler.service')
      await mkdir(directory, { recursive: true })
      await writeFile(file, `[Unit]\nDescription=Pulse scheduled task worker\n\n[Service]\nType=simple\nWorkingDirectory=${quoteSystemd(cwd)}\nEnvironment=${quoteSystemd(`PULSE_HOME=${home}`)}\nEnvironment=${quoteSystemd(`PULSE_CONFIG=${config}`)}\nEnvironment=${quoteSystemd(`PULSE_DATA_DIR=${data}`)}\nExecStart=${quoteSystemd(executable)} ${quoteSystemd(entry)} schedule daemon --approval-mode ${options.approvalMode === 'auto' ? 'auto' : 'read-only'}\nRestart=on-failure\nRestartSec=30s\n\n[Install]\nWantedBy=default.target\n`, { mode: 0o600 })
      checked('systemctl', ['--user', 'daemon-reload']); checked('systemctl', ['--user', 'enable', '--now', 'pulse-scheduler.service'])
    } else {
      const task = 'Pulse Scheduler'; const command = `"${executable}" "${entry}" schedule daemon --approval-mode ${options.approvalMode === 'auto' ? 'auto' : 'read-only'}`
      checked('schtasks.exe', ['/Create', '/F', '/SC', 'ONLOGON', '/TN', task, '/TR', command])
    }
    process.stdout.write(`Installed user scheduler service (${platform}); status: pulse service status\n`); return 0
  }
  if (platform === 'darwin') {
    const file = join(home, 'Library', 'LaunchAgents', `${serviceId}.plist`)
    if (action === 'status' && await access(file).then(() => false, () => true)) { process.stdout.write('Scheduler service is not installed.\n'); return 0 }
    if (action === 'uninstall') { spawnSync('launchctl', ['bootout', `gui/${process.getuid?.() ?? 0}`, file], { stdio: 'ignore' }); await rm(file, { force: true }); return 0 }
    const result = spawnSync('launchctl', [action === 'status' ? 'print' : action === 'start' ? 'kickstart' : 'kill', ...(action === 'start' ? ['-k'] : action === 'stop' ? ['SIGTERM'] : []), `gui/${process.getuid?.() ?? 0}/${serviceId}`], { encoding: 'utf8' }); process.stdout.write(result.stdout || result.stderr || `${action}: ${result.status === 0 ? 'ok' : 'not running'}\n`); return result.status === 0 ? 0 : 1
  }
  if (platform === 'linux') {
    if (action === 'status' && await access(join(home, '.config', 'systemd', 'user', 'pulse-scheduler.service')).then(() => false, () => true)) { process.stdout.write('Scheduler service is not installed.\n'); return 0 }
    const verb = action === 'status' ? 'status' : action === 'start' ? 'start' : action === 'stop' ? 'stop' : 'disable'
    const result = spawnSync('systemctl', ['--user', verb, ...(action === 'uninstall' ? ['--now'] : []), 'pulse-scheduler.service'], { encoding: 'utf8' }); if (action === 'uninstall') await rm(join(home, '.config', 'systemd', 'user', 'pulse-scheduler.service'), { force: true }); process.stdout.write(result.stdout || result.stderr || ''); return result.status === 0 ? 0 : 1
  }
  const task = 'Pulse Scheduler'; const verb = action === 'status' ? '/Query' : action === 'start' ? '/Run' : action === 'stop' ? '/End' : '/Delete'
  const result = spawnSync('schtasks.exe', [verb, '/TN', task, ...(action === 'uninstall' ? ['/F'] : [])], { encoding: 'utf8' }); process.stdout.write(result.stdout || result.stderr || ''); return result.status === 0 ? 0 : 1
}
