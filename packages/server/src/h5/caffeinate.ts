import { spawn, type ChildProcess } from 'node:child_process'

/**
 * Manages sleep inhibition on macOS during active tasks.
 * Uses `caffeinate -i -s` (prevent system idle sleep and display idle sleep).
 * Employs a reference count so multiple concurrent runs share a single caffeinate process.
 */
export class SleepInhibitor {
  private activeRuns = 0
  private process: ChildProcess | undefined = undefined

  acquire(): void {
    if (process.platform !== 'darwin') return
    this.activeRuns++
    if (this.activeRuns === 1 && !this.process) {
      try {
        this.process = spawn('caffeinate', ['-i', '-s'], {
          stdio: 'ignore',
          detached: false,
        })
        this.process.on('error', () => {
          this.process = undefined
        })
        this.process.on('exit', () => {
          this.process = undefined
        })
      } catch {
        this.process = undefined
      }
    }
  }

  release(): void {
    if (process.platform !== 'darwin') return
    this.activeRuns = Math.max(0, this.activeRuns - 1)
    if (this.activeRuns === 0 && this.process) {
      try {
        this.process.kill('SIGTERM')
      } catch {
        // Process might already be dead
      }
      this.process = undefined
    }
  }

  dispose(): void {
    this.activeRuns = 0
    if (this.process) {
      try {
        this.process.kill('SIGTERM')
      } catch {
        // ignore
      }
      this.process = undefined
    }
  }
}
