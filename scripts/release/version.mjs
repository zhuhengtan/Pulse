import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseChangelog, changelogPaths, syncCliHighlights } from './changelog.mjs'

const version = process.argv[2]?.replace(/^v/, '')
if (!version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error('Usage: pnpm release:version <semver>')
const repo = fileURLToPath(new URL('../../', import.meta.url))
const changelogVersions = parseChangelog(
  await readFile(changelogPaths.zh, 'utf8'),
  await readFile(changelogPaths.en, 'utf8'),
)
if (!changelogVersions.get(version)?.length) throw new Error(`RELEASE_CHANGELOG_MISSING:${version}; add bilingual notes to CHANGELOG.md first`)
await syncCliHighlights()
for (const name of ['runtime', 'tool-sdk', 'adapters', 'server', 'cli']) {
  const path = join(repo, `packages/${name}/package.json`)
  const data = JSON.parse(await readFile(path, 'utf8')); data.version = version
  await writeFile(path, `${JSON.stringify(data, null, 2)}\n`)
}
console.log(`Updated workspace package versions to ${version}. Commit them and create tag v${version}.`)
