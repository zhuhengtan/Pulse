import type { LocalHost, RunHandle } from '@hunterzhu/pulse-server'

export function bindRunSignals(host: LocalHost, getRun: () => RunHandle | undefined): () => void {
  let interrupted = false
  const onSignal = (): void => {
    const run = getRun()
    if (interrupted || !run) {
      void host.close().finally(() => {
        process.exit(130)
      })
      return
    }
    interrupted = true
    void run.cancel('USER_INTERRUPT')
  }
  process.on('SIGINT', onSignal)
  process.on('SIGTERM', onSignal)
  return () => {
    process.off('SIGINT', onSignal)
    process.off('SIGTERM', onSignal)
  }
}
