import { humanRunPresentation } from '@hunterzhu/pulse-server/run-presentation'

export interface HumanRunOutcome {
  status: 'succeeded' | 'failed' | 'cancelled'
  text?: string | undefined
  error?: { code?: string | undefined; message?: string | undefined } | undefined
}

/** Exit status kept for scripts. It is not the human-readable task label. */
export function cliRunExitCode(status: HumanRunOutcome['status'], taskOutcome: { status?: string } | null | undefined): number {
  if (status === 'cancelled') return 3
  return status === 'succeeded' && (!taskOutcome || taskOutcome.status === 'accepted') ? 0 : 1
}

/** Every non-JSON human branch prints the shared presentation, including streamed, text, and error exits. */
export function writeHumanRunResult(write: { stdout: (text: string) => void; stderr: (text: string) => void }, input: { streamedText: boolean; outcome: HumanRunOutcome; taskOutcome: { status?: string } | null | undefined }): void {
  const code = input.outcome.error?.code
  const label = humanRunPresentation(typeof code === 'string' ? { status: input.outcome.status, error: { code } } : { status: input.outcome.status }, input.taskOutcome).label
  if (input.outcome.status === 'failed' && input.outcome.error) write.stderr(`\n[错误] ${input.outcome.error.code}: ${input.outcome.error.message}\n`)
  else if (!input.streamedText && input.outcome.text) write.stdout(`${input.outcome.text}\n`)
  write.stdout(`\n[${label}]\n`)
}
