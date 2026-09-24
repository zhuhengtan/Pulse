import { describe, expect, it } from 'vitest'
import type { SearchMatch, WorkspaceSearchResult } from '../packages/server/src/security.js'
import {
  SEARCH_SUMMARY_MAX_MATCHES,
  summarizeSearchResult,
} from '../packages/server/src/search-summary.js'

function makeMatches(count: number): SearchMatch[] {
  return Array.from({ length: count }, (_, index) => ({
    path: `file-${index}.txt`,
    line: index + 1,
    text: `match ${index}`,
  }))
}

function makeResult(
  matches: SearchMatch[],
  overrides: Partial<WorkspaceSearchResult> = {},
): WorkspaceSearchResult {
  return {
    matches,
    truncated: false,
    reason: null,
    visited: matches.length,
    matched: matches.length,
    ...overrides,
  }
}

describe('summarizeSearchResult', () => {
  it('reports zero shown/omitted when the search found nothing', () => {
    const summary = summarizeSearchResult(makeResult([]))
    expect(summary.matches).toEqual([])
    expect(summary.shown).toBe(0)
    expect(summary.omitted).toBe(0)
    expect(summary.truncated).toBe(false)
    expect(summary.reason).toBeNull()
  })

  it(`keeps every match when there are exactly ${SEARCH_SUMMARY_MAX_MATCHES}`, () => {
    const matches = makeMatches(SEARCH_SUMMARY_MAX_MATCHES)
    const summary = summarizeSearchResult(makeResult(matches))
    expect(summary.matches).toEqual(matches)
    expect(summary.shown).toBe(SEARCH_SUMMARY_MAX_MATCHES)
    expect(summary.omitted).toBe(0)
    expect(summary.truncated).toBe(false)
    expect(summary.reason).toBeNull()
  })

  it('caps matches and flags a summary omission without faking a search truncation', () => {
    const total = SEARCH_SUMMARY_MAX_MATCHES + 5
    const matches = makeMatches(total)
    const summary = summarizeSearchResult(makeResult(matches, { visited: 999, matched: total }))
    expect(summary.matches).toHaveLength(SEARCH_SUMMARY_MAX_MATCHES)
    expect(summary.shown).toBe(SEARCH_SUMMARY_MAX_MATCHES)
    expect(summary.omitted).toBe(total - SEARCH_SUMMARY_MAX_MATCHES)
    // The dropped matches come from the summary cap, not from the search itself.
    expect(summary.truncated).toBe(false)
    expect(summary.reason).toBeNull()
    expect(summary.visited).toBe(999)
    expect(summary.matched).toBe(total)
  })

  it('preserves a genuine search truncation and its reason', () => {
    const matches = makeMatches(3)
    const summary = summarizeSearchResult(
      makeResult(matches, { truncated: true, reason: 'depth', visited: 42, matched: 3 }),
    )
    expect(summary.matches).toEqual(matches)
    expect(summary.shown).toBe(3)
    expect(summary.omitted).toBe(0)
    expect(summary.truncated).toBe(true)
    expect(summary.reason).toBe('depth')
    expect(summary.visited).toBe(42)
  })

  it('keeps summary omission distinguishable from search truncation when both occur', () => {
    const total = SEARCH_SUMMARY_MAX_MATCHES + 3
    const matches = makeMatches(total)
    const summary = summarizeSearchResult(
      makeResult(matches, { truncated: true, reason: 'results', visited: 500, matched: total }),
    )
    expect(summary.shown).toBe(SEARCH_SUMMARY_MAX_MATCHES)
    expect(summary.omitted).toBe(total - SEARCH_SUMMARY_MAX_MATCHES)
    expect(summary.truncated).toBe(true)
    expect(summary.reason).toBe('results')
  })
})
