import { testAdditionsRequested } from '../check-receipt.js'

/** A supplemental suite does not replace an explicitly requested test file. */
export function namedTestExtensions(description: string): string[] {
  if (!testAdditionsRequested(description)) return []
  const paths: string[] = []
  for (const match of description.matchAll(/[A-Za-z0-9_./-]+\.[cm]?[jt]sx?\b/g)) {
    const path = match[0].replace(/^\.\//, '')
    if (!/(?:^|\/)(?:tests?|__tests__)\/|\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path)) continue
    const before = description.slice(Math.max(0, match.index! - 80), match.index)
    const after = description.slice(match.index! + match[0].length, match.index! + match[0].length + 60)
    // An alternative explicitly granted by the caller remains an alternative.
    if (/^[^\n。]{0,40}(?:或者?|alternatively|\bor\b)[^\n。]{0,40}(?:候选|独立|单独|candidate|separate)/i.test(after)) continue
    if (/(?:补充|新增|添加|扩展|编写|完善|\b(?:add|extend|write)\b)[^\n，,；;。]{0,60}$/i.test(before) || /^[^\n，,；;。]{0,40}(?:补充|新增|添加|扩展|编写|完善)(?:[^\n，,；;。]{0,20}测试)?/.test(after)) paths.push(path)
  }
  return [...new Set(paths)]
}

export function missingNamedTestExtensions(description: string, changedPaths: readonly string[]): string[] {
  const normalized = changedPaths.map(path => path.replaceAll('\\', '/').replace(/^\.\//, ''))
  return namedTestExtensions(description).filter(path => !normalized.some(changed => changed === path || changed.startsWith('/') && changed.endsWith('/' + path)))
}
