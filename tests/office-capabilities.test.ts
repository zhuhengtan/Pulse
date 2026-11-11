import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { access, cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { crc32 } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineLaneProgram, PulseRuntime } from '@hunterzhu/pulse-runtime'
import { currentRequestText, suppliedRequestResults } from './helpers/provider-request.js'
import { ToolRegistry } from '@hunterzhu/pulse-tool-sdk'
import { createDocumentTools, FilesystemTool, officeBinaryWriter } from '@hunterzhu/pulse-adapters'
import { createDocxCapabilityPack, createPdfCapabilityPack, createPptxCapabilityPack, createSpreadsheetCapabilityPack } from '../packages/server/src/capabilities.js'
import { isOfficeFileEdit, isPptxPageProgress } from '../packages/server/src/task-controller/office-evidence.js'
import { LocalHost, createLocalHost } from '../packages/server/src/index.js'

const requireFromAdapters = createRequire(resolve('packages/adapters/package.json'))
const parser = requireFromAdapters('./src/documents/pptx-parse.cjs') as { parsePptx: (data: Buffer, request: { startSlide?: number; endSlide?: number; offset?: number; maxChars: number }) => { text: string; nextSlide: number | null; nextOffset: number | null; truncated: boolean } }
const roots: string[] = []
async function convertWithSoffice(soffice: string, source: string, outDir: string, home: string, filter: string): Promise<void> {
  const extension = filter.startsWith('csv') ? '.csv' : filter.startsWith('pdf') ? '.pdf' : '.txt'
  const outputName = basename(source).replace(/\.[^.]+$/, extension)
  const privateDir = join(home, `out-${createHash('sha256').update(source).digest('hex').slice(0, 8)}`)
  const fontConfig = join(home, 'fonts.conf')
  const fontCache = join(home, 'fontconfig')
  await mkdir(privateDir, { recursive: true })
  await mkdir(fontCache, { recursive: true })
  const fontDirs = ['/System/Library/Fonts', '/System/Library/Fonts/Supplemental', '/Library/Fonts', '/usr/share/fonts'].filter((dir) => existsSync(dir))
  await writeFile(fontConfig, `<?xml version="1.0"?>\n<fontconfig>${fontDirs.map((dir) => `<dir>${dir}</dir>`).join('')}<cachedir>${fontCache}</cachedir></fontconfig>`)
  const output = join(privateDir, outputName)
  const profile = pathToFileURL(join(home, `profile-${basename(source)}`)).href
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(soffice, ['--headless', '--norestore', '--nolockcheck', '--nologo', `-env:UserInstallation=${profile}`, '--convert-to', filter, '--outdir', privateDir, source], {
      env: { ...process.env, HOME: home, USERPROFILE: home, TMPDIR: home, SAL_USE_VCLPLUGIN: 'svp', FONTCONFIG_FILE: fontConfig },
    })
    let log = ''
    child.stdout?.on('data', (chunk) => { log += chunk.toString() })
    child.stderr?.on('data', (chunk) => { log += chunk.toString() })
    let settled = false
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      clearInterval(timer)
      clearTimeout(deadline)
      child.kill('SIGKILL')
      if (error) reject(new Error(`${error.message}\n${log}`))
      else resolvePromise()
    }
    const timer = setInterval(() => {
      void (async () => {
        const names = await readdir(privateDir).catch(() => [])
        if (names.includes(outputName)) return finish()
        const temporary = names.find((name) => name.endsWith('.tmp') && !name.startsWith('.'))
        if (!temporary || !log.includes('using filter')) return
        const exported = await readFile(join(privateDir, temporary))
        if (exported.length === 0) return
        await writeFile(output, exported)
        finish()
      })().catch(() => undefined)
    }, 250)
    const deadline = setTimeout(() => finish(new Error(`SOFFICE_TIMEOUT:${basename(source)}`)), 30_000)
    child.once('error', (error) => finish(error))
    child.once('exit', () => { void readFile(output).then((bytes) => finish(bytes.length > 0 ? undefined : new Error(`SOFFICE_NO_OUTPUT:${basename(source)}`))).catch(() => finish(new Error(`SOFFICE_NO_OUTPUT:${basename(source)}`))) })
  })
  await writeFile(join(outDir, outputName), await readFile(output))
}

beforeEach(() => { vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('UNEXPECTED_NETWORK')) })
afterEach(async () => {
  const mocked = vi.isMockFunction(globalThis.fetch) ? vi.mocked(globalThis.fetch) : undefined
  if (mocked && String(mocked.getMockImplementation() ?? '').includes('UNEXPECTED_NETWORK')) expect(mocked).not.toHaveBeenCalled()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'pulse-office-'))
  roots.push(root)
  return root
}

async function registryFor(root: string): Promise<ToolRegistry> {
  const registry = new ToolRegistry({ workspaceRoots: [root], allowNetwork: false })
  for (const definition of createDocumentTools(root)) registry.register(definition)
  return registry
}

function writerFor(root: string) {
  const files = new FilesystemTool(root)
  return {
    files,
    run<T>(work: () => Promise<T>): Promise<T> {
      return officeBinaryWriter.run({
        write: async (request) => {
          const saved = await files.writeBytesIfUnchanged(request.path, Buffer.from(request.bytes), request.expectedHash, request.signal)
          return { path: request.path, hash: saved.hash, bytes: saved.bytes }
        },
      }, work)
    },
  }
}

function zipStored(entries: Array<{ name: string; data: Buffer }>): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name)
    const crc = crc32(entry.data) >>> 0
    const local = Buffer.alloc(30 + name.length + entry.data.length)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x800, 6)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(entry.data.length, 18)
    local.writeUInt32LE(entry.data.length, 22)
    local.writeUInt16LE(name.length, 26)
    name.copy(local, 30)
    entry.data.copy(local, 30 + name.length)
    const central = Buffer.alloc(46 + name.length)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x800, 8)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(entry.data.length, 20)
    central.writeUInt32LE(entry.data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(offset, 42)
    name.copy(central, 46)
    locals.push(local)
    centrals.push(central)
    offset += local.length
  }
  const central = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(central.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, central, eocd])
}

function tool(key: string, name: string, args: Record<string, unknown>) {
  return { key, toolCallId: key, kind: 'tool' as const, concurrencyClass: 'tool' as const, input: { name, arguments: args, toolCallId: key } }
}

function settled(ctx: any) {
  const deps = ctx.resumeInput?.type === 'wait' ? Object.values(ctx.resumeInput.resolution?.dependencies ?? {}) : []
  return (deps as any[]).flatMap((item) => item.state === 'settled' ? [{ error: item.outcome?.error?.code ?? null, value: item.outcome?.resultRef ? ctx.results.read(item.outcome.resultRef) : null }] : [])
}

const packs = [createPdfCapabilityPack(), createSpreadsheetCapabilityPack(), createDocxCapabilityPack(), createPptxCapabilityPack()]

function isolatedEnv(root: string): void {
  for (const [key, path] of Object.entries({
    PULSE_HOME: join(root, 'home'), HOME: join(root, 'home'), USERPROFILE: join(root, 'home'),
    APPDATA: join(root, 'appdata'), LOCALAPPDATA: join(root, 'localappdata'), PULSE_DATA_DIR: join(root, 'pulse-data'),
    XDG_CONFIG_HOME: join(root, 'xdg-config'), XDG_CACHE_HOME: join(root, 'xdg-cache'), XDG_DATA_HOME: join(root, 'xdg-data'),
    XDG_STATE_HOME: join(root, 'xdg-state'), XDG_RUNTIME_DIR: join(root, 'xdg-runtime'),
  })) vi.stubEnv(key, path)
  vi.stubEnv('PULSE_CONFIG', join(root, 'home', 'config.json'))
}

async function hostFor(root: string, policy: 'legacy' | 'continuous', approvalMode: 'auto' | 'ask' | 'read-only') {
  isolatedEnv(root)
  const host = new LocalHost({
    cwd: root, dataDir: join(root, 'data'), provider: { provider: 'mock' }, approvalMode,
    taskController: policy === 'continuous', taskControllerPolicy: policy, jarvis: { enabled: false },
    capabilityPacks: packs, enabledCapabilityPacks: ['pdf', 'spreadsheet', 'docx', 'pptx'],
  })
  await host.init()
  const conversation = await host.createConversation()
  return { host, conversation, runDirectory: (runId: string) => join(root, 'data', 'conversations', conversation.id, 'runs', runId) }
}

async function openSurface(isolated: Awaited<ReturnType<typeof hostFor>>, cwd: string, runId: string) {
  const runDirectory = isolated.runDirectory(runId)
  await mkdir(runDirectory, { recursive: true })
  await writeFile(join(runDirectory, 'input.json'), JSON.stringify({ fileSurfaceVersion: 2 }))
  return (isolated.host as unknown as { runtimeFor: (...args: unknown[]) => Promise<{ runtime: { start: (id: string) => { outcome: () => Promise<{ status: string; resultRef?: string }> }; createAgent: (goal: string, program: unknown) => { agentId: string }; state: { results: Map<string, { value?: unknown }> } } }> }).runtimeFor(isolated.conversation.id, runId, cwd, 'office', '', (isolated.host as unknown as { options: unknown }).options)
}

describe('office capabilities', () => {
  it('reads slides in presentation order, pages inside a slide, and rejects hostile packages', async () => {
    const root = await workspace()
    const registry = await registryFor(root)
    const channel = writerFor(root)
    const saved = await channel.run(() => registry.execute('document.pptx.write', {
      path: 'deck.pptx',
      slides: [
        { title: '第一页', bullets: ['甲'.repeat(30)] },
        { title: '第二页', bullets: ['乙'.repeat(30)] },
        { title: '第三页', bullets: ['丙<&>'] },
      ],
    }, new AbortController().signal))
    expect(saved.slides).toBe(3)
    const JSZip = requireFromAdapters('jszip')
    const zip = await JSZip.loadAsync(await readFile(join(root, 'deck.pptx')))
    const rels = await zip.file('ppt/_rels/presentation.xml.rels').async('string')
    zip.file('ppt/_rels/presentation.xml.rels', rels
      .replace('Target="slides/slide2.xml"', 'Target="slides/slide-temp.xml"')
      .replace('Target="slides/slide3.xml"', 'Target="slides/slide2.xml"')
      .replace('Target="slides/slide-temp.xml"', 'Target="slides/slide3.xml"'))
    await writeFile(join(root, 'reordered.pptx'), await zip.generateAsync({ type: 'nodebuffer' }))
    const ordered = await registry.execute('document.pptx.read', { path: 'reordered.pptx', maxChars: 20_000 }, new AbortController().signal)
    const third = ordered.text.indexOf('第三页')
    const second = ordered.text.indexOf('第二页')
    expect(ordered.totalSlides).toBe(3)
    expect(ordered.text.indexOf('第一页')).toBeGreaterThanOrEqual(0)
    expect(third).toBeGreaterThan(0)
    expect(second).toBeGreaterThan(third)
    expect(ordered.text).toContain('丙<&>')

    const first = await registry.execute('document.pptx.read', { path: 'deck.pptx', startSlide: 1, endSlide: 3, maxChars: 8 }, new AbortController().signal)
    expect(first.truncated).toBe(true)
    expect(first.nextSlide).toBe(1)
    expect(first.nextOffset).toBeGreaterThan(0)
    const pieces = [first.text]
    let cursor = { startSlide: first.nextSlide as number, offset: first.nextOffset as number }
    for (let step = 0; step < 12 && cursor.startSlide; step++) {
      const page = await registry.execute('document.pptx.read', { path: 'deck.pptx', startSlide: cursor.startSlide, endSlide: 3, offset: cursor.offset, maxChars: 20 }, new AbortController().signal)
      pieces.push(page.text)
      if (!page.truncated) break
      cursor = { startSlide: page.nextSlide, offset: page.nextOffset }
    }
    const joined = pieces.join('\n')
    expect(joined.split('甲').length - 1).toBe(30)
    expect(joined.split('乙').length - 1).toBe(30)
    expect(joined).toContain('第一页')
    expect(joined).toContain('第二页')
    expect(joined).toContain('第三页')
    const repeated = await registry.execute('document.pptx.read', { path: 'deck.pptx', startSlide: 1, offset: 0, maxChars: 8 }, new AbortController().signal)
    expect(repeated.text).toBe(first.text)

    const empty = zipStored([
      { name: '[Content_Types].xml', data: Buffer.from('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>') },
      { name: '_rels/.rels', data: Buffer.from('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>') },
      { name: 'ppt/presentation.xml', data: Buffer.from('<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst></p:sldIdLst></p:presentation>') },
      { name: 'ppt/_rels/presentation.xml.rels', data: Buffer.from('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>') },
    ])
    await writeFile(join(root, 'empty.pptx'), empty)
    await expect(registry.execute('document.pptx.read', { path: 'empty.pptx' }, new AbortController().signal)).resolves.toMatchObject({ totalSlides: 0, endSlide: 0, nextSlide: null, nextOffset: null, text: '' })

    const hostile = async (name: string, bytes: Buffer, code: string) => {
      await writeFile(join(root, name), bytes)
      await expect(registry.execute('document.pptx.read', { path: name }, new AbortController().signal)).rejects.toMatchObject({ code })
    }
    await hostile('escape.pptx', zipStored([{ name: '../evil.xml', data: Buffer.from('<a/>') }]), 'OFFICE_ARCHIVE_PATH')
    await hostile('dup.pptx', zipStored([{ name: 'ppt/presentation.xml', data: Buffer.from('<a/>') }, { name: 'ppt/presentation.xml', data: Buffer.from('<b/>') }]), 'OFFICE_ARCHIVE_DUPLICATE')
    await hostile('macro.pptx', zipStored([{ name: 'ppt/vbaProject.bin', data: Buffer.from('macro') }]), 'OFFICE_MACRO_FORBIDDEN')
    await hostile('dtd.pptx', zipStored([{ name: 'ppt/presentation.xml', data: Buffer.from('<!DOCTYPE p [<!ENTITY x "y">]><p/>') }, { name: 'ppt/_rels/presentation.xml.rels', data: Buffer.from('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>') }]), 'XML_DTD_FORBIDDEN')
    const external = Buffer.from(empty)
    await writeFile(join(root, 'external.pptx'), external)
    const externalZip = await JSZip.loadAsync(external)
    externalZip.file('ppt/_rels/presentation.xml.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="https://evil.example/a.png" TargetMode="External"/></Relationships>')
    await writeFile(join(root, 'external.pptx'), await externalZip.generateAsync({ type: 'nodebuffer' }))
    await expect(registry.execute('document.pptx.read', { path: 'external.pptx' }, new AbortController().signal)).rejects.toMatchObject({ code: 'OFFICE_EXTERNAL_RELATIONSHIP' })
    const broken = Buffer.from(empty)
    broken[49] ^= 0xff
    await hostile('crc.pptx', broken, 'OFFICE_ARCHIVE_CRC')
    await expect(registry.execute('document.pptx.write', { path: 'no-channel.pptx', slides: [{ title: 'x' }] }, new AbortController().signal)).rejects.toMatchObject({ code: 'OFFICE_WRITE_CHANNEL_REQUIRED' })
    expect(parser.parsePptx(await readFile(join(root, 'deck.pptx')), { maxChars: 50_000 }).text).toContain('第一页')
  })

  it('renders a real PDF page and writes bounded Office files that an independent reader can open', async () => {
    const root = await workspace()
    const registry = await registryFor(root)
    const channel = writerFor(root)
    const signal = new AbortController().signal
    await writeFile(join(root, 'source.pdf'), await readFile(resolve('tests/fixtures/document-tools.pdf')))
    const png = await channel.run(() => registry.execute('document.pdf.render', { sourcePath: 'source.pdf', page: 1, path: 'page.png', dpi: 72 }, signal))
    const pngBytes = await readFile(join(root, 'page.png'))
    expect(pngBytes.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    expect(createHash('sha256').update(pngBytes).digest('hex')).toBe(png.hash)
    expect(png.bytes).toBe(pngBytes.length)
    const { createCanvas, loadImage } = requireFromAdapters('@napi-rs/canvas') as { createCanvas: (w: number, h: number) => { getContext: (kind: '2d') => { drawImage: (image: unknown, x: number, y: number) => void; getImageData: (x: number, y: number, w: number, h: number) => { data: Uint8ClampedArray } } }; loadImage: (bytes: Buffer) => Promise<{ width: number; height: number }> }
    const image = await loadImage(pngBytes)
    expect(image.width).toBe(png.width)
    expect(image.height).toBe(png.height)
    const canvas = createCanvas(image.width, image.height)
    const context = canvas.getContext('2d')
    context.drawImage(image, 0, 0)
    const pixels = context.getImageData(0, 0, image.width, image.height).data
    let ink = 0
    for (let index = 0; index < pixels.length; index += 4) if (pixels[index]! < 250 || pixels[index + 1]! < 250 || pixels[index + 2]! < 250) ink += 1
    expect(ink).toBeGreaterThan(20)
    await expect(channel.run(() => registry.execute('document.pdf.render', { sourcePath: 'source.pdf', page: 1, path: 'page.png' }, signal))).rejects.toMatchObject({ code: 'FILE_BASELINE_CONFLICT' })
    expect(createHash('sha256').update(await readFile(join(root, 'page.png'))).digest('hex')).toBe(png.hash)
    await expect(channel.run(() => registry.execute('document.pdf.render', { sourcePath: 'source.pdf', page: 1, path: 'page.png', expectedHash: 'ab'.repeat(32) }, signal))).rejects.toMatchObject({ code: 'FILE_BASELINE_CONFLICT' })
    await expect(channel.run(() => registry.execute('document.pdf.render', { sourcePath: 'source.pdf', page: 9, path: 'missing.png' }, signal))).rejects.toMatchObject({ code: 'INVALID_PDF_PAGE_RANGE' })
    await expect(access(join(root, 'missing.png'))).rejects.toThrow()
    const aborted = new AbortController()
    aborted.abort()
    await expect(channel.run(() => registry.execute('document.pdf.render', { sourcePath: 'source.pdf', page: 1, path: 'aborted.png' }, aborted.signal))).rejects.toMatchObject({ code: 'ABORTED' })
    await expect(access(join(root, 'aborted.png'))).rejects.toThrow()
    await writeFile(join(root, 'broken.pdf'), Buffer.from('%PDF-1.1\nnot a real page'))
    await expect(channel.run(() => registry.execute('document.pdf.render', { sourcePath: 'broken.pdf', page: 1, path: 'broken.png' }, signal))).rejects.toThrow()
    await expect(access(join(root, 'broken.png'))).rejects.toThrow()

    const docx = await channel.run(() => registry.execute('document.docx.write', {
      path: '说明.docx', title: '脉冲',
      blocks: [
        { type: 'heading', level: 1, text: '标题&<>' },
        { type: 'paragraph', text: '正文“中文”' },
        { type: 'list', items: ['甲', '乙'] },
        { type: 'table', header: true, rows: [['列', '值'], ['名称', '脉冲']] },
      ],
    }, signal))
    const xlsx = await channel.run(() => registry.execute('document.xlsx.write', {
      path: '表.xlsx',
      sheets: [{ name: '汇总', header: true, rows: [['名称', '数值'], ['中文<>', { formula: '1+1' }], ['文本', '=1+1']] }],
    }, signal))
    const pptx = await channel.run(() => registry.execute('document.pptx.write', {
      path: '演示.pptx',
      slides: [{ title: '封面', bullets: ['第一项'], table: { rows: [['格', '中文']] }, imagePath: 'page.png' }],
    }, signal))
    expect(docx.bytes).toBe((await readFile(join(root, '说明.docx'))).length)
    const sheet = await (await requireFromAdapters('jszip').loadAsync(await readFile(join(root, '表.xlsx')))).file('xl/worksheets/sheet1.xml').async('string')
    expect(sheet).toContain('<f>1+1</f>')
    expect(sheet).not.toContain('<f>=1+1</f>')
    const shared = await (await requireFromAdapters('jszip').loadAsync(await readFile(join(root, '表.xlsx')))).file('xl/sharedStrings.xml').async('string')
    expect(shared).toContain('=1+1')
    const reread = await registry.execute('document.pptx.read', { path: '演示.pptx' }, signal)
    expect(reread.text).toContain('封面')
    expect(reread.text).toContain('中文')
    const deck = await requireFromAdapters('jszip').loadAsync(await readFile(join(root, '演示.pptx')))
    expect(deck.file('docProps/core.xml')).toBeNull()
    expect(pptx.hash).toMatch(/^[a-f0-9]{64}$/)
    expect(xlsx.sheets).toBe(1)
  }, 180_000)

  it('refuses plan, test, and escaped output paths', async () => {
    const root = await workspace()
    const registry = await registryFor(root)
    const channel = writerFor(root)
    const signal = new AbortController().signal
    await expect(channel.run(() => registry.execute('document.docx.write', { path: 'docs/plans/plan.docx', blocks: [{ type: 'paragraph', text: 'x' }] }, signal))).rejects.toMatchObject({ code: 'PLAN_PATH_NOT_ALLOWED' })
    await expect(channel.run(() => registry.execute('document.docx.write', { path: '.pulse/note.docx', blocks: [{ type: 'paragraph', text: 'x' }] }, signal))).rejects.toMatchObject({ code: 'INVALID_DRAFT_TARGET' })
    await expect(channel.run(() => registry.execute('document.docx.write', { path: 'tests/note.docx', blocks: [{ type: 'paragraph', text: 'x' }] }, signal))).rejects.toMatchObject({ code: 'FROZEN_TEST_CHANGE' })
    await expect(channel.run(() => registry.execute('document.pdf.render', { sourcePath: 'missing.pdf', page: 1, path: 'out.txt' }, signal))).rejects.toMatchObject({ code: 'OFFICE_TARGET_EXTENSION' })
    await symlink(join(root, 'real.docx'), join(root, 'link.docx'))
    await expect(channel.run(() => registry.execute('document.docx.write', { path: 'link.docx', blocks: [{ type: 'paragraph', text: 'x' }] }, signal))).rejects.toThrow()
    expect(await readdir(root)).toContain('link.docx')
  })

  it('treats the first PPTX window and the returned cursor as new evidence', () => {
    const rows = new Map<string, { tool: string; args: Record<string, unknown>; body: Record<string, unknown> }>([
      ['result-1', { tool: 'pptx.read', args: { path: 'deck.pptx', offset: 0 }, body: { path: 'deck.pptx', hash: 'a'.repeat(64), startSlide: 1, nextSlide: 1, nextOffset: 8 } }],
      ['result-2', { tool: 'pptx.read', args: { path: 'deck.pptx', offset: 8 }, body: { path: 'deck.pptx', hash: 'a'.repeat(64), startSlide: 1, nextSlide: 2, nextOffset: 0 } }],
      ['result-3', { tool: 'pptx.read', args: { path: 'deck.pptx', offset: 0 }, body: { path: 'deck.pptx', hash: 'a'.repeat(64), startSlide: 1, nextSlide: 1, nextOffset: 8 } }],
    ])
    const ctx = { results: { meta: (ref: string) => { const row = rows.get(ref); return row ? { outcomeStatus: 'succeeded' as const, toolName: row.tool, toolArguments: row.args } : undefined }, read: (ref: string) => rows.get(ref)?.body } }
    expect(isPptxPageProgress(ctx, 'result-1', [])).toBe(true)
    expect(isPptxPageProgress(ctx, 'result-2', ['result-1'])).toBe(true)
    expect(isPptxPageProgress(ctx, 'result-3', ['result-1'])).toBe(false)
    expect(isOfficeFileEdit('docx.write', { path: 'a.docx', hash: 'b'.repeat(64) })).toBe(true)
    expect(isOfficeFileEdit('docx.write', { path: 'a.docx' })).toBe(false)
  })

  it('installs the packs on a local host and settles approval, rollback, and cross-run writes', async () => {
    const root = await workspace()
    const isolated = await hostFor(root, 'legacy', 'auto')
    try {
      const opened = await openSurface(isolated, root, 'office-a')
      const program = defineLaneProgram({ id: 'office-write', version: '1' }, (builder) => {
        builder.addStep('write', () => ({ actions: [{ type: 'submit_effects', effects: [tool('office-1', 'docx.write', { path: 'a.docx', blocks: [{ type: 'paragraph', text: '甲' }] })], wait: { onUnsatisfied: 'resume_with_error' } }], next: 'finish' }))
        builder.addStep('finish', (ctx) => ({ actions: [{ type: 'complete', result: settled(ctx) }], next: 'finish' }))
      })
      const outcome = await opened.runtime.start(opened.runtime.createAgent('write office', program).agentId).outcome()
      expect(outcome.status).toBe('succeeded')
      const bytes = await readFile(join(root, 'a.docx'))
      const hash = createHash('sha256').update(bytes).digest('hex')
      const other = await openSurface(isolated, root, 'office-b')
      const otherProgram = defineLaneProgram({ id: 'office-write', version: '1' }, (builder) => {
        builder.addStep('write', () => ({ actions: [{ type: 'submit_effects', effects: [tool('office-1', 'docx.write', { path: 'b.docx', blocks: [{ type: 'paragraph', text: '乙' }] })], wait: { onUnsatisfied: 'resume_with_error' } }], next: 'finish' }))
        builder.addStep('finish', (ctx) => ({ actions: [{ type: 'complete', result: settled(ctx) }], next: 'finish' }))
      })
      expect((await other.runtime.start(other.runtime.createAgent('write other', otherProgram).agentId).outcome()).status).toBe('succeeded')
      const history = await readdir(join(root, '.pulse/file-snapshots/history'))
      const records = await Promise.all(history.filter((name) => name.endsWith('.json')).map(async (name) => JSON.parse(await readFile(join(root, '.pulse/file-snapshots/history', name), 'utf8')) as { runId?: string; effectId?: string; path?: string }))
      const runs = new Set(records.map((record) => record.runId))
      expect(runs.has('office-a')).toBe(true)
      expect(runs.has('office-b')).toBe(true)
      const a = records.find((record) => record.path === 'a.docx')
      const b = records.find((record) => record.path === 'b.docx')
      expect(a?.effectId).toBe(b?.effectId)
      expect([a?.runId, b?.runId].sort()).toEqual(['office-a', 'office-b'])
      const undone = await isolated.host.rollbackFiles({ confirm: true, targets: [{ path: 'a.docx', expectedPostHash: hash }] })
      expect(undone.status).toBe('completed')
      await expect(access(join(root, 'a.docx'))).rejects.toThrow()
      expect((await readFile(join(root, 'b.docx'))).length).toBeGreaterThan(0)
    } finally { await isolated.host.close() }
  }, 60_000)

  it('blocks office writes for read-only mode, a denied approval, and an unknown shell', async () => {
    const root = await workspace()
    const readOnly = await hostFor(root, 'legacy', 'read-only')
    try {
      const opened = await openSurface(readOnly, root, 'office-ro')
      const program = defineLaneProgram({ id: 'office-ro', version: '1' }, (builder) => {
        builder.addStep('write', () => ({ actions: [{ type: 'submit_effects', effects: [tool('office-1', 'pptx.write', { path: 'blocked.pptx', slides: [{ title: 'no' }] })], wait: { onUnsatisfied: 'resume_with_error' } }], next: 'finish' }))
        builder.addStep('finish', (ctx) => ({ actions: [{ type: 'complete', result: settled(ctx) }], next: 'finish' }))
      })
      const outcome = await opened.runtime.start(opened.runtime.createAgent('blocked', program).agentId).outcome()
      expect(JSON.stringify(opened.runtime.state.results.get(outcome.resultRef ?? '')?.value)).toContain('READ_ONLY')
      await expect(access(join(root, 'blocked.pptx'))).rejects.toThrow()
    } finally { await readOnly.host.close() }

    isolatedEnv(root)
    const ask = createLocalHost({
      cwd: root, dataDir: join(root, 'ask-data'), provider: { provider: 'mock' }, approvalMode: 'ask', taskController: false, jarvis: { enabled: false },
      capabilityPacks: packs, enabledCapabilityPacks: ['docx'],
      mockToolCalls: [{ name: 'docx.write', input: { path: 'ask.docx', blocks: [{ type: 'paragraph', text: '待批准' }] } }], mockAfterToolResponse: 'done',
    })
    try {
      const conversation = await ask.createConversation()
      const run = await ask.sendMessage(conversation.id, { text: 'write a document' })
      for await (const event of run.events) {
        if (event.type !== 'waiting') continue
        const data = event.data as { effectId?: string }
        await run.reply(data.effectId!, { approved: false })
      }
      await run.outcome()
      await expect(access(join(root, 'ask.docx'))).rejects.toThrow()
    } finally { await ask.close() }

    const continuous = await hostFor(root, 'continuous', 'auto')
    try {
      const opened = await openSurface(continuous, root, 'office-shell')
      const shellDirectory = join(continuous.runDirectory('office-shell'), 'shell-processes')
      await mkdir(shellDirectory, { recursive: true })
      await writeFile(join(shellDirectory, `${'c'.repeat(64)}.json`), JSON.stringify({ processId: 'c'.repeat(64), agentId: 'agent', laneId: 'lane', status: 'unknown', command: { command: 'fixture' } }))
      const program = defineLaneProgram({ id: 'office-shell', version: '1' }, (builder) => {
        builder.addStep('write', () => ({ actions: [{ type: 'submit_effects', effects: [tool('office-1', 'spreadsheet.xlsx.write', { path: 'blocked.xlsx', sheets: [{ name: 'S', rows: [['a']] }] })], wait: { onUnsatisfied: 'resume_with_error' } }], next: 'finish' }))
        builder.addStep('finish', (ctx) => ({ actions: [{ type: 'complete', result: settled(ctx) }], next: 'finish' }))
      })
      const outcome = await opened.runtime.start(opened.runtime.createAgent('shell', program).agentId).outcome()
      const values = [...opened.runtime.state.results.values()].map((item) => item.value)
      expect(JSON.stringify({ outcome, values })).toContain('SHELL_PROCESS_STATE_UNKNOWN')
      await expect(access(join(root, 'blocked.xlsx'))).rejects.toThrow()
    } finally { await continuous.host.close() }
  }, 60_000)

  it('lets a default legacy host read and then generate an office file through acceptance', async () => {
    const root = await workspace()
    await writeFile(join(root, 'notes.md'), 'facts\n')
    isolatedEnv(root)
    let work = 0
    let writes = 0
    vi.mocked(globalThis.fetch).mockImplementation(async (_url: unknown, init?: { body?: string }) => {
      const request = JSON.parse(String(init?.body ?? '{}'))
      const text = currentRequestText(request.messages ?? [])
      const refs = suppliedRequestResults(request.messages ?? []).map((item) => item.id)
      const chat = (message: string | { content: string; tool_calls: unknown[] }) => Response.json({ choices: [{ message: typeof message === 'string' ? { content: message } : message, finish_reason: typeof message === 'string' ? 'stop' : 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 2 } })
      const call = (name: string, input: unknown) => chat({ content: '', tool_calls: [{ id: `call-${work}`, function: { name, arguments: JSON.stringify(input) } }] })
      if (text.includes('You are the Pulse safety reviewer')) return chat('APPROVE')
      if (text.includes("You write Pulse's final user-facing reply")) return chat('Saved report.docx.')
      if (text.includes('Create an executable plan')) return chat(JSON.stringify({ tasks: [{ id: 'edit', kind: 'edit', goal: 'Read notes.md and create report.docx', check: 'report.docx contains the note', criterionIds: ['criterion-1'], dependsOn: [] }] }))
      if (text.includes('Verify ONLY the active taskController stage')) return chat(JSON.stringify({ status: 'passed', evidenceRefs: refs, note: 'report.docx is saved.' }))
      if (text.includes('Independently verify every ORIGINAL')) return chat(JSON.stringify({ criteria: [{ criterionId: 'criterion-1', status: 'passed', evidenceRefs: refs, rationale: 'The generated document is on disk.' }] }))
      work += 1
      if (work === 1) return call('fs_read', { path: 'notes.md' })
      if (writes === 0 || text.includes('Runtime recovery notice') || text.includes('that read was not executed')) {
        writes += 1
        return call('docx_write', { path: 'report.docx', blocks: [{ type: 'paragraph', text: 'facts' }] })
      }
      return chat('Saved report.docx.')
    })
    const host = createLocalHost({
      cwd: root, dataDir: join(root, 'data'), provider: { provider: 'openai-compatible', defaultModel: 'fixture', baseURL: 'http://127.0.0.1:9/v1' },
      taskController: true, jarvis: { enabled: false }, approvalMode: 'auto', maxModelCalls: 24,
      capabilityPacks: packs, enabledCapabilityPacks: ['docx'],
      approvalReview: { provider: 'ollama', model: 'review-fixture', baseURL: 'http://127.0.0.1:9', timeoutMs: 30000 },
    })
    try {
      const conversation = await host.createConversation()
      const run = await host.sendMessage(conversation.id, { text: 'Read notes.md and create report.docx with the notes.' })
      const outcome = await run.outcome()
      expect(await run.taskOutcome(), outcome.text).toMatchObject({ status: 'accepted' })
      const input = JSON.parse(await readFile(join(root, 'data', 'conversations', conversation.id, 'runs', run.id, 'input.json'), 'utf8'))
      expect(input.controllerVersion).toBe('58')
      expect(input.taskControllerPolicy).toBe('continuous')
      const runtime = JSON.parse(await readFile(join(root, 'data', 'conversations', conversation.id, 'runs', run.id, 'runtime.json'), 'utf8')).state.state
      const names = runtime.effects.map((entry: [string, { input?: { name?: string } }]) => entry[1].input?.name).filter(Boolean)
      expect(names).toContain('fs.read')
      expect(names).toContain('docx.write')
      expect(names.indexOf('fs.read')).toBeLessThan(names.indexOf('docx.write'))
      expect((await readFile(join(root, 'report.docx'))).length).toBeGreaterThan(0)
    } finally { await host.close() }
  }, 90_000)

  it('dispatches an office write after a read on the legacy edit gate', async () => {
    const executed: string[] = []
    let models = 0
    const program = defineLaneProgram({ id: 'office-edit-gate', version: '1' }, (builder) => builder.addReActLoopStep('reason', {
      instruction: 'Read the source, then generate report.docx.', toolAllow: ['fs.read', 'docx.write'], blockReadOnlyTools: () => true, maxTurns: 6, onFinish: () => ({ complete: {} }),
    }))
    const runtime = new PulseRuntime({ effectExecutor: async (effect) => {
      if (effect.kind === 'tool') {
        const name = (effect.input as { name: string }).name
        executed.push(name)
        return { value: name === 'fs.read' ? { path: 'notes.md', hash: 'a'.repeat(64), content: 'facts' } : { path: 'report.docx', hash: 'b'.repeat(64), bytes: 42 } }
      }
      models += 1
      return { value: models === 1
        ? { finishReason: 'tool_calls', toolCalls: [{ name: 'fs.read', input: { path: 'notes.md' } }] }
        : executed.includes('docx.write')
          ? { text: 'written', finishReason: 'stop', toolCalls: [] }
          : { finishReason: 'tool_calls', toolCalls: [{ name: 'docx.write', input: { path: 'report.docx', blocks: [{ type: 'paragraph', text: 'facts' }] } }] } }
    } })
    expect((await runtime.start(runtime.createAgent('Generate document', program).agentId).outcome()).status).toBe('succeeded')
    expect(executed).toEqual(['fs.read', 'docx.write'])
  })

  it('rejects pipe DDE formulas before writing and keeps local formulas', async () => {
    const root = await workspace()
    const registry = await registryFor(root)
    const channel = writerFor(root)
    const signal = new AbortController().signal
    await writeFile(join(root, 'existing.xlsx'), Buffer.from('keep'))
    for (const formula of ["fixtureApp|'fixtureTopic'!A1", "+fixtureApp|'fixtureTopic'!A1", "cmd|'/c calc'!A1"]) {
      await expect(channel.run(() => registry.execute('document.xlsx.write', { path: 'existing.xlsx', expectedHash: createHash('sha256').update('keep').digest('hex'), sheets: [{ name: 'Data', rows: [[{ formula }]] }] }, signal))).rejects.toMatchObject({ code: 'OFFICE_FORMULA_FORBIDDEN' })
      expect(await readFile(join(root, 'existing.xlsx'), 'utf8')).toBe('keep')
    }
    await expect(channel.run(() => registry.execute('document.xlsx.write', { path: 'missing.xlsx', sheets: [{ name: 'Data', rows: [[{ formula: "fixtureApp|'fixtureTopic'!A1" }]] }] }, signal))).rejects.toMatchObject({ code: 'OFFICE_FORMULA_FORBIDDEN' })
    await expect(access(join(root, 'missing.xlsx'))).rejects.toThrow()
    await channel.run(() => registry.execute('document.xlsx.write', { path: 'safe.xlsx', sheets: [{ name: 'Data', rows: [[{ formula: 'SUM(A1:A2)' }], [{ formula: 'A1+B1' }], ['=1+1']] }] }, signal))
    const zip = await requireFromAdapters('jszip').loadAsync(await readFile(join(root, 'safe.xlsx')))
    const sheet = await zip.file('xl/worksheets/sheet1.xml').async('string')
    expect(sheet).toContain('<f>SUM(A1:A2)</f>')
    expect(sheet).toContain('<f>A1+B1</f>')
    expect(sheet).not.toContain("fixtureApp")
    const shared = await zip.file('xl/sharedStrings.xml').async('string')
    expect(shared).toContain('=1+1')
  })

  it('stores the PPTX document title and keeps a 20-row table on the canvas', async () => {
    const root = await workspace()
    const registry = await registryFor(root)
    const channel = writerFor(root)
    const signal = new AbortController().signal
    await writeFile(join(root, 'dot.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    const rows = Array.from({ length: 20 }, (_, index) => [`r${index}`])
    const saved = await channel.run(() => registry.execute('document.pptx.write', {
      path: 'table20.pptx', title: 'Independent document title',
      slides: [{ title: 'Rows', bullets: ['intro'], table: { rows }, imagePath: 'dot.png' }],
    }, signal))
    expect(saved.slides).toBeGreaterThan(1)
    const zip = await requireFromAdapters('jszip').loadAsync(await readFile(join(root, 'table20.pptx')))
    const core = await zip.file('docProps/core.xml').async('string')
    const types = await zip.file('[Content_Types].xml').async('string')
    const rels = await zip.file('_rels/.rels').async('string')
    expect(core).toContain('Independent document title')
    expect(types).toContain('PartName="/docProps/core.xml"')
    expect(rels).toContain('relationships/metadata/core-properties')
    const boxes = (xml: string) => [...xml.matchAll(/<a:(?:off|chOff) x="(\d+)" y="(\d+)"\/><a:(?:ext|chExt) cx="(\d+)" cy="(\d+)"\/>/g)].map((match) => ({ x: Number(match[1]), y: Number(match[2]), cx: Number(match[3]), cy: Number(match[4]) })).filter((box) => box.cx > 0 && box.cy > 0)
    const overlaps = (left: { x: number; y: number; cx: number; cy: number }, right: { x: number; y: number; cx: number; cy: number }) => left.x < right.x + right.cx && right.x < left.x + left.cx && left.y < right.y + right.cy && right.y < left.y + left.cy
    const texts: string[] = []
    for (let number = 1; number <= saved.slides; number += 1) {
      const xml = await zip.file(`ppt/slides/slide${number}.xml`).async('string')
      const shapes = boxes(xml)
      for (const shape of shapes) {
        expect(shape.x).toBeGreaterThanOrEqual(0)
        expect(shape.y).toBeGreaterThanOrEqual(0)
        expect(shape.x + shape.cx).toBeLessThanOrEqual(12_192_000)
        expect(shape.y + shape.cy).toBeLessThanOrEqual(6_858_000)
      }
      for (let left = 0; left < shapes.length; left += 1) for (let right = left + 1; right < shapes.length; right += 1) expect(overlaps(shapes[left]!, shapes[right]!)).toBe(false)
      texts.push(...[...xml.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((match) => match[1] ?? ''))
    }
    const joined = texts.join('')
    expect(joined).toContain('intro')
    for (const row of rows) expect(joined).toContain(row[0]!)
    const long = '测'.repeat(400)
    await channel.run(() => registry.execute('document.pptx.write', { path: 'long.pptx', slides: [{ title: 'Long', bullets: [long, 'after'] }] }, signal))
    const longZip = await requireFromAdapters('jszip').loadAsync(await readFile(join(root, 'long.pptx')))
    const longText = (await Promise.all(Object.keys(longZip.files).filter((name) => /ppt\/slides\/slide\d+\.xml$/.test(name)).map(async (name) => longZip.file(name).async('string')))).join('')
    expect(longText).toContain(long)
    expect(longText).toContain('after')
    await expect(channel.run(() => registry.execute('document.pptx.write', { path: 'overflow.pptx', slides: [{ title: 'Too big', bullets: Array.from({ length: 30 }, () => '测'.repeat(2_000)) }] }, signal))).rejects.toMatchObject({ code: 'PPTX_LAYOUT_REJECTED' })
    await expect(access(join(root, 'overflow.pptx'))).rejects.toThrow()
  })

  it('keeps a wrapped Chinese bullet above its table and paginates a ragged wide row', async () => {
    const root = await workspace()
    const registry = await registryFor(root)
    const channel = writerFor(root)
    const signal = new AbortController().signal
    const bullet = `始${'中'.repeat(47)}终`
    const boundary = await channel.run(() => registry.execute('document.pptx.write', {
      path: 'boundary.pptx',
      slides: [{ title: 'Boundary text and table', bullets: [bullet], table: { rows: [['TABLE HEADER', 'VALUE'], ['row', '42']] } }],
    }, signal))
    expect(boundary.slides).toBeGreaterThan(0)
    const boundaryZip = await requireFromAdapters('jszip').loadAsync(await readFile(join(root, 'boundary.pptx')))
    const boundarySlides = await Promise.all(Array.from({ length: boundary.slides }, async (_, index) => boundaryZip.file(`ppt/slides/slide${index + 1}.xml`).async('string')))
    const boundaryText = boundarySlides.join('')
    expect(boundaryText).toContain('lIns="91440"')
    expect(boundaryText).toContain('marL="342900"')
    expect(boundaryText).toContain(bullet)
    expect(boundaryText).toContain('TABLE HEADER')
    expect(boundaryText).toContain('VALUE')
    expect(boundaryText).toContain('>row<')
    expect(boundaryText).toContain('>42<')
    for (const xml of boundarySlides) {
      const body = xml.match(/name="Body"[\s\S]*?<a:off x="(\d+)" y="(\d+)"\/><a:ext cx="(\d+)" cy="(\d+)"\/>/)
      const table = xml.match(/name="Table"[\s\S]*?<a:off x="(\d+)" y="(\d+)"\/><a:ext cx="(\d+)" cy="(\d+)"\/>/)
      if (!body || !table) continue
      const bodyBottom = Number(body[2]) + Number(body[4])
      expect(bodyBottom).toBeLessThanOrEqual(Number(table[2]))
      expect(Number(body[4])).toBeGreaterThanOrEqual(274_320 * 2 + 45_720 * 2)
      expect(Number(table[2]) + Number(table[4])).toBeLessThanOrEqual(6_858_000)
    }
    const longCell = `始${'中'.repeat(160)}终`
    const ragged = await channel.run(() => registry.execute('document.pptx.write', {
      path: 'ragged-long.pptx',
      slides: [{ title: 'Ragged rows', table: { rows: [[longCell], Array.from({ length: 12 }, (_, index) => `C${index}`)] } }],
    }, signal))
    expect(ragged.slides).toBeGreaterThan(1)
    const raggedZip = await requireFromAdapters('jszip').loadAsync(await readFile(join(root, 'ragged-long.pptx')))
    const grids: string[] = []
    const cells: string[] = []
    for (let number = 1; number <= ragged.slides; number += 1) {
      const xml = await raggedZip.file(`ppt/slides/slide${number}.xml`).async('string')
      const columns = [...xml.matchAll(/<a:gridCol w="(\d+)"\/>/g)].map((match) => match[1])
      expect(columns).toHaveLength(12)
      grids.push(columns.join(','))
      const frame = xml.match(/name="Table"[\s\S]*?<a:off x="(\d+)" y="(\d+)"\/><a:ext cx="(\d+)" cy="(\d+)"\/>/)
      expect(frame).not.toBeNull()
      expect(Number(frame?.[2]) + Number(frame?.[4])).toBeLessThanOrEqual(6_858_000)
      const table = xml.slice(xml.indexOf('name="Table"'))
      cells.push(...[...table.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((match) => match[1] ?? ''))
    }
    expect(new Set(grids).size).toBe(1)
    const joined = cells.join('')
    expect(joined).toContain(longCell)
    for (let index = 0; index < 12; index += 1) expect(joined).toContain(`C${index}`)
    expect(joined.indexOf('C0')).toBeLessThan(joined.indexOf('C11'))
    expect(joined.split('C0').length - 1).toBe(1)
  })

  it('restarts numbering for each ordered list', async () => {
    const root = await workspace()
    const channel = writerFor(root)
    const registry = await registryFor(root)
    await channel.run(() => registry.execute('document.docx.write', {
      path: 'lists.docx',
      blocks: [
        { type: 'list', ordered: true, items: ['First list A', 'First list B'] },
        { type: 'paragraph', text: 'New list follows' },
        { type: 'list', ordered: true, items: ['Second list A', 'Second list B'] },
        { type: 'list', items: ['bullet'] },
      ],
    }, new AbortController().signal))
    const zip = await requireFromAdapters('jszip').loadAsync(await readFile(join(root, 'lists.docx')))
    const document = await zip.file('word/document.xml').async('string')
    const numbering = await zip.file('word/numbering.xml').async('string')
    const ids = [...document.matchAll(/<w:numId w:val="(\d+)"\/>/g)].map((match) => match[1])
    expect(ids).toEqual(['2', '2', '3', '3', '1'])
    expect(numbering).toContain('<w:num w:numId="2">')
    expect(numbering).toContain('<w:num w:numId="3">')
    expect(numbering).toContain('<w:startOverride w:val="1"/>')
  })

  it('keeps PPTX read windows on UTF-16 code point boundaries', async () => {
    const root = await workspace()
    const registry = await registryFor(root)
    const channel = writerFor(root)
    const signal = new AbortController().signal
    const bullet = `${'0123456789012345678901'}😀尾`
    await channel.run(() => registry.execute('document.pptx.write', { path: 'emoji.pptx', slides: [{ title: 'E', bullets: [bullet] }, { title: '', bullets: ['下一页'] }] }, signal))
    const slideBodies = (text: string) => text.split(/\n\n--- Slide /).map((part: string, index: number) => index === 0 ? part.replace(/^--- Slide \d+ ---\n/, '') : part.replace(/^\d+ ---\n/, '')).join('')
    const stitch = async (maxChars: number) => {
      let startSlide = 1
      let offset = 0
      let body = ''
      for (let step = 0; step < 500; step += 1) {
        const page = await registry.execute('document.pptx.read', { path: 'emoji.pptx', startSlide, offset, maxChars }, signal)
        expect(Buffer.from(page.text, 'utf8').toString('utf8')).toBe(page.text)
        body += slideBodies(page.text)
        if (!page.truncated) return body
        expect(page.nextSlide === startSlide && page.nextOffset === offset).toBe(false)
        startSlide = page.nextSlide
        offset = page.nextOffset
      }
      throw new Error('PPTX cursor did not finish')
    }
    const full = await registry.execute('document.pptx.read', { path: 'emoji.pptx', maxChars: 50_000 }, signal)
    const fullBody = slideBodies(full.text)
    expect(await stitch(1)).toBe(fullBody)
    expect(await stitch(24)).toBe(fullBody)
    expect(fullBody).toContain('😀')
    expect(fullBody).toContain('下一页')
    const bounded = await registry.execute('document.pptx.read', { path: 'emoji.pptx', maxChars: 24 }, signal)
    expect(Buffer.from(bounded.text, 'utf8').toString('utf8')).toBe(bounded.text)
    const slideBody = full.text.split(/\n\n--- Slide /)[0]!.replace(/^--- Slide \d+ ---\n/, '')
    const emojiAt = slideBody.indexOf('😀')
    expect(emojiAt).toBeGreaterThan(0)
    await expect(registry.execute('document.pptx.read', { path: 'emoji.pptx', offset: emojiAt + 1, maxChars: 8 }, signal)).rejects.toMatchObject({ code: 'INVALID_PPTX_OFFSET' })
  })

  it('does not create an outside directory when an office write rejects a parent symlink', async () => {
    const root = await workspace()
    const outside = await mkdtemp(join(tmpdir(), 'pulse-office-outside-'))
    roots.push(outside)
    await symlink(outside, join(root, 'link'))
    await mkdir(join(root, 'real'), { recursive: true })
    await symlink(join(root, 'real'), join(root, 'inside'))
    const isolated = await hostFor(root, 'legacy', 'auto')
    try {
      const opened = await openSurface(isolated, root, 'office-link')
      const program = defineLaneProgram({ id: 'office-link', version: '1' }, (builder) => {
        builder.addStep('write', () => ({ actions: [{ type: 'submit_effects', effects: [tool('office-1', 'docx.write', { path: 'link/new-directory/leak.docx', blocks: [{ type: 'paragraph', text: 'x' }] })], wait: { onUnsatisfied: 'resume_with_error' } }], next: 'finish' }))
        builder.addStep('finish', (ctx) => ({ actions: [{ type: 'complete', result: settled(ctx) }], next: 'finish' }))
      })
      const outcome = await opened.runtime.start(opened.runtime.createAgent('link', program).agentId).outcome()
      const values = [...opened.runtime.state.results.values()].map((item) => item.value)
      expect(JSON.stringify({ outcome, values })).toContain('PATH_OUTSIDE_SANDBOX')
      expect(await readdir(outside)).toEqual([])
      const history = await readdir(join(root, '.pulse/file-snapshots/history')).catch(() => [] as string[])
      const records = await Promise.all(history.filter((name) => name.endsWith('.json')).map(async (name) => JSON.parse(await readFile(join(root, '.pulse/file-snapshots/history', name), 'utf8')) as { path?: string }))
      expect(records.some((record) => record.path?.includes('leak.docx'))).toBe(false)
      const nested = defineLaneProgram({ id: 'office-nested', version: '1' }, (builder) => {
        builder.addStep('write', () => ({ actions: [{ type: 'submit_effects', effects: [tool('office-2', 'docx.write', { path: 'inside/nested/ok.docx', blocks: [{ type: 'paragraph', text: 'ok' }] })], wait: { onUnsatisfied: 'resume_with_error' } }], next: 'finish' }))
        builder.addStep('finish', (ctx) => ({ actions: [{ type: 'complete', result: settled(ctx) }], next: 'finish' }))
      })
      expect((await opened.runtime.start(opened.runtime.createAgent('nested', nested).agentId).outcome()).status).toBe('succeeded')
      expect((await readFile(join(root, 'real/nested/ok.docx'))).length).toBeGreaterThan(0)
    } finally { await isolated.host.close() }
  }, 60_000)

  it('loads the compiled PPTX parser from a dist tree that has no src', async () => {
    const readerPath = resolve('packages/adapters/dist/documents/pptx-read.js')
    if (!existsSync(readerPath)) {
      const compiled = spawnSync(process.execPath, [resolve('node_modules/typescript/bin/tsc'), '-b', 'packages/adapters', '--pretty', 'false'], { cwd: resolve('.'), encoding: 'utf8' })
      expect(compiled.status, `${compiled.stdout}\n${compiled.stderr}`).toBe(0)
    }
    const copied = spawnSync(process.execPath, [resolve('scripts/build/copy-adapter-assets.mjs')], { cwd: resolve('.'), encoding: 'utf8' })
    expect(copied.status, copied.stderr).toBe(0)
    const temp = await mkdtemp(join(tmpdir(), 'pulse-pptx-dist-'))
    roots.push(temp)
    await cp(resolve('packages/adapters/dist/documents'), join(temp, 'documents'), { recursive: true })
    const resolvedParser = createRequire(pathToFileURL(join(temp, 'documents/pptx-read.js'))).resolve('./pptx-parse.cjs')
    expect(realpathSync(resolvedParser)).toBe(realpathSync(join(temp, 'documents/pptx-parse.cjs')))
    expect(resolvedParser.includes(`${sep}src${sep}`)).toBe(false)
    const root = await workspace()
    const channel = writerFor(root)
    const registry = await registryFor(root)
    await channel.run(() => registry.execute('document.pptx.write', { path: 'dist.pptx', slides: [{ title: '编译' }] }, new AbortController().signal))
    const { readPptx } = await import(pathToFileURL(readerPath).href) as { readPptx: (dir: string, input: { path: string; maxChars: number }, signal: AbortSignal) => Promise<{ totalSlides: number; text: string }> }
    const read = await readPptx(root, { path: 'dist.pptx', maxChars: 5_000 }, new AbortController().signal)
    expect(read.totalSlides).toBe(1)
    expect(read.text).toContain('编译')
  }, 120_000)
})

if (process.env.PULSE_OFFICE_SOFFICE) {
  it('opens generated office files with the configured soffice binary', async () => {
    const soffice = process.env.PULSE_OFFICE_SOFFICE!
    await access(soffice)
    const root = await mkdtemp(join(tmpdir(), 'pulse-office-soffice-'))
    try {
    const registry = await registryFor(root)
    const channel = writerFor(root)
    const signal = new AbortController().signal
    await writeFile(join(root, 'source.pdf'), await readFile(resolve('tests/fixtures/document-tools.pdf')))
    await channel.run(() => registry.execute('document.pdf.render', { sourcePath: 'source.pdf', page: 1, path: 'page.png', dpi: 72 }, signal))
    await channel.run(() => registry.execute('document.docx.write', { path: '说明.docx', blocks: [{ type: 'paragraph', text: '标题&<>' }, { type: 'paragraph', text: '脉冲' }] }, signal))
    await channel.run(() => registry.execute('document.xlsx.write', { path: '表.xlsx', sheets: [{ name: '汇总', rows: [['中文<>'], ['=1+1']] }] }, signal))
    await channel.run(() => registry.execute('document.pptx.write', { path: '演示.pptx', slides: [{ title: '封面', bullets: ['第一项'], table: { rows: [['格', '中文']] }, imagePath: 'page.png' }] }, signal))
    const home = join(root, 'soffice-home')
    const out = join(root, 'soffice-out')
    await mkdir(out, { recursive: true })
    await convertWithSoffice(soffice, join(root, '说明.docx'), out, home, 'txt:Text')
    await convertWithSoffice(soffice, join(root, '表.xlsx'), out, home, 'csv')
    await convertWithSoffice(soffice, join(root, '演示.pptx'), out, home, 'pdf')
    expect(await readFile(join(out, '说明.txt'), 'utf8')).toContain('脉冲')
    expect(await readFile(join(out, '表.csv'), 'utf8')).toContain('=1+1')
    const pdfText = (await registry.execute('document.pdf.read', { path: 'soffice-out/演示.pdf' }, signal)).text.replaceAll(/\s+/g, '')
    expect(pdfText).toContain('封面')
    expect(pdfText).toContain('第一项')
    } finally { await rm(root, { recursive: true, force: true }) }
  }, 180_000)
}
