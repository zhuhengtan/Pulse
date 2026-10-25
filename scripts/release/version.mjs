import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseChangelog, changelogPaths, syncCliHighlights } from './changelog.mjs'

const component = ['backend', 'frontend', 'shell'].includes(process.argv[2]) ? process.argv[2] : 'backend'
const version = process.argv[component === process.argv[2] ? 3 : 2]?.replace(/^v/, '')
if (!version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error('Usage: pnpm release:version [backend|frontend|shell] <semver>')
const repo = fileURLToPath(new URL('../../', import.meta.url))
const changelogVersions = parseChangelog(
  await readFile(changelogPaths.zh, 'utf8'),
  await readFile(changelogPaths.en, 'utf8'),
)
if (component === 'backend' && !changelogVersions.get(version)?.length) throw new Error(`RELEASE_CHANGELOG_MISSING:${version}; add bilingual notes to CHANGELOG.md first`)
if (component !== 'backend' && !await readFile(join(repo, 'docs/component-releases', component, version + '.md'), 'utf8').catch(() => '')) throw new Error(`RELEASE_NOTES_MISSING:docs/component-releases/${component}/${version}.md`)
await syncCliHighlights()
for (const name of component === 'shell' ? ['desktop'] : component === 'frontend' ? ['web'] : ['data', 'runtime', 'tool-sdk', 'adapters', 'server', 'cli']) {
  const path = join(repo, `packages/${name}/package.json`)
  const data = JSON.parse(await readFile(path, 'utf8')); data.version = version
  await writeFile(path, `${JSON.stringify(data, null, 2)}\n`)
}
console.log(`Updated ${component} to ${version}. Commit it and create tag ${component}-v${version}.`)
