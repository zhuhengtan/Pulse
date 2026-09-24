import type { SearchMatch, SearchTruncationReason, WorkspaceSearchResult } from './security.js'

/**
 * Maximum number of matches kept in the bounded tool output summary. The
 * underlying search may return more (up to SEARCH_MAX_RESULTS); anything
 * beyond this cap is dropped when the result is summarized for the caller.
 */
export const SEARCH_SUMMARY_MAX_MATCHES = 20

/**
 * Bounded summary of a workspace search result.
 *
 * `truncated`/`reason` describe ONLY the search itself: whether the search
 * stopped early at a depth, visit, or result limit. They never describe this
 * summary's own cap. When the search finished normally (`truncated: false`,
 * `reason: null`) yet `omitted > 0`, the omitted matches were dropped by the
 * summary cap, not by a search limit — callers can tell the two apart by
 * comparing `omitted` against `truncated`.
 */
export type SearchSummary = {
  matches: SearchMatch[]
  truncated: boolean
  reason: SearchTruncationReason | null
  visited: number
  matched: number
  /** Number of matches included in `matches`. */
  shown: number
  /** Number of matched results dropped by the summary cap. */
  omitted: number
}

/**
 * Summarize a workspace search result, keeping at most
 * {@link SEARCH_SUMMARY_MAX_MATCHES} matches while preserving the search's own
 * truncation and progress statistics and exposing how many matches were
 * dropped by this summary.
 */
export function summarizeSearchResult(result: WorkspaceSearchResult): SearchSummary {
  const matches = result.matches.slice(0, SEARCH_SUMMARY_MAX_MATCHES)
  return {
    matches,
    truncated: result.truncated,
    reason: result.reason,
    visited: result.visited,
    matched: result.matched,
    shown: matches.length,
    omitted: result.matches.length - matches.length,
  }
}
