/** Whole-Host fixture envelopes; model calls and review allowances are unchanged. */
export function sourceClaimHostTimeout(platform: NodeJS.Platform, mode: 'current' | 'external' | 'paged') {
  if (mode !== 'external') return 30_000
  // External invalidation deliberately retains the full bounded recovery chain.
  // Preserve the existing Windows Host default rather than capping it at 30s.
  // Hosted Mac reached the last replan at 44.6s before its final calls.
  // Allow the bounded 40-call Host graph and persistence to finish under load.
  return platform === 'win32' ? undefined : 90_000
}
