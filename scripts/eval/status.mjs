export function evaluationStatus(captured, result) {
  if (captured.timedOut) return 'timeout'
  return captured.code === 0 && result?.status === 'succeeded' && result?.taskOutcome?.status === 'accepted' ? 'succeeded' : 'failed'
}
