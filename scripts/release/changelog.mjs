import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const repo = fileURLToPath(new URL('../../', import.meta.url))
export const changelogPaths = {
  zh: join(repo, 'CHANGELOG.md'),
  en: join(repo, 'CHANGELOG.en.md'),
}
export const generatedPath = join(repo, 'packages/cli/src/release-highlights.generated.ts')

export function normalizeLineEndings(source) {
  return source.replace(/\r\n/g, '\n')
}

function parseLocaleChangelog(source, locale) {
  const sections = new Map()
  const headings = [...source.matchAll(/^## \[([^\]]+)\].*$/gm)]

  for (let index = 0; index < headings.length; index++) {
    const key = headings[index][1]
    const start = headings[index].index + headings[index][0].length
    const end = headings[index + 1]?.index ?? source.length
    const body = source.slice(start, end)
    const entries = body.split(/\r?\n/)
      .filter((line) => line.startsWith('- '))
      .map((line, lineIndex) => {
        const text = line.slice(2).trim()
        if (!text) throw new Error(`CHANGELOG_EMPTY_ENTRY:${locale}:${key}:${lineIndex + 1}`)
        return text
      })
    if (sections.has(key)) throw new Error(`CHANGELOG_DUPLICATE_VERSION:${key}`)
    sections.set(key, entries)
  }

  return sections
}

export function parseChangelog(chineseSource, englishSource) {
  const chinese = parseLocaleChangelog(chineseSource, 'zh')
  const english = parseLocaleChangelog(englishSource, 'en')
  const keys = new Set([...chinese.keys(), ...english.keys()])
  const sections = new Map()

  for (const key of keys) {
    const zhEntries = chinese.get(key)
    const enEntries = english.get(key)
    if (!zhEntries || !enEntries) throw new Error(`CHANGELOG_LOCALE_VERSION_MISSING:${key}`)
    if (zhEntries.length !== enEntries.length) throw new Error(`CHANGELOG_LOCALE_ENTRY_COUNT_MISMATCH:${key}`)
    sections.set(key, zhEntries.map((zh, index) => ({ zh, en: enEntries[index] })))
  }

  return sections
}

export function renderHighlightsModule(sections) {
  const releases = [...sections]
    .filter(([version]) => version !== 'Unreleased')
    .map(([version, entries]) => [version, entries])
  const data = Object.fromEntries(releases)
  return `// Generated from CHANGELOG.md and CHANGELOG.en.md by scripts/release/sync-cli-highlights.mjs. Do not edit manually.\nexport const releaseHighlights: Record<string, Array<{ zh: string; en: string }>> = ${JSON.stringify(data, null, 2)}\n`
}

export async function syncCliHighlights() {
  const sections = parseChangelog(
    await readFile(changelogPaths.zh, 'utf8'),
    await readFile(changelogPaths.en, 'utf8'),
  )
  await writeFile(generatedPath, renderHighlightsModule(sections))
  return sections
}
