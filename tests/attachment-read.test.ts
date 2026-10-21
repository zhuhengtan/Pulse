import { writeConversationFixture } from './conversation-fixtures.js'
import { createRequire } from 'node:module'
import { mkdtemp, readFile, writeFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createLocalHost } from '@hunterzhu/pulse-server'
import { ToolRegistry } from '@hunterzhu/pulse-tool-sdk'
import { extractDocxText } from '@hunterzhu/pulse-adapters'
import { AttachmentStore, attachmentDownload } from '../packages/server/src/attachments.js'

const require = createRequire(resolve('packages/adapters/package.json'))
const JSZip = createRequire(require.resolve('mammoth'))('jszip')
const roots: string[] = []
afterEach(async () => { vi.unstubAllGlobals(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function docx(text = '中文正文') {
  const zip = new JSZip()
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')
  zip.file('word/document.xml', `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>表格单元格</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>`)
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }) as Promise<Buffer>
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'pulse-attachments-')); roots.push(root)
  const host = createLocalHost({ cwd: root, dataDir: join(root, 'data'), taskController: false })
  const conversation = await host.createConversation(), store = new AttachmentStore(join(root, 'data'), conversation.id)
  const registry = new ToolRegistry({ workspaceRoots: [root], allowNetwork: false }); registry.register(store.tool())
  async function attach(name: string, bytes: Buffer, mediaType = 'application/octet-stream') {
    const items = await store.save([{ name, id: `att-${Date.now()}-${Math.random().toString(16).slice(2)}`, type: mediaType.startsWith('image/') ? 'image' : 'file', size: bytes.length, mediaType, data: bytes.toString('base64') }])
    await host.appendAssistantUserMessage(conversation.id, { id: `msg-${items[0]!.id}`, runId: 'attachment-fixture', text: '', attachments: items, createdAt: new Date().toISOString() })
    return items[0]!
  }
  return { root, host, conversation, store, attach, read: (input: Record<string, unknown>) => registry.execute('attachment.read', input, new AbortController().signal) as Promise<any> }
}
it('serves only host-allowlisted images inline', () => {
  expect(attachmentDownload({ mediaType: 'image/png', name: 'a.png' })).toMatchObject({ mediaType: 'image/png', disposition: expect.stringContaining('inline') })
  expect(attachmentDownload({ mediaType: 'image/svg+xml', name: 'a.svg' }).mediaType).toBe('application/octet-stream')
  expect(attachmentDownload({ mediaType: 'text/html', name: 'a.html' }).disposition).toContain('attachment')
  expect(attachmentDownload({ mediaType: 'image/png; charset=utf-8', name: 'a.png' }).disposition).toContain('attachment')
})

it('reads text and DOCX by continuation windows, preserving Chinese paragraphs and table text', async () => {
  const f = await fixture()
  try {
    const text = await f.attach('notes.txt', Buffer.from('第一段\n第二段'), 'text/plain')
    expect(await f.read({ id: text.id, maxChars: 4 })).toMatchObject({ text: '第一段\n', nextOffset: 4, truncated: true })
    expect(await f.read({ id: text.id, offset: 4 })).toMatchObject({ text: '第二段', nextOffset: null })
    const word = await f.attach('中文.docx', await docx())
    const first = await f.read({ id: word.id, maxChars: 4 }), second = await f.read({ id: word.id, offset: first.nextOffset })
    expect(first.text + second.text).toContain('中文正文\n\n表格单元格')
    await f.store.remember()
    await writeConversationFixture(join(f.root, 'data', 'conversations', f.conversation.id, 'messages.jsonl'), '')
    const cold = new AttachmentStore(join(f.root, 'data'), f.conversation.id)
    expect(await cold.index()).toContain(word.id)
  } finally { await f.host.close() }
})
it('reads PDF pages and XLSX row windows without skipping later rows', async () => {
  const f = await fixture()
  try {
    const pdf = await f.attach('sample.pdf', await readFile('tests/fixtures/document-tools.pdf'), 'application/pdf')
    expect(await f.read({ id: pdf.id, startPage: 1, endPage: 1 })).toMatchObject({ totalPages: 1, nextPage: null, text: expect.stringContaining('Pulse PDF fixture text') })
    const xlsx = await f.attach('sample.xlsx', await readFile('tests/fixtures/document-tools.xlsx'))
    const first = await f.read({ id: xlsx.id, sheet: 'Summary', maxRows: 2 })
    expect(first.nextRow).toBe(3)
    const second = await f.read({ id: xlsx.id, sheet: 'Summary', startRow: first.nextRow, maxRows: 2 })
    expect(second.worksheets[0].preview[0].row).toBe(3)
    expect(second.nextRow).toBeNull()
  } finally { await f.host.close() }
})
it('rejects foreign IDs, paths, unsupported binary, reused content and symlinks', async () => {
  const f = await fixture()
  try {
    await expect(f.read({ id: '../anything' })).rejects.toMatchObject({ code: 'ATTACHMENT_NOT_VISIBLE' })
    for (const id of ['../escape', 'a:b', 'CON', 'NUL.txt']) await expect(f.store.save([{ id, name: 'a.txt', type: 'file', size: 1, mediaType: 'text/plain', data: 'eA==' }])).rejects.toMatchObject({ code: 'INVALID_ATTACHMENT_ID' })
    const binary = await f.attach('archive.zip', Buffer.from('not text'))
    await expect(f.read({ id: binary.id })).rejects.toMatchObject({ code: 'ATTACHMENT_FORMAT_UNSUPPORTED' })
    const other = await f.host.createConversation(), foreign = new AttachmentStore(join(f.root, 'data'), other.id)
    await expect(foreign.save([{ ...binary, data: undefined, url: 'https://example.invalid/arbitrary' }])).rejects.toMatchObject({ code: 'ATTACHMENT_NOT_FOUND' })
    await expect(f.store.save([{ ...binary, data: Buffer.from('changed').toString('base64') }])).rejects.toMatchObject({ code: 'ATTACHMENT_ID_REUSED' })
    await rm(join(f.store.directory, binary.id)); await symlink(join(f.root, 'private.txt'), join(f.store.directory, binary.id))
    await expect(f.read({ id: binary.id })).rejects.toMatchObject({ code: 'ATTACHMENT_SYMLINK_FORBIDDEN' })
  } finally { await f.host.close() }
})
it('rejects corrupted/encrypted/oversized DOCX archives and terminates timed-out or aborted parsers', async () => {
  const signal = new AbortController().signal
  await expect(extractDocxText(Buffer.from('bad'), signal)).rejects.toMatchObject({ code: 'INVALID_DOCX_ARCHIVE' })
  const encrypted = await docx(); encrypted.writeUInt16LE(encrypted.readUInt16LE(6) | 1, 6)
  const central = encrypted.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])); encrypted.writeUInt16LE(encrypted.readUInt16LE(central + 8) | 1, central + 8)
  await expect(extractDocxText(encrypted, signal)).rejects.toMatchObject({ code: 'UNSUPPORTED_DOCX_ENTRY' })
  const huge = new JSZip(); huge.file('word/document.xml', 'x'.repeat(17 * 1024 * 1024))
  await expect(extractDocxText(await huge.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }), signal)).rejects.toMatchObject({ code: 'UNSUPPORTED_DOCX_ENTRY' })
  await expect(extractDocxText(await docx(), signal, 1)).rejects.toMatchObject({ code: 'DOCX_PARSE_TIMEOUT' })
  const controller = new AbortController(); const pending = extractDocxText(await docx(), controller.signal); controller.abort()
  await expect(pending).rejects.toMatchObject({ code: 'ABORTED' })
})
it.each(['text', 'image', 'docx', 'pdf', 'xlsx'] as const)('sends actual %s contents through Host tool results into Provider requests', async kind => {
  const root = await mkdtemp(join(tmpdir(), 'pulse-attachment-provider-')); roots.push(root)
  const requests: any[] = [], imageData = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC'
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    const body = JSON.parse(String(init?.body)); requests.push(body)
    const message = requests.length === 1 ? { content: '', tool_calls: [{ id: 'read-upload', function: { name: 'attachment_read', arguments: JSON.stringify({ id: 'uploaded-fixture', ...(kind === 'xlsx' ? { sheet: 'Summary' } : {}) }) } }] } : { content: '已读取附件内容' }
    return Response.json({ choices: [{ message, finish_reason: requests.length === 1 ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2 } })
  }))
  const profile = { provider: 'openai-compatible' as const, baseURL: 'http://127.0.0.1:12345/v1', defaultModel: 'fixture' }
  const host = createLocalHost({ cwd: root, dataDir: join(root, 'data'), provider: profile, providerProfiles: { fixture: profile }, providerModels: { fixture: { provider: 'fixture', model: 'fixture', imageInput: 'supported' } }, activeModel: 'fixture', assistantModel: 'fixture' })
  try {
    const conversation = await host.createConversation()
    const bytes = kind === 'docx' ? await docx('UNIQUE_DOCX_CONTENT_4829') : kind === 'pdf' ? await readFile('tests/fixtures/document-tools.pdf') : kind === 'xlsx' ? await readFile('tests/fixtures/document-tools.xlsx') : Buffer.from('UNIQUE_UPLOADED_CONTENT_4829')
    const name = kind === 'image' ? 'photo.png' : kind === 'text' ? 'notes.txt' : `notes.${kind}`
    const run = await host.sendMessage(conversation.id, { text: '', assistantChat: true, attachments: [{ id: 'uploaded-fixture', name, type: kind === 'image' ? 'image' : 'file', mediaType: kind === 'image' ? 'image/png' : kind === 'text' ? 'text/plain' : 'application/octet-stream', size: 10, data: kind === 'image' ? imageData : bytes.toString('base64') }] })
    for await (const event of run.events) {}
    expect(await run.outcome()).toMatchObject({ status: 'succeeded' })
    expect(requests).toHaveLength(2)
    const second = JSON.stringify(requests[1]); expect(second).toContain(kind === 'text' ? 'UNIQUE_UPLOADED_CONTENT_4829' : kind === 'image' ? `data:image/png;base64,${imageData}` : kind === 'docx' ? 'UNIQUE_DOCX_CONTENT_4829' : kind === 'pdf' ? 'Pulse PDF fixture text' : 'Revenue')
    const saved = JSON.parse(await readFile(join(root, 'data', 'conversations', conversation.id, 'runs', run.id, 'input.json'), 'utf8'))
    expect(saved.attachments[0].data).toBeUndefined(); expect(saved.attachments[0].id).toBe('uploaded-fixture')
  } finally { await host.close() }
})

it('preserves explicit skills and their pre-implementation gate in the saved effective goal', async () => {
  const { createBuiltinSkillCapabilityPack } = await import('../packages/server/src/builtin-skills.js')
  const root = await mkdtemp(join(tmpdir(), 'pulse-attachment-skills-')); roots.push(root)
  const host = createLocalHost({ cwd: root, dataDir: join(root, 'data'), taskController: true, capabilityPacks: [createBuiltinSkillCapabilityPack()], enabledCapabilityPacks: ['builtin-skills'] })
  try {
    const conversation = await host.createConversation()
    const run = await host.sendMessage(conversation.id, { text: '先生成计划，确认后实现', skills: ['grill-and-plan'], mentionedFiles: ['requirements.txt'] }); await run.outcome()
    const saved = JSON.parse(await readFile(join(root, 'data', 'conversations', conversation.id, 'runs', run.id, 'input.json'), 'utf8'))
    expect(saved.goal).toContain('/grill-and-plan'); expect(saved.taskController).toBe(false)
    expect(saved.skills).toEqual(['grill-and-plan']); expect(saved.mentionedFiles).toEqual(['requirements.txt'])
  } finally { await host.close() }
})
it('reports missing vision support through a readable tool failure without sending image bytes to a text model', async () => {
  const f = await fixture()
  try {
    const image = await f.attach('photo.png', Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64'), 'image/png')
    const registry = new ToolRegistry({ workspaceRoots: [f.root] }); registry.register(f.store.tool(false))
    await expect(registry.execute('attachment.read', { id: image.id }, new AbortController().signal)).rejects.toMatchObject({ code: expect.stringContaining('VISION_MODEL_UNAVAILABLE') })
    expect(await f.store.metadata(image.id)).toMatchObject({ id: image.id })
  } finally { await f.host.close() }
})
it('limits count, file bytes, request size and preserves PDF content across partial-page windows', async () => {
  const f = await fixture()
  try {
    await expect(f.store.save(Array.from({ length: 11 }, () => ({})))).rejects.toMatchObject({ code: 'TOO_MANY_ATTACHMENTS' })
    await expect(f.store.save([{ id: 'large', name: 'large.txt', mediaType: 'text/plain', size: 21 * 1024 * 1024, type: 'file', data: Buffer.alloc(21 * 1024 * 1024).toString('base64') }])).rejects.toMatchObject({ code: 'ATTACHMENT_TOO_LARGE' })
    await expect(f.store.save([{ data: 'x'.repeat(35 * 1024 * 1024) }])).rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE' })
    const pdf = await f.attach('sample.pdf', await readFile('tests/fixtures/document-tools.pdf'), 'application/pdf')
    const full = await f.read({ id: pdf.id }), windows: string[] = []
    let offset = 0
    for (let n = 0; n < 30; n++) {
      const page = await f.read({ id: pdf.id, startPage: 1, endPage: 1, offset, maxChars: 8 }); windows.push(page.text)
      if (page.nextPage === null) break
      expect(page.nextOffset).toBeGreaterThan(offset); offset = page.nextOffset
    }
    expect(windows.join('')).toBe(full.text)
  } finally { await f.host.close() }
})

it('restores an approval-paused run with its original attachment and project-file references', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pulse-upload-restore-')); roots.push(root)
  await writeFile(join(root, '参考.txt'), 'PROJECT_REFERENCE_AFTER_RESTORE')
  const options = { cwd: root, dataDir: join(root, 'data'), taskController: false, mockToolCalls: [{ name: 'attachment.read', input: { id: 'resume-upload' } }, { name: 'fs.write', input: { path: 'summary.txt', content: 'approved summary' } }], mockAfterToolResponse: 'restored attachment read' }
  let host = createLocalHost(options)
  try {
    const conversation = await host.createConversation()
    const first = await host.sendMessage(conversation.id, { text: '读取上传附件并保存摘要，先审批', mentionedFiles: ['参考.txt'], attachments: [{ id: 'resume-upload', name: 'resume.txt', mediaType: 'text/plain', type: 'file', size: 16, data: Buffer.from('ORIGINAL_UPLOAD_ON_RESTORE').toString('base64') }] })
    for await (const event of first.events) { if (event.type === 'waiting') break }
    const active = (host as unknown as { active: Map<string, { runtime: { cancelAgent: () => void } }> }).active.get(first.id)!
    active.runtime.cancelAgent = () => {} // Preserve the waiting snapshot, simulating process loss rather than a user cancellation.
    await host.close(); host = createLocalHost(options)
    const resumed = await host.resumeRun(conversation.id)
    for await (const event of resumed.events) if (event.type === 'waiting') await resumed.reply((event.data as { effectId: string }).effectId, { approved: true })
    expect(await resumed.outcome()).toMatchObject({ status: 'succeeded' })
    expect(await readFile(join(root, 'summary.txt'), 'utf8')).toBe('approved summary')
    const snapshot = await readFile(join(root, 'data', 'conversations', conversation.id, 'runs', first.id, 'runtime.json'), 'utf8')
    expect(snapshot).toContain('ORIGINAL_UPLOAD_ON_RESTORE'); expect(snapshot).toContain('PROJECT_REFERENCE_AFTER_RESTORE')
  } finally { await host.close() }
})

it('bounds large historical indexes, prioritizes requested filenames and provides paginated discovery', async () => {
  const f = await fixture()
  try {
    const items = Array.from({ length: 60 }, (_, i) => ({ id: `history-${i}`, name: `${i}-${'中文长文件名'.repeat(25)}.cs`, type: 'file', mediaType: 'text/plain', size: 3 }))
    await f.host.appendAssistantUserMessage(f.conversation.id, { id: 'history-reference', runId: 'history-run', text: '历史附件', attachments: items, createdAt: new Date().toISOString() })
    const index = await f.store.index(items[0]!.name)
    expect(Buffer.byteLength(index!)).toBeLessThan(6000)
    expect(index).toContain(items[0]!.id)
    expect(() => JSON.parse(index!.slice(index!.indexOf('\n') + 1))).not.toThrow()
    const registry = new ToolRegistry({ workspaceRoots: [f.root] }); registry.register(f.store.listTool())
    let offset = 0; const found: string[] = []
    for (let n = 0; n < 60; n++) {
      const page = await registry.execute('attachment.list', { offset }, new AbortController().signal) as { items: Array<{ id: string }>; nextOffset: number | null }
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(6000)
      found.push(...page.items.map(item => item.id))
      if (page.nextOffset === null) break
      expect(page.nextOffset).toBeGreaterThan(offset); offset = page.nextOffset
    }
    expect(new Set(found).size).toBe(60)
    const code = await f.attach('Example.cs', Buffer.from('class Example {}'))
    expect(await f.read({ id: code.id })).toMatchObject({ text: 'class Example {}' })
  } finally { await f.host.close() }
})
