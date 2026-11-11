import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import type { AddressInfo } from 'node:net'
import { createServer as createHttpServer } from 'node:http'
import { afterAll, beforeAll, expect, it } from 'vitest'

const requireServer = createRequire(new URL('../../packages/server/package.json', import.meta.url))
const { chromium } = createRequire(requireServer.resolve('@playwright/mcp'))('playwright') as typeof import('playwright')
const requireWeb = createRequire(new URL('../../packages/web/package.json', import.meta.url))
let browser: Awaited<ReturnType<typeof chromium.launch>>
let server: import('vite').ViteDevServer
let listener: ReturnType<typeof createHttpServer>
let base: string

beforeAll(async () => {
  const { createServer } = await import(requireWeb.resolve('vite').replace(/index\.cjs$/, 'dist/node/index.js')) as typeof import('vite')
  server = await createServer({ root: fileURLToPath(new URL('../../packages/web', import.meta.url)), configFile: false, server: { middlewareMode: true, hmr: false } })
  listener = createHttpServer(server.middlewares)
  await new Promise<void>((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve) })
  base = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`
  browser = await chromium.launch({ headless: true })
}, 30_000)

afterAll(async () => {
  await browser?.close()
  await server?.close()
  if (listener?.listening) await new Promise<void>(resolve => listener.close(() => resolve()))
})

it.each([{ width: 1280, height: 900 }, { width: 390, height: 844 }])('keeps follow-ups, approval and timestamp layout stable at $width px', async viewport => {
  const page = await browser.newPage({ viewport })
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  try {
    await page.goto(base + '/tests/chat-redesign.html?state=approval&followups=1')
    const question = page.locator('article').filter({ hasText: '为啥又没完成' })
    const direction = page.locator('article').filter({ hasText: '把时间行也修了' })
    const approval = page.getByRole('button', { name: '允许本次' })
    await approval.waitFor()
    const nextText = (element: Element) => element.nextElementSibling?.textContent
    expect(await question.evaluate(nextText)).toContain('自动测试遇到权限限制')
    expect(await direction.evaluate(nextText)).toContain('等待应用')
    await page.getByRole('button', { name: '模拟应用方向' }).click()
    const applied = page.getByText('方向调整 · 已应用')
    await applied.waitFor()
    expect(await applied.count()).toBe(1)
    await page.reload()
    await applied.waitFor()
    await approval.waitFor()
    expect(await applied.count()).toBe(1)
    expect(await question.evaluate(nextText)).toContain('自动测试遇到权限限制')
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false)

    await page.goto(base + '/tests/chat-redesign.html?surface=chat')
    const message = page.locator('article.message--chat.user').filter({ hasText: '正在执行的原始任务' })
    await message.waitFor()
    const heights = (element: Element) => ({
      bubble: element.getBoundingClientRect().height,
      footer: element.querySelector('.message-footer')!.getBoundingClientRect().height,
      timestamp: getComputedStyle(element.querySelector('.message-time')!).visibility,
    })
    const before = await message.evaluate(heights)
    expect(before.footer).toBeGreaterThanOrEqual(24)
    expect(before.timestamp).toBe('hidden')
    await message.locator('.bubble').hover()
    const after = await message.evaluate(heights)
    expect(after.footer).toBeCloseTo(before.footer, 2)
    expect(after.bubble).toBeCloseTo(before.bubble, 2)
    expect(after.timestamp).toBe('visible')
    expect(errors).toEqual([])
    console.log(JSON.stringify({ viewport, measurements: { before, after } }))
  } finally {
    await page.close()
  }
}, 30_000)
