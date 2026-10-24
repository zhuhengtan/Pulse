import { expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createLocalHost, H5Server } from '../../packages/server/src/index.js'

function pdf() {
  const stream = 'BT /F1 24 Tf 40 100 Td (Pulse PDF Preview) Tj ET'
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`]
  let text = '%PDF-1.4\n'; const offsets = [0]
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(text)); text += `${index + 1} 0 obj\n${object}\nendobj\n` })
  const xref = Buffer.byteLength(text)
  text += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(value => String(value).padStart(10, '0') + ' 00000 n \n').join('')}trailer\n<< /Root 1 0 R /Size 6 >>\nstartxref\n${xref}\n%%EOF\n`
  return text
}

it.runIf(process.env.PULSE_PREVIEW_LIVE === '1')('previews artifacts in real H5 and Electron and retains the shared browser', async () => {
  const require = createRequire(new URL('../../packages/server/package.json', import.meta.url)), playwright = createRequire(require.resolve('@playwright/mcp'))('playwright')
  const root = await mkdtemp(join(tmpdir(), 'pulse-preview-live-')), workspace = join(root, 'workspace'), dataDir = join(root, 'data')
  await mkdir(workspace); await mkdir(join(workspace, 'site'))
  const files = ['plan.md', 'image.png', 'report.pdf', 'site/index.html']
  await writeFile(join(workspace, 'plan.md'), '# Preview acceptance\n\n- Markdown and code\n- Images and PDF\n')
  await writeFile(join(workspace, 'image.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64'))
  await writeFile(join(workspace, 'report.pdf'), pdf())
  await writeFile(join(workspace, 'site/index.html'), '<html><head><title>Static preview</title><link rel="stylesheet" href="/site/style.css"></head><body><h1>Static HTML preview</h1><output id="result"></output><script src="app.js"></script></body></html>')
  await writeFile(join(workspace, 'site/style.css'), 'body{background:rgb(230, 240, 250)}')
  await writeFile(join(workspace, 'site/app.js'), 'document.querySelector("output").textContent="Relative script loaded"')
  const host = createLocalHost({ cwd: workspace, dataDir, approvalMode: 'auto', allowNetwork: true, enabledCapabilityPacks: ['browser'], automation: { browser: { channel: 'chrome' } }, mockToolCalls: files.map(path => ({ name: 'artifact.record', input: { path } })), mockAfterToolResponse: 'Preview artifacts ready' })
  const server = new H5Server(host, { dataDir, host: '127.0.0.1', port: 0 })
  let browser: any, desktop: any
  const website = createServer((req, res) => {
    res.setHeader('X-Frame-Options', 'DENY'); res.setHeader('Content-Type', 'text/html; charset=utf-8')
    if (req.url === '/login') res.setHeader('Set-Cookie', 'preview_login=retained; HttpOnly; Path=/')
    res.end(`<title>Browser acceptance</title><h1>Browser use ready</h1><input aria-label="Message"><p>${req.headers.cookie?.includes('preview_login=retained') || req.url === '/login' ? 'Logged in' : 'Anonymous'}</p>`)
  })
  await new Promise<void>(resolve => website.listen(0, '127.0.0.1', resolve))
  try {
    const conversation = await host.createConversation({ title: 'Preview acceptance' })
    const run = await host.sendMessage(conversation.id, { text: 'Record the preview files' }); for await (const _ of run.events) { /* drain */ }
    expect(await host.listArtifacts(conversation.id)).toHaveLength(files.length)
    const info = await server.start(), base = `http://127.0.0.1:${info.port}`
    const work = await host.getConversation(conversation.id), projectId = work.summary.projectId
    browser = await playwright.chromium.launch({ channel: 'chrome', headless: true })
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } }), page = await context.newPage(), errors: string[] = []
    page.on('response', async (response: any) => { if (response.url().includes('/api/automation/') && response.status() >= 400) console.log('Automation response', response.status(), await response.text()) })
    page.on('pageerror', (error: Error) => errors.push(error.message))
    const path = (file: string) => `/work/${conversation.id}?workspace=preview&artifact=${encodeURIComponent(file)}&artifactRun=${run.id}`
    await page.goto(`${base}/work/${conversation.id}?workspace=preview`)
    await page.getByRole('heading', { name: '工具', exact: true }).waitFor()
    expect(await page.locator('.workspace-window .workbench-header, .workspace-window .workbench-tabs, .workspace-window details').count()).toBe(0)
    const geometry = await page.evaluate(() => { const pane = document.querySelector('.workspace-window')!.getBoundingClientRect(), chat = document.querySelector('.chat')!.getBoundingClientRect(); return { top: pane.top, bottom: pane.bottom, left: pane.left, chatRight: chat.right, height: innerHeight } })
    expect(geometry.top).toBe(0); expect(geometry.bottom).toBe(geometry.height); expect(geometry.left).toBeGreaterThanOrEqual(geometry.chatRight - 1)
    expect(await page.getByRole('button', { name: '展开', exact: true }).count()).toBe(0)
    await page.screenshot({ path: join(tmpdir(), 'pulse-workspace-start.png') })
    await page.goto(base + path('plan.md'))
    await page.getByRole('heading', { name: 'Preview acceptance' }).waitFor()
    await page.screenshot({ path: join(tmpdir(), 'pulse-preview-markdown.png') })
    await page.goto(base + path('image.png')); await page.getByAltText('image.png', { exact: true }).waitFor()
    await expect.poll(() => page.getByAltText('image.png', { exact: true }).evaluate((node: HTMLImageElement) => node.naturalWidth)).toBe(1)
    await page.getByRole('button', { name: '放大', exact: true }).click()
    await page.goto(base + path('report.pdf'))
    await expect.poll(() => page.locator('.pdf-preview canvas[data-rendered="1"]').evaluateAll((nodes: HTMLCanvasElement[]) => nodes[0]?.width ?? 0)).toBeGreaterThan(300)
    await page.screenshot({ path: join(tmpdir(), 'pulse-preview-pdf.png') })
    await page.goto(base + path('site/index.html'))
    await page.frameLocator('iframe[title="site/index.html"]').getByText('Relative script loaded').waitFor()
    expect(await page.frameLocator('iframe[title="site/index.html"]').locator('body').evaluate((body: HTMLElement) => getComputedStyle(body).backgroundColor)).toBe('rgb(230, 240, 250)')
    await page.setViewportSize({ width: 390, height: 844 }); await page.screenshot({ path: join(tmpdir(), 'pulse-preview-mobile.png') })
    expect(await page.locator('.workspace-window').evaluate((node: HTMLElement) => Math.round(node.getBoundingClientRect().width))).toBe(390)
    await page.setViewportSize({ width: 1440, height: 1000 })
    expect(await page.getByRole('button', { name: '打开浏览器', exact: true }).count()).toBe(0)
    expect(await page.getByRole('button', { name: '用浏览器打开', exact: true }).count()).toBe(0)
    expect(await page.locator('.automation-frame').count()).toBe(0)
    // Native browsing is verified in workspace-browser.test.ts; Web retains artifact previews.
    // Electron uses a separate user-data directory and the same isolated test service.
    const env = { ...process.env, PULSE_DESKTOP_USER_DATA: join(root, 'electron'), PULSE_DESKTOP_DATA_DIR: dataDir, PULSE_HOME: join(root, 'home') }; delete env.ELECTRON_RUN_AS_NODE
    const electronPath = createRequire(new URL('../../packages/desktop/package.json', import.meta.url))('electron')
    desktop = await playwright._electron.launch({ executablePath: electronPath, args: [fileURLToPath(new URL('../../packages/desktop', import.meta.url))], env, timeout: 20000 })
    const native = await desktop.firstWindow()
    native.on('pageerror', (error: Error) => errors.push(error.message))
    await native.waitForLoadState('domcontentloaded')
    await native.getByRole('button', { name: '设置', exact: true }).waitFor()
    for (const file of ['plan.md', 'report.pdf', 'site/index.html']) {
      await native.evaluate((url: string) => { history.pushState(null, '', url); dispatchEvent(new PopStateEvent('popstate')) }, path(file))
      if (file === 'plan.md') await native.getByRole('heading', { name: 'Preview acceptance' }).waitFor()
      else if (file === 'report.pdf') await expect.poll(() => native.locator('.pdf-preview canvas[data-rendered="1"]').evaluateAll((nodes: HTMLCanvasElement[]) => nodes[0]?.width ?? 0)).toBeGreaterThan(300)
      else await native.frameLocator('iframe[title="site/index.html"]').getByText('Relative script loaded').waitFor()
    }
    await native.screenshot({ path: join(tmpdir(), 'pulse-preview-desktop.png') })
    expect(errors).toEqual([])
    console.log(JSON.stringify({ standaloneWindow: true, singleTabStrip: true, webBrowserUseRemoved: true, h5: true, desktop: true, markdown: true, image: true, pdf: true, htmlResources: true,  screenshots: ['markdown', 'pdf', 'mobile', 'browser', 'desktop'].map(name => join(tmpdir(), `pulse-preview-${name}.png`)) }))
  } catch (error) {
    if (desktop) { const page = await desktop.firstWindow(); await page.screenshot({ path: join(tmpdir(), 'pulse-preview-desktop-failure.png') }); console.log('Desktop failure state', await page.locator('body').innerText()) }
    throw error
  } finally {
    await desktop?.close(); await browser?.close(); await server.stop(); await host.close(); await new Promise<void>(resolve => website.close(() => resolve())); await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 })
  }
}, 180_000)
