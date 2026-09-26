import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { changelogPaths, generatedPath, normalizeLineEndings, parseChangelog, renderHighlightsModule } from './changelog.mjs'

const repo = fileURLToPath(new URL('../../', import.meta.url))
const packageNames = ['runtime', 'tool-sdk', 'adapters', 'server', 'cli']
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
console.log(`Release check passed for ${version} (${packageNames.length} packages; bilingual changelog verified).`)
