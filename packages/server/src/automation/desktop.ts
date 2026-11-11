import { spawn } from 'node:child_process'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import type { AutomationAction, AutomationBackend, BackendObservation } from './types.js'
import { automationError } from './types.js'
export const agentDesktopPath = () => resolve(import.meta.dirname, `../../native/${process.platform}-${process.arch}/agent-desktop${process.platform === 'win32' ? '.exe' : ''}`)
type WindowInfo = { id: string; title: string; app_name: string; pid: number; process_instance?: string; is_focused: boolean; bounds?: { x: number; y: number; width: number; height: number } }
const geometry = (window: WindowInfo) => JSON.stringify([window.id, window.pid, window.process_instance, window.bounds])
/** Owns one isolated ref namespace. No shell, global installation, or legacy helper fallback. */
export class DesktopBackend implements AutomationBackend {
  private readonly stateRoot: string
  private selectedWindow: string | undefined
  private verified: Promise<void> | undefined
  private readonly children = new Set<ReturnType<typeof spawn>>()
  constructor(private readonly executable = agentDesktopPath(), private readonly displayId?: string, stateDirectory = join(tmpdir(), 'pulse-agent-desktop')) { this.stateRoot = join(stateDirectory, randomUUID()) }
  private async verify(): Promise<void> {
    const root = dirname(this.executable)
    const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8').catch(() => { throw automationError('AGENT_DESKTOP_NOT_INSTALLED:run pnpm desktop:build') }))
    if (manifest.backend !== 'agent-desktop' || manifest.version !== '1.2.0' || manifest.platform !== process.platform || manifest.arch !== process.arch || !Object.keys(manifest.hashes ?? {}).some(name => join(root, name) === this.executable)) throw automationError('AGENT_DESKTOP_INCOMPATIBLE')
    for (const [name, expected] of Object.entries(manifest.hashes)) {
      if (name.split('/').some(part => !/^[\w .-]+$/.test(part) || part === '..' || part === '.') || createHash('sha256').update(await readFile(join(root, name))).digest('hex') !== expected) throw automationError('AGENT_DESKTOP_CHECKSUM_MISMATCH')
    }
    await mkdir(this.stateRoot, { recursive: true, mode: 0o700 })
  }
  private async run(args: string[], signal?: AbortSignal, input?: string): Promise<any> {
    if (signal?.aborted) throw automationError('AUTOMATION_CANCELLED')
    await (this.verified ??= this.verify())
    if (signal?.aborted) throw automationError('AUTOMATION_CANCELLED')
    return new Promise((accept, reject) => {
      const environment = { ...process.env }; for (const key of Object.keys(environment)) if (key.startsWith('AGENT_DESKTOP_')) delete environment[key]; environment.AGENT_DESKTOP_HOME = this.stateRoot
      const child = spawn(this.executable, args, { shell: false, windowsHide: true, stdio: 'pipe', env: environment })
      this.children.add(child); let output = '', settled = false, inputFailed = false
      const finish = (error?: Error, result?: unknown) => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); this.children.delete(child); error ? reject(error) : accept(result) }
      const abort = () => { child.kill(); finish(automationError('DESKTOP_ACTION_RESULT_UNKNOWN')) }
      const timer = setTimeout(abort, 85000); signal?.addEventListener('abort', abort, { once: true })
      child.on('error', error => finish(error)); child.stderr?.resume()
      child.stdout?.on('data', chunk => { output += chunk; if (output.length > 16 * 1024 * 1024) abort() })
      // A child that exits before consuming --stdin input must not crash the host; delivery of the action is then unknown.
      child.stdin?.on('error', () => { inputFailed = true })
      child.on('close', () => {
        if (settled) return
        try {
          const result = JSON.parse(output)
          if (result.ok && inputFailed) { finish(automationError('DESKTOP_ACTION_RESULT_UNKNOWN')); return }
          if (!result.ok) { const error = automationError(result.error?.code ?? 'AGENT_DESKTOP_ERROR'); Object.assign(error, { disposition: result.error?.disposition, details: result.error?.details, command: args.find(arg => !arg.startsWith('-')), explanation: result.error?.message }); finish(error) }
          else finish(undefined, result.data)
        } catch { finish(automationError(inputFailed ? 'DESKTOP_ACTION_RESULT_UNKNOWN' : 'AGENT_DESKTOP_PROTOCOL_ERROR')) }
      })
      child.stdin?.end(input)
      if (signal?.aborted) abort()
    })
  }
  async call(method: string, params: Record<string, unknown> = {}, signal?: AbortSignal): Promise<any> {
    if (method === 'doctor' || method === 'requestPermissions') {
      const report = await this.run([method === 'doctor' ? 'status' : 'permissions'], signal)
      const permissions = report.permissions ?? report
      return { ...report, backend: 'agent-desktop', accessibility: permissions.accessibility?.state === 'granted', screenCapture: permissions.screen_recording?.state === 'granted', guidance: '请在系统隐私设置中授权实际启动 agent-desktop 的宿主：桌面安装包通常为 Pulse，开发或 CLI 入口可能为 Electron、终端或编辑器，以系统授权列表为准。无障碍树需要辅助功能权限；截图另需屏幕录制权限。授权后重新检查。' }
    }
    if (method === 'windows') return (await this.run(['list-windows'], signal)).map((window: WindowInfo) => ({ ...window, windowId: window.id, app: window.app_name, focused: window.is_focused }))
    if (method === 'displays') return await this.run(['list-displays'], signal)
    if (method === 'selectWindow') { const id = String(params.windowId); const result = await this.run(['--headed', 'focus-window', '--window-id', id], signal); this.selectedWindow = id; return result }
    throw automationError('AGENT_DESKTOP_COMMAND_UNSUPPORTED')
  }
  async observe(signal?: AbortSignal, windowId?: string, includeImage = false): Promise<BackendObservation> {
    const windows = await this.run(['list-windows'], signal) as WindowInfo[]
    const targetId = windowId ?? this.selectedWindow
    const candidates = windows.filter(window => targetId ? window.id === targetId : window.is_focused)
    if (candidates.length !== 1) throw automationError(targetId ? 'AUTOMATION_TARGET_WINDOW_MISSING' : 'AUTOMATION_WINDOW_SELECTION_REQUIRED')
    const target = candidates[0]!, bounds = target.bounds
    if (!bounds || bounds.width <= 0 || bounds.height <= 0) throw automationError('AUTOMATION_WINDOW_BOUNDS_UNAVAILABLE')
    let snapshot: any
    try {
      // AX providers can publish their window before their tree is ready. Retry reads only.
      for (let attempt = 0; ; attempt++) {
        try { snapshot = await this.run(['snapshot', '--window-id', target.id, '--include-bounds'], signal); break }
        catch (error) {
          if (attempt >= 4 || (error as any).details?.kind !== 'window_without_accessibility_element' || signal?.aborted) throw error
          await new Promise(resolve => setTimeout(resolve, 250))
        }
      }
    }
    catch (error) {
      if (!includeImage || !['PERM_DENIED', 'ACTION_NOT_SUPPORTED', 'PLATFORM_NOT_SUPPORTED'].includes((error as Error).message)) throw error
      snapshot = { complete: false, accessibilityError: (error as Error).message, tree: null }
    }
    const refs: string[] = []; let focusedRef: string | undefined
    const walk = (node: any) => { if (node?.ref_id) { refs.push(node.ref_id); if (node.states?.includes('focused')) focusedRef = node.ref_id } for (const child of node?.children ?? []) walk(child) }; walk(snapshot.tree)
    const shot = includeImage ? await this.run(['screenshot', '--window-id', target.id], signal) : undefined
    const after = (await this.run(['list-windows'], signal) as WindowInfo[]).find(window => window.id === target.id)
    if (!after || geometry(after) !== geometry(target)) throw automationError('AUTOMATION_GEOMETRY_CHANGED')
    this.selectedWindow = target.id
    return { title: target.title, text: JSON.stringify(snapshot), contentFingerprint: createHash('sha256').update(JSON.stringify(snapshot.tree, (key, value) => ['ref_id', 'snapshot_id'].includes(key) ? undefined : value)).digest('hex'), width: shot?.width ?? Math.round(bounds.width), height: shot?.height ?? Math.round(bounds.height), ...(shot ? { image: { mediaType: 'image/png' as const, data: shot.data } } : {}), geometry: geometry(target), captureScope: 'window', targetWindowId: target.id, captureBounds: bounds, accessibilityTruncated: snapshot.complete === false, refs, ...(focusedRef ? { focusedRef } : {}) }
  }
  async validate(observation: BackendObservation, signal?: AbortSignal): Promise<void> {
    const windows = await this.run(['list-windows'], signal) as WindowInfo[]
    const target = windows.find(window => window.id === observation.targetWindowId)
    if (!target || geometry(target) !== observation.geometry) throw automationError('AUTOMATION_GEOMETRY_CHANGED')
  }
  async act(action: AutomationAction, observation: BackendObservation, signal?: AbortSignal): Promise<void> {
    const windows = await this.run(['list-windows'], signal) as WindowInfo[]
    const target = windows.find(window => window.id === observation.targetWindowId)
    if (!target || geometry(target) !== observation.geometry) throw automationError('AUTOMATION_GEOMETRY_CHANGED')
    if (action.type === 'element' || action.type === 'type') {
      const ref = action.type === 'element' ? action.ref : observation.focusedRef
      if (!ref || !observation.refs?.includes(ref)) throw automationError('STALE_AUTOMATION_ELEMENT')
      if (action.type === 'type') { if (!target.is_focused) throw automationError('AUTOMATION_TARGET_NOT_FOCUSED'); await this.run(['--headed', 'type', ref, '--stdin'], signal, action.text) }
      else if (action.operation === 'click') await this.run(['click', ref], signal)
      else if (action.operation === 'fill') await this.run(['set-value', ref, '--stdin'], signal, action.value ?? '')
      else await this.run(['select', ref, action.value ?? ''], signal)
      return
    }
    if (!target.is_focused) throw automationError('AUTOMATION_TARGET_NOT_FOCUSED')
    if (action.type === 'key') { const aliases: Record<string,string> = { Enter: 'return', Escape: 'escape', Control: 'ctrl', Meta: process.platform === 'darwin' ? 'cmd' : 'meta', Command: 'cmd', Alt: 'alt', Shift: 'shift', ArrowDown: 'down', ArrowUp: 'up', ArrowLeft: 'left', ArrowRight: 'right' }; await this.run(['--headed', 'press', action.keys.map(key => aliases[key] ?? key.toLowerCase()).join('+'), '--window-id', target.id], signal); return }
    if (!observation.image || !observation.captureBounds) throw automationError('AUTOMATION_SCREENSHOT_REQUIRED')
    const bounds = observation.captureBounds
    const point = (p: {x:number;y:number}) => [Math.round(bounds.x + p.x * Math.max(0,bounds.width-1)), Math.round(bounds.y + p.y * Math.max(0,bounds.height-1))]
    if (action.type === 'click') await this.run(['--headed','mouse-click',`--xy=${point(action.point).join(',')}`,'--button',action.button,'--count',String(action.count)],signal)
    else if (action.type === 'drag') await this.run(['--headed','drag',`--from-xy=${point(action.from).join(',')}`,`--to-xy=${point(action.to).join(',')}`],signal)
    else if (action.type === 'scroll') { const [x,y]=point(action.point); await this.run(['--headed','mouse-wheel',`--x=${x}`,`--y=${y}`,`--dx=${action.dx}`,`--dy=${-action.dy}`],signal) }
  }
  async release(): Promise<void> { for (const child of this.children) child.kill() }
  async close(): Promise<void> { await this.release(); await rm(this.stateRoot, { recursive: true, force: true }) }
}
