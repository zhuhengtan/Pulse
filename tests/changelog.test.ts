import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { changelogPaths, generatedPath, parseChangelog, renderHighlightsModule } from '../scripts/release/changelog.mjs'

describe('release changelog', () => {
  it('provides bilingual highlights for the current CLI version from the changelog', async () => {
    const [chinese, english] = await Promise.all([
      readFile(changelogPaths.zh, 'utf8'),
      readFile(changelogPaths.en, 'utf8'),
    ])
    const sections = parseChangelog(chinese, english)
    const current = sections.get('0.4.0')

    expect(current).toEqual([{
      zh: '默认使用异步并行 event loop，让模型请求、工具调用等副作用并发推进。',
      en: 'Uses an asynchronous, parallel event loop by default so model requests, tool calls, and other effects can progress concurrently.',
    }])
    expect(await readFile(generatedPath, 'utf8')).toBe(renderHighlightsModule(sections))
  })

  it('rejects missing version entries and mismatched localized entry counts', () => {
    expect(() => parseChangelog('## [1.2.3]\n\n- 中文说明\n', '')).toThrow('CHANGELOG_LOCALE_VERSION_MISSING')
    expect(() => parseChangelog('## [1.2.3]\n\n- 中文说明\n', '## [1.2.3]\n')).toThrow('CHANGELOG_LOCALE_ENTRY_COUNT_MISMATCH')
  })
})
