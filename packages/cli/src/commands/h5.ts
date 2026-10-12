import { access, mkdir, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import QRCode from 'qrcode'
import { createLocalHost, H5Server, H5AuthStore, DEFAULT_H5_PORT, runH5WorkWorker, type LocalHostOptions } from '@hunterzhu/pulse-server'

const serviceId = 'com.hunterzhu.pulse.h5'

function checked(file: string, args: string[]): void {
  const result = spawnSync(file, args, { encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(`${file} ${args[0]} failed: ${(result.stderr || result.stdout || '').trim()}`)
  }
}

function xml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

function quoteSystemd(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%')}"`
}

const h5Actions = new Set(['start', 'daemon', 'qr', 'devices', 'revoke', 'install', 'status', 'stop', 'uninstall', 'work-worker'])

/** Network H5 keeps ask/read-only unless this command explicitly requests auto. */
export function h5RuntimeOptions(
  options: LocalHostOptions,
  cliOptions: Record<string, string | boolean> = {}
): LocalHostOptions {
  const requested = cliOptions['approval-mode']
  if (requested === 'auto' || cliOptions['auto-approve'] === true) return { ...options, approvalMode: 'auto' }
  if (requested === 'read-only' || cliOptions['read-only'] === true) return { ...options, approvalMode: 'read-only' }
  if (requested === 'ask') return { ...options, approvalMode: 'ask' }
  if (options.approvalMode === 'auto') return { ...options, approvalMode: 'ask' }
  return options
}

function h5Port(cliOptions: Record<string, string | boolean>): number | undefined {
  if (typeof cliOptions.port !== 'string') return DEFAULT_H5_PORT
  const port = Number(cliOptions.port)
  return Number.isInteger(port) && port >= 0 && port <= 65535 ? port : undefined
}

export function h5DaemonArguments(executable: string, entry: string, port: number): string[] {
  return [executable, entry, 'h5', 'daemon', '--port', String(port)]
}

export async function runH5Command(
  options: LocalHostOptions,
  args: string[],
  cliOptions: Record<string, string | boolean> = {},
  configuration?: { path: string; prepare: (candidatePath: string) => Promise<LocalHostOptions> }
): Promise<number> {
  const [action = 'start', targetId] = args
  if (!h5Actions.has(action)) {
    process.stderr.write(`未知命令: pulse h5 ${action}\n可用子命令: start, qr, devices, revoke, install, status, stop, uninstall\n`)
    return 1
  }
  const port = h5Port(cliOptions)
  if (port === undefined && ['start', 'daemon', 'qr', 'install'].includes(action)) {
    process.stderr.write('错误: 端口必须是 0 到 65535 的整数。\n')
    return 1
  }
  if (action === 'install' && port === 0) {
    process.stderr.write('错误: 后台服务需要固定端口，不能使用端口 0。\n')
    return 1
  }
  const home = process.env.PULSE_HOME ?? homedir()
  const data = options.dataDir ?? process.env.PULSE_DATA_DIR ?? join(home, '.pulse', 'data')
  const cwd = options.cwd ?? process.cwd()
  const platform = process.platform

  // Internal child process. The parent sends the task over versioned IPC so
  // prompts and credentials never appear in the process argument list.
  if (action === 'work-worker') {
    if (!targetId || !/^conv-[0-9a-f-]{36}$/i.test(targetId)) {
      process.stderr.write('工作进程会话标识无效。\n')
      return 1
    }
    const host = createLocalHost(h5RuntimeOptions(options, cliOptions))
    return runH5WorkWorker(host, targetId)
  }

  // 1. Devices list
  if (action === 'devices') {
    const auth = new H5AuthStore(data)
    await auth.init()
    const devices = await auth.listDevices()
    if (devices.length === 0) {
      process.stdout.write('暂无已配对的设备。\n')
      return 0
    }
    process.stdout.write('已配对设备列表：\n')
    process.stdout.write('ID\t\t\t\t\t设备名称\t\t配对时间\t\t最近活动\n')
    process.stdout.write('------------------------------------------------------------------------------------\n')
    for (const d of devices) {
      process.stdout.write(`${d.id}\t${d.name}\t${new Date(d.createdAt).toLocaleString()}\t${new Date(d.lastUsedAt).toLocaleString()}\n`)
    }
    return 0
  }

  // 2. Revoke device
  if (action === 'revoke') {
    if (!targetId?.trim()) {
      process.stderr.write('错误: 请提供要吊销的设备 ID，例如: pulse h5 revoke dev-xxx\n')
      return 1
    }
    const auth = new H5AuthStore(data)
    await auth.init()
    const ok = await auth.revokeDevice(targetId.trim())
    if (ok) {
      process.stdout.write(`已成功吊销设备 ${targetId}。\n`)
      return 0
    } else {
      process.stderr.write(`未找到设备 ${targetId}。\n`)
      return 1
    }
  }

  // 3. QR code retrieval (queries running server or generates one-off)
  if (action === 'qr') {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/pair/qr`, { signal: AbortSignal.timeout(1500) })
      if (res.ok) {
        const info = (await res.json()) as { pairUrl: string; lanIp: string; port: number; code: string }
        process.stdout.write(`\n📱 手机扫码连接 Pulse 个人助理：\n`)
        process.stdout.write(`局域网地址: ${info.pairUrl}\n`)
        process.stdout.write(`配对码: ${info.code} (5 分钟内有效)\n\n`)
        const terminalQr = await QRCode.toString(info.pairUrl, { type: 'terminal', small: true })
        process.stdout.write(terminalQr + '\n')
        return 0
      }
    } catch {
      // Server not running
    }
    process.stdout.write(`H5 服务当前未在端口 ${port} 运行。\n可运行 'pulse h5' 在前台启动，或运行 'pulse h5 install' 配置开机后台运行。\n`)
    return 1
  }

  // 4. Service install (launchd on macOS / systemd on Linux)
  if (action === 'install') {
    if (!['darwin', 'linux'].includes(platform)) {
      throw new Error(`SERVICE_PLATFORM_UNSUPPORTED:${platform}`)
    }
    const executable = process.execPath
    const entry = fileURLToPath(new URL('../bin.js', import.meta.url))
    const config = process.env.PULSE_CONFIG ?? join(home, '.pulse', 'config.json')
    const daemonArguments = h5DaemonArguments(executable, entry, port ?? DEFAULT_H5_PORT)

    if (platform === 'darwin') {
      const directory = join(home, 'Library', 'LaunchAgents')
      const file = join(directory, `${serviceId}.plist`)
      await mkdir(directory, { recursive: true })
      await writeFile(
        file,
        `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${serviceId}</string>
  <key>ProgramArguments</key>
  <array>
${daemonArguments.map((argument) => `    <string>${xml(argument)}</string>`).join('\n')}
  </array>
  <key>WorkingDirectory</key>
  <string>${xml(cwd)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PULSE_HOME</key>
    <string>${xml(home)}</string>
    <key>PULSE_CONFIG</key>
    <string>${xml(config)}</string>
    <key>PULSE_DATA_DIR</key>
    <string>${xml(data)}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>${xml(join(data, 'h5-service.log'))}</string>
  <key>StandardErrorPath</key>
  <string>${xml(join(data, 'h5-service.error.log'))}</string>
</dict>
</plist>
`,
        { mode: 0o600 }
      )
      await mkdir(data, { recursive: true })
      checked('launchctl', ['bootstrap', `gui/${process.getuid?.() ?? 0}`, file])
      process.stdout.write(`已安装 Pulse H5 launchd 守护服务；状态查看: pulse h5 status\n`)
      return 0
    } else if (platform === 'linux') {
      const directory = join(home, '.config', 'systemd', 'user')
      const file = join(directory, 'pulse-h5.service')
      await mkdir(directory, { recursive: true })
      await writeFile(
        file,
        `[Unit]
Description=Pulse H5 mobile web assistant service

[Service]
Type=simple
WorkingDirectory=${quoteSystemd(cwd)}
Environment=${quoteSystemd(`PULSE_HOME=${home}`)}
Environment=${quoteSystemd(`PULSE_CONFIG=${config}`)}
Environment=${quoteSystemd(`PULSE_DATA_DIR=${data}`)}
ExecStart=${daemonArguments.map(quoteSystemd).join(' ')}
Restart=on-failure
RestartSec=10s

[Install]
WantedBy=default.target
`,
        { mode: 0o600 }
      )
      checked('systemctl', ['--user', 'daemon-reload'])
      checked('systemctl', ['--user', 'enable', '--now', 'pulse-h5.service'])
      process.stdout.write(`已安装 Pulse H5 systemd 用户服务；状态查看: pulse h5 status\n`)
      return 0
    }
  }

  // 5. Service status / stop / uninstall
  if (['status', 'stop', 'uninstall'].includes(action)) {
    if (platform === 'darwin') {
      const file = join(home, 'Library', 'LaunchAgents', `${serviceId}.plist`)
      if (action === 'status' && (await access(file).then(() => false, () => true))) {
        process.stdout.write('Pulse H5 守护服务未安装。\n')
        return 0
      }
      if (action === 'uninstall') {
        spawnSync('launchctl', ['bootout', `gui/${process.getuid?.() ?? 0}`, file], { stdio: 'ignore' })
        await rm(file, { force: true })
        process.stdout.write('已卸载 Pulse H5 守护服务。\n')
        return 0
      }
      const verb = action === 'status' ? 'print' : 'kill'
      const extraArgs = action === 'stop' ? ['SIGTERM'] : []
      const result = spawnSync(
        'launchctl',
        [verb, ...extraArgs, `gui/${process.getuid?.() ?? 0}/${serviceId}`],
        { encoding: 'utf8' }
      )
      process.stdout.write(result.stdout || result.stderr || `${action}: ${result.status === 0 ? 'ok' : 'not running'}\n`)
      return result.status === 0 ? 0 : 1
    } else if (platform === 'linux') {
      const unit = 'pulse-h5.service'
      if (action === 'status' && (await access(join(home, '.config', 'systemd', 'user', unit)).then(() => false, () => true))) {
        process.stdout.write('Pulse H5 守护服务未安装。\n')
        return 0
      }
      const verb = action === 'status' ? 'status' : action === 'stop' ? 'stop' : 'disable'
      const result = spawnSync('systemctl', ['--user', verb, ...(action === 'uninstall' ? ['--now'] : []), unit], { encoding: 'utf8' })
      if (action === 'uninstall') {
        await rm(join(home, '.config', 'systemd', 'user', unit), { force: true })
        process.stdout.write('已卸载 Pulse H5 systemd 服务。\n')
      } else {
        process.stdout.write(result.stdout || result.stderr || '')
      }
      return result.status === 0 ? 0 : 1
    }
    process.stderr.write(`当前平台不支持 H5 守护进程管理: ${platform}\n`)
    return 1
  }

  if (action !== 'start' && action !== 'daemon') {
    process.stderr.write(`未知命令: pulse h5 ${action}\n`)
    return 1
  }

  // 6. Foreground server / daemon worker
  const isDaemon = action === 'daemon'
  const runtimeOptions = h5RuntimeOptions(options, cliOptions)
  if (options.approvalMode === 'auto' && runtimeOptions.approvalMode === 'ask') {
    process.stderr.write('H5 网络服务已将审批模式从 auto 降为 ask。若确需自动批准，请显式传入 --approval-mode auto。\n')
  }
  const host = createLocalHost(runtimeOptions)
  const server = new H5Server(host, {
    dataDir: data,
    port: port ?? DEFAULT_H5_PORT,
    ...(process.env.PULSE_H5_HOST ? { host: process.env.PULSE_H5_HOST } : {}),
    ...(configuration ? { configuration } : {}),
    workWorker: {
      entry: fileURLToPath(new URL('../bin.js', import.meta.url)),
      dataDir: data,
      ...(configuration ? { configPath: configuration.path } : {}),
      approvalMode: runtimeOptions.approvalMode,
      trustWorkspace: cliOptions['trust-workspace'] === true,
      cwd,
    },
  })
  const started = await server.start()

  if (!isDaemon) {
    process.stdout.write(`\n🚀 Pulse H5 个人助理服务已启动！\n`)
    process.stdout.write(`电脑本机管理页: http://localhost:${started.port}/pair\n`)
    process.stdout.write(`手机扫码连接页: ${started.pairUrl}\n`)
    process.stdout.write(`当前局域网 IP:  ${started.lanIp}\n\n`)

    try {
      const qr = await QRCode.toString(started.pairUrl, { type: 'terminal', small: true })
      process.stdout.write(qr + '\n')
    } catch {
      // ignore
    }
    process.stdout.write(`提示: 手机连上同一 Wi-Fi 后扫码即可使用。按 Ctrl+C 可停止服务。\n\n`)
  }

  await new Promise<void>((resolve) => {
    let shuttingDown = false
    const shutdown = () => {
      if (shuttingDown) {
        process.exit(130)
        return
      }
      shuttingDown = true
      void server.stop().then(() => host.close()).then(() => resolve(), () => resolve())
    }
    process.once('SIGINT', shutdown)
    process.once('SIGTERM', shutdown)
  })

  return 0
}
