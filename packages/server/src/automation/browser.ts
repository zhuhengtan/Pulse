import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { McpStdioClient } from '@hunterzhu/pulse-adapters'
import { realpath, readdir, stat, mkdir, readFile, unlink } from 'node:fs/promises'
import { resolve, relative, isAbsolute } from 'node:path'
import type { AutomationAction, AutomationBackend, AutomationConfig, BackendObservation } from './types.js'
import { automationError } from './types.js'

export class BrowserBackend implements AutomationBackend {
  private readonly client: McpStdioClient
  private tools = new Set<string>()
  private started = false
  private closed = false
  private readonly outputDir: string
  private readonly observationDir: string
  private readonly dedicated: boolean
  private viewport = { width: 1280, height: 800 }
  constructor(config: NonNullable<AutomationConfig['browser']>, private readonly workspace: string, profile: string, private readonly allowNetwork: boolean, private readonly networkHosts?: string[]) {
    this.dedicated = config.mode !== 'existing'
    this.outputDir = resolve(workspace, '.pulse', 'automation-downloads', createHash('sha256').update(profile).digest('hex').slice(0, 16))
    this.observationDir = resolve(workspace, '.pulse', 'automation-observations', createHash('sha256').update(profile).digest('hex').slice(0, 16))
    this.client = new McpStdioClient({ command: config.command ?? process.execPath, args: config.args ?? [resolve(createRequire(import.meta.url).resolve('@playwright/mcp/package.json'), '../cli.js'), ...(config.mode === 'existing' ? ['--extension'] : ['--headless', '--user-data-dir', profile, ...(config.channel ? ['--browser', config.channel] : process.env.PULSE_BROWSER_EXECUTABLE ? ['--executable-path', process.env.PULSE_BROWSER_EXECUTABLE] : []), '--viewport-size', '1280,800']), '--caps', 'vision', '--image-responses', 'allow', '--output-dir', this.outputDir], cwd: workspace, maxLineBytes: 8 * 1024 * 1024, timeoutMs: 60000, shutdownTimeoutMs: 3000 })
  }
  private async start(): Promise<void> {
    if (this.closed) throw automationError('AUTOMATION_SESSION_NOT_FOUND')
    if (this.started) return
    const root = await realpath(this.workspace)
    for (const directory of [this.outputDir, this.observationDir]) {
      await mkdir(directory, { recursive: true })
      const rel = relative(root, await realpath(directory))
      if (rel === '..' || rel.startsWith('../') || rel.startsWith('..\\') || isAbsolute(rel)) throw automationError('BROWSER_OUTPUT_OUTSIDE_WORKSPACE')
    }
    await this.client.connect()
    this.tools = new Set((await this.client.refreshTools()).map(tool => tool.name))
    this.started = true
  }
  private async tool(name: string, args: Record<string, unknown> = {}, signal?: AbortSignal): Promise<unknown> {
    await this.start()
    if (!this.tools.has(name)) throw automationError(`BROWSER_TOOL_UNAVAILABLE:${name}`)
    return this.client.callTool(name, args as never, signal ? { signal } : {})
  }
  async call(method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    if (method === 'tabs') return this.readTabs(signal)
    if (method === 'selectTab' || method === 'closeTab') {
      const tabs = await this.readTabs(signal)
      if (params.revision && params.revision !== tabs.revision) throw automationError('STALE_BROWSER_TABS')
      if (!Number.isInteger(params.index) || !tabs.items.some(item => item.index === params.index)) throw automationError('BROWSER_TAB_NOT_FOUND')
      if (method === 'closeTab' && tabs.items.length === 1) {
        await this.close()
        return { revision: createHash('sha256').update('[]').digest('hex'), items: [] }
      }
      await this.tool('browser_tabs', { action: method === 'selectTab' ? 'select' : 'close', index: params.index }, signal)
      return this.readTabs(signal)
    }
    if (method === 'reload') return this.tool('browser_press_key', { key: 'ControlOrMeta+r' }, signal)
    if (method === 'back') return this.tool('browser_navigate_back', {}, signal)
    if (method === 'navigate' || method === 'newTab') {
      if (method === 'newTab' && (!params.url || params.url === 'about:blank')) return this.tool('browser_tabs', { action: 'new' }, signal)
      const url = new URL(String(params.url))
      if (!['http:', 'https:'].includes(url.protocol) || (!this.allowNetwork || (this.networkHosts !== undefined && !this.networkHosts.some(host => host.toLowerCase() === url.hostname.toLowerCase())))) throw automationError('BROWSER_NETWORK_NOT_ALLOWED')
      return method === 'newTab' ? this.tool('browser_tabs', { action: 'new', url: url.href }, signal) : this.tool('browser_navigate', { url: url.href }, signal)
    }
    if (method === 'upload') {
      const files = await Promise.all((params.files as string[]).map(async file => {
        const root = await realpath(this.workspace), path = await realpath(resolve(root, file)), rel = relative(root, path)
        if (rel === '..' || rel.startsWith('..' + (process.platform === 'win32' ? '\\' : '/')) || isAbsolute(rel)) throw automationError('UPLOAD_OUTSIDE_WORKSPACE')
        return path
      }))
      return this.tool('browser_file_upload', { paths: files }, signal)
    }
    if (method === 'downloads') return Promise.all((await readdir(this.outputDir).catch(() => [])).map(async name => { const path = resolve(this.outputDir, name); const info = await stat(path); return { name, path, bytes: info.size } }))
    throw automationError('UNKNOWN_BROWSER_METHOD')
  }
  private async readTabs(signal?: AbortSignal) {
    const result = await this.tool('browser_tabs', { action: 'list' }, signal) as { content?: Array<{ type: string; text?: string }> }
    const text = (result.content ?? []).filter(item => item.type === 'text').map(item => item.text ?? '').join('\n')
    const items = [...text.matchAll(/^- (\d+): (\(current\) )?\[([^\n]*)\]\(([^\n]*)\)$/gm)].map(match => ({ index: Number(match[1]), active: Boolean(match[2]), title: match[3]!, url: match[4]! }))
    return { revision: createHash('sha256').update(JSON.stringify(items)).digest('hex'), items }
  }
  async observe(signal?: AbortSignal): Promise<BackendObservation> {
    const snapshot = await this.tool('browser_snapshot', {}, signal) as { content?: Array<{ type: string; text?: string }> }
    const text = (snapshot.content ?? []).filter(item => item.type === 'text').map(item => item.text ?? '').join('\n')
    const filename = resolve(this.observationDir, 'latest.png')
    await unlink(filename).catch(error => { if (error.code !== 'ENOENT') throw error })
    const shot = await this.tool('browser_take_screenshot', { type: 'png', scale: 'css', filename }, signal) as { content?: Array<{ type: string; data?: string; mimeType?: string }> }
    const image = shot.content?.find(item => item.type === 'image' && item.data) ?? { data: (await readFile(filename)).toString('base64'), mimeType: 'image/png' }
    if (!image?.data || image.mimeType !== 'image/png') throw automationError('BROWSER_SCREENSHOT_MISSING')
    const bytes = Buffer.from(image.data, 'base64')
    if (bytes.length < 24 || bytes.readUInt32BE(0) !== 0x89504e47) throw automationError('INVALID_SCREENSHOT')
    this.viewport = { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
    const rawUrl = text.match(/Page URL: (.+)/)?.[1]?.trim()
    const url = rawUrl && /^https?:/.test(rawUrl) ? new URL(rawUrl) : undefined
    return { ...this.viewport, tabs: await this.readTabs(signal), title: text.match(/Page Title: (.+)/)?.[1]?.trim() ?? 'Browser', text: text.slice(0, 16000), ...(url ? { url: `${url.origin}${url.pathname}` } : {}), geometry: createHash('sha256').update(JSON.stringify([this.viewport, text])).digest('hex'), image: { mediaType: 'image/png', data: image.data } }
  }
  async act(action: AutomationAction, observation: BackendObservation, signal?: AbortSignal): Promise<void> {
    if (observation.url) { const host = new URL(observation.url).hostname; if (!this.allowNetwork || (this.networkHosts !== undefined && !this.networkHosts.includes(host))) throw automationError('BROWSER_NETWORK_NOT_ALLOWED') }
    if (action.type === 'element') {
      if (!observation.text?.includes(action.ref)) throw automationError('STALE_ELEMENT')
      if (action.operation === 'click') await this.tool('browser_click', { target: action.ref, element: action.ref }, signal)
      else if (action.operation === 'fill') await this.tool('browser_type', { target: action.ref, element: action.ref, text: action.value ?? '' }, signal)
      else await this.tool('browser_select_option', { target: action.ref, element: action.ref, values: [action.value ?? ''] }, signal)
    } else if (action.type === 'key') await this.tool('browser_press_key', { key: action.keys.join('+') }, signal)
    else if (action.type === 'type') await this.tool('browser_type', { target: ':focus', text: action.text, slowly: true, element: 'focused input' }, signal)
    else {
      const px = (point: { x: number; y: number }) => ({ x: Math.round(point.x * (this.viewport.width - 1)), y: Math.round(point.y * (this.viewport.height - 1)) })
      if (action.type === 'click') await this.tool('browser_mouse_click_xy', { ...px(action.point), button: action.button, clickCount: action.count }, signal)
      else if (action.type === 'drag') await this.tool('browser_mouse_drag_xy', { startX: px(action.from).x, startY: px(action.from).y, endX: px(action.to).x, endY: px(action.to).y }, signal)
      else { await this.tool('browser_mouse_move_xy', px(action.point), signal); await this.tool('browser_mouse_wheel', { deltaX: action.dx, deltaY: action.dy }, signal) }
    }
  }
  async release(): Promise<void> { /* Playwright input operations do not retain pressed keys. */ }
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    // Let an owned persistent browser flush its cookies/profile before ending
    // the MCP transport. Attached user browsers are only disconnected.
    if (this.started && this.dedicated && this.tools.has('browser_close')) await this.client.callTool('browser_close', {}, { timeoutMs: 5000 }).catch(() => undefined)
    await this.client.close()
  }
}
