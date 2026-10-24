import { expect, it } from 'vitest'
import { desktopAssets, desktopDownloadManifest } from '../scripts/release/desktop-assets.mjs'
const tag = 'v0.8.0', url = `https://github.com/zhuhengtan/Pulse/releases/tag/${tag}`
const release = () => ({ tag_name: tag, html_url: url, assets: [...desktopAssets.map(item => ({ name: item.name, state: 'uploaded', size: 123456, browser_download_url: `https://github.com/zhuhengtan/Pulse/releases/download/${tag}/${item.name}` })), { name: 'pulse-desktop-SHA256SUMS.txt', state: 'uploaded', size: 1024 }] })
it('publishes links only after every supported desktop platform and checksums are uploaded', () => {
  expect(desktopDownloadManifest(release()).assets).toHaveLength(5)
  for (let index = 0; index < release().assets.length; index++) {
    const value = release(); value.assets.splice(index, 1)
    expect(desktopDownloadManifest(value).assets).toEqual([])
  }
})
it('keeps old CLI-only, draft and prerelease versions out of desktop downloads', () => {
  for (const value of [undefined, { tag_name: 'v0.7.0', assets: [] }, { ...release(), draft: true }, { ...release(), prerelease: true }]) expect(desktopDownloadManifest(value).version).toBeNull()
})
it('rejects misleading names, duplicate files, invalid sizes and URLs outside the exact release', () => {
  for (const change of [
    (v: ReturnType<typeof release>) => { v.assets[0]!.browser_download_url = 'https://example.com/download' },
    (v: ReturnType<typeof release>) => { v.assets[0]!.size = 0 },
    (v: ReturnType<typeof release>) => { v.assets.push(v.assets[0]!) },
    (v: ReturnType<typeof release>) => { v.html_url = 'https://github.com/other/repo/releases/tag/v0.8.0' },
  ]) { const value = release(); change(value); expect(desktopDownloadManifest(value).version).toBeNull() }
})
