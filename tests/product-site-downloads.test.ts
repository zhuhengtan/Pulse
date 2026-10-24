import { expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { desktopAssets } from '../scripts/release/desktop-assets.mjs'

const { JSDOM } = createRequire(new URL('../packages/web/package.json', import.meta.url))('jsdom')
const releases = 'https://github.com/zhuhengtan/Pulse/releases'
const published = () => ({ version: '0.8.0', assets: desktopAssets.map(asset => ({ ...asset, size: 12345678, url: `${releases}/download/v0.8.0/${asset.name}` })) })

async function page(manifest: unknown) {
  const html = await readFile(new URL('../site/index.html', import.meta.url), 'utf8')
  const script = await readFile(new URL('../site/app.js', import.meta.url), 'utf8')
  const dom = new JSDOM(html, { url: 'https://zhuhengtan.github.io/Pulse/', runScripts: 'outside-only' })
  dom.window.fetch = async () => ({ ok: true, json: async () => manifest })
  dom.window.eval(script)
  await new Promise(resolve => setImmediate(resolve))
  return dom
}

it('renders every published desktop download using the actual platform-specific filename', async () => {
  const manifest = published(), dom = await page(manifest)
  try {
    expect(dom.window.document.querySelectorAll('[data-download]')).toHaveLength(4)
    expect(dom.window.document.querySelector('[data-download="macos-x64"]')).toBeNull()
    expect(dom.window.document.querySelector('#macos').textContent).toContain('Apple Silicon')
    for (const asset of manifest.assets) {
      const link = dom.window.document.querySelector(`[data-download="${asset.platform}"]`)
      expect(link.href).toBe(asset.url)
      expect(link.classList.contains('unavailable')).toBe(false)
    }
    expect(dom.window.document.querySelector('#release-status').textContent).toContain('v0.8.0')
  } finally { dom.window.close() }
})

it('keeps unavailable releases and mismatched platform installers out of download buttons', async () => {
  for (const manifest of [{ version: null, assets: [] }, published()]) {
    if (manifest.version) {
      const linux = manifest.assets.find(asset => asset.platform === 'linux-x64')!
      linux.name = 'pulse-windows-x64.exe'
      linux.url = `${releases}/download/v0.8.0/${linux.name}`
    }
    const dom = await page(manifest)
    try {
      const link = dom.window.document.querySelector('[data-download="linux-x64"]')
      expect(link.classList.contains('unavailable')).toBe(true)
      expect(link.href).toBe(releases)
    } finally { dom.window.close() }
  }
})
