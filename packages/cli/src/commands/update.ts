import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { UpdateManager, atomicJson, readState, statePath, updateRoot, withUpdateLock } from '@hunterzhu/pulse-server/updates'
import { installManagedLauncher, migrateManagedServices } from '@hunterzhu/pulse-server/updates'

export async function runUpdateCommand(args: string[], options: Record<string, string | boolean>, backendVersion: string): Promise<number> {
  const root = updateRoot(), dataDir = resolve(typeof options['data-dir'] === 'string' ? options['data-dir'] : process.env.PULSE_DATA_DIR ?? join(root, 'data'))
  const [action = 'status'] = args
  if (!['status', 'check', 'download', 'apply', 'rollback', 'enable', 'auto-download'].includes(action)) throw new Error('Usage: pulse update status|check|download|apply|rollback|enable|auto-download on|off')
  const manager = new UpdateManager({ root, dataDir, backendVersion: action === 'enable' && !process.env.PULSE_RUNTIME_DIR ? '0.0.0' : backendVersion,
    development: action !== 'enable' && process.env.PULSE_MANAGED !== '1', ...(process.env.PULSE_RUNTIME_DIR ? { runtimeDirectory: process.env.PULSE_RUNTIME_DIR } : {}) })
  if (action === 'enable') {
    let runtime = process.env.PULSE_RUNTIME_DIR
    if (!runtime) {
      await manager.check(); await manager.download()
      await withUpdateLock(root, async () => {
        const state = await readState(root, dataDir)
        const target = state.staged?.backend
        if (!target) throw new Error(state.error ?? 'UPDATE_NO_SIGNED_BACKEND')
        await manager.verifyInstalled(target)
        runtime = target.directory
        // Adoption changes the next managed launch; it never signals a legacy process.
        state.previous = state.active; state.active = state.staged!; delete state.staged; state.pending = false; state.phase = 'idle'
        await atomicJson(statePath(root, dataDir), state)
      })
    }
    const path = await installManagedLauncher(root, runtime!, dataDir, typeof options.config === 'string' ? options.config : process.env.PULSE_CONFIG)
    const services = await migrateManagedServices(root, runtime!)
    process.stdout.write(`托管更新已启用：${path}\n已有 npm 命令保持不变；请使用上述入口，或将其目录加入 PATH。现有后台不会被中断。\n`)
    if (services.length) process.stdout.write('已有后台服务定义已迁移并备份；下次重新加载服务时使用托管启动器。\n')
    return 0
  }
  if (action === 'check') await manager.check()
  if (action === 'download') await manager.download(true)
  if (action === 'apply' || action === 'rollback') await manager.requestApply(action === 'rollback')
  if (action === 'auto-download') { if (!['on', 'off'].includes(args[1] ?? '')) throw new Error('Usage: pulse update auto-download on|off'); await manager.settings(args[1] === 'on') }
  const status = await manager.status()
  process.stdout.write(JSON.stringify(status, null, 2) + '\n')
  return 'error' in status && status.error ? 1 : 0
}
