import { expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { desktopAssets, desktopDownloadManifest, requiredDesktopFiles } from '../scripts/release/desktop-assets.mjs'

it('matches actual Linux builder filenames and validates native package configuration', async () => {
  const desktopRequire = createRequire(new URL('../packages/desktop/package.json', import.meta.url))
  const builderRequire = createRequire(desktopRequire.resolve('electron-builder'))
  const { LinuxPackager } = builderRequire('app-builder-lib')
  const { Arch } = createRequire(builderRequire.resolve('app-builder-lib'))('builder-util')
  const { validateConfiguration } = builderRequire('app-builder-lib/out/util/config/config')
  const metadata = JSON.parse(readFileSync(new URL('../packages/desktop/package.json', import.meta.url), 'utf8'))
  await validateConfiguration(metadata.build)
  const packager = new LinuxPackager({ config: metadata.build, metadata, devMetadata: metadata })
  expect(packager.executableName).toMatch(/^[\w. -]+$/)
  const { default: FpmTarget } = builderRequire('app-builder-lib/out/targets/FpmTarget')
  const debMetadata = await FpmTarget.prototype.computeFpmMetaInfoOptions.call({ packager, options: { ...metadata.build.linux, ...metadata.build.deb } })
  expect(debMetadata.name).toMatch(/^[a-z0-9][a-z0-9+.-]+$/)
  expect(debMetadata.maintainer).toBeTruthy()
  expect(debMetadata.url).toBe('https://zhuhengtan.github.io/Pulse/')
  for (const ext of ['AppImage', 'deb']) {
    expect(requiredDesktopFiles).toContain(packager.expandArtifactNamePattern({}, ext, Arch.x64))
  }
})
const tag = 'v0.8.0', url = `https://github.com/zhuhengtan/Pulse/releases/tag/${tag}`
const release = () => ({ tag_name: tag, html_url: url, assets: [...desktopAssets.map(item => ({ name: item.name, state: 'uploaded', size: 123456, browser_download_url: `https://github.com/zhuhengtan/Pulse/releases/download/${tag}/${item.name}` })), { name: 'pulse-desktop-SHA256SUMS.txt', state: 'uploaded', size: 1024 }] })
it('publishes links only after every supported desktop platform and checksums are uploaded', () => {
  expect(desktopDownloadManifest(release()).assets).toHaveLength(4)
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
