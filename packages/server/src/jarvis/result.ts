import type { OutcomeStatus } from '@hunterzhu/pulse-runtime'
import type { TaskOutcome } from '../task.js'

/** Map a finished Pulse run onto a Jarvis close result. Unverified work is not success. */
export function jarvisResultForRun(outcomeStatus: OutcomeStatus, taskStatus: TaskOutcome['status'] | undefined): 'success' | 'failure' | 'partial' {
  switch (taskStatus) {
    case 'accepted':
      return 'success'
    case 'incomplete':
    case 'unverifiable':
      return 'partial'
    case 'failed':
    case 'cancelled':
      return 'failure'
    default:
      return outcomeStatus === 'succeeded' ? 'success' : 'failure'
  }
}
