import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { changelogPaths, generatedPath, normalizeLineEndings, parseChangelog, renderHighlightsModule } from './changelog.mjs'

const repo = fileURLToPath(new URL('../../', import.meta.url))
const packageNames = ['data', 'runtime', 'tool-sdk', 'adapters', 'server', 'cli']
const manifests = await Promise.all(packageNames.map(async (name) => ({ name, data: JSON.parse(await readFile(join(repo, `packages/${name}/package.json`), 'utf8')) })))
const versions = new Set(manifests.map(({ data }) => data.version))
if (versions.size !== 1) throw new Error(`RELEASE_VERSION_MISMATCH:${[...versions].join(',')}`)
const version = [...versions][0]
const [chineseChangelog, englishChangelog] = await Promise.all([
  readFile(changelogPaths.zh, 'utf8'),
  readFile(changelogPaths.en, 'utf8'),
])
const changelogSections = parseChangelog(chineseChangelog, englishChangelog)
const currentNotes = changelogSections.get(version)
if (!currentNotes?.length) throw new Error(`RELEASE_CHANGELOG_MISSING:${version}`)
if (currentNotes.some(({ zh, en }) => !zh || !en)) throw new Error(`RELEASE_CHANGELOG_BILINGUAL_INCOMPLETE:${version}`)
const expectedGenerated = renderHighlightsModule(changelogSections)
const actualGenerated = normalizeLineEndings(await readFile(generatedPath, 'utf8').catch(() => ''))
if (actualGenerated !== expectedGenerated) throw new Error('RELEASE_CHANGELOG_GENERATED_STALE: run pnpm changelog:sync')
for (const { name, data } of manifests) {
  if (!data.publishConfig || data.publishConfig.access !== 'public') throw new Error(`RELEASE_PUBLIC_CONFIG_MISSING:${name}`)
  if (name !== 'cli' && !(await readFile(join(repo, `packages/${name}/dist/index.js`)).catch(() => undefined))) throw new Error(`RELEASE_BUILD_MISSING:${name}`)
  if (name === 'cli' && !(await readFile(join(repo, 'packages/cli/dist/bin.js')).catch(() => undefined))) throw new Error('RELEASE_BUILD_MISSING:cli')
}
for (const path of ['packages/web/dist/index.html', 'packages/server/dist/web/index.html']) {
  if (!(await readFile(join(repo, path), 'utf8').catch(() => undefined))) throw new Error(`RELEASE_WEB_ASSET_MISSING:${path}`)
}
if (process.platform === 'win32' || process.env.PULSE_VERIFY_WINDOWS_SANDBOX === '1') {
  const pin = JSON.parse(await readFile(join(repo, 'native/srt-win-patch/SOURCE.json'), 'utf8'))
  const native = join(repo, 'packages/adapters/dist/native')
  const metadata = JSON.parse(await readFile(join(native, 'srt-win.json'), 'utf8'))
  for (const key of ['commit', 'archiveSha256', 'patchCommit', 'patchSha256']) {
    if (metadata[key] !== pin[key]) throw new Error(`RELEASE_WINDOWS_SANDBOX_PROVENANCE_MISMATCH:${key}`)
  }
  if (createHash('sha256').update(await readFile(join(native, 'srt-win.exe'))).digest('hex') !== metadata.sha256) throw new Error('RELEASE_WINDOWS_SANDBOX_HASH_MISMATCH')
  console.log('Windows sandbox build provenance and binary integrity verified.')
}
console.log(`Release check passed for ${version} (${packageNames.length} packages; bilingual changelog verified).`)
