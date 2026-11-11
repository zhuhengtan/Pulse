/** Whole-fixture envelopes only; each Host keeps its existing model/tool budgets. */
export function evidenceFreshnessTimeouts(platform: NodeJS.Platform) {
  return {
    // Preserve the larger Windows default instead of lowering it to the POSIX cap.
    retainedPatch: platform === 'win32' ? undefined : 30_000,
    testAdditions: platform === 'win32' ? 720_000 : 45_000,
  }
}
