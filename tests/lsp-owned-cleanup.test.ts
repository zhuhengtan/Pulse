import { EventEmitter } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'
import { LSP_HELPER_EXIT_GRACE_MS, releaseOwnedHelper, windowsSystemTaskkill, type OwnedHelper } from '../packages/server/src/lsp/index.js'

afterEach(() => { vi.useRealTimers() })

function withSystemRoot(root: string | undefined, run: () => void): void {
  const previous = process.env.SystemRoot
  const upper = process.env.SYSTEMROOT
  const path = process.env.PATH
  if (root === undefined) { delete process.env.SystemRoot; delete process.env.SYSTEMROOT } else { process.env.SystemRoot = root; process.env.SYSTEMROOT = root }
  try { run() } finally {
    if (previous === undefined) delete process.env.SystemRoot
    else process.env.SystemRoot = previous
    if (upper === undefined) delete process.env.SYSTEMROOT
    else process.env.SYSTEMROOT = upper
    if (path === undefined) delete process.env.PATH
    else process.env.PATH = path
  }
}

function helper(pid: number, exitCode: number | null = null): EventEmitter & OwnedHelper {
  const child = new EventEmitter() as EventEmitter & OwnedHelper
  child.pid = pid
  child.exitCode = exitCode
  child.signalCode = null
  child.stdin = { end: vi.fn() }
  child.kill = vi.fn(() => true)
  return child
}

it('ends stdin and taskkills only a still-live owned Windows helper after the grace period', () => {
  vi.useFakeTimers()
  const child = helper(42)
  const calls: Array<[string, string[]]> = []
  withSystemRoot('C:\\Windows', () => {
    process.env.PATH = 'C:\\untrusted\\project'
    releaseOwnedHelper(child, 42, 'win32', (file, args) => { calls.push([file, args]) })
    expect(child.stdin?.end).toHaveBeenCalledOnce()
    expect(child.kill).not.toHaveBeenCalled()
    vi.advanceTimersByTime(LSP_HELPER_EXIT_GRACE_MS - 1)
    expect(calls).toEqual([])
    vi.advanceTimersByTime(1)
  })
  expect(calls).toEqual([['C:\\Windows\\System32\\taskkill.exe', ['/PID', '42', '/T', '/F']]])
  expect(calls[0]?.[0]).not.toBe('taskkill.exe')
  expect(calls[0]?.[0].startsWith('C:\\untrusted')).toBe(false)
  expect(child.kill).not.toHaveBeenCalled()
})

it('does not resolve taskkill from the project when SystemRoot is missing, relative, or a UNC share', () => {
  expect(windowsSystemTaskkill('C:\\Windows')).toBe('C:\\Windows\\System32\\taskkill.exe')
  expect(windowsSystemTaskkill('Windows')).toBeUndefined()
  expect(windowsSystemTaskkill('C:\\Windows\\..\\project')).toBeUndefined()
  expect(windowsSystemTaskkill('\\\\files.example\\share')).toBeUndefined()
  vi.useFakeTimers()
  const child = helper(42)
  const calls: string[] = []
  withSystemRoot(undefined, () => {
    releaseOwnedHelper(child, 42, 'win32', () => { calls.push('bare') })
    vi.advanceTimersByTime(LSP_HELPER_EXIT_GRACE_MS)
  })
  expect(calls).toEqual([])
  expect(child.kill).toHaveBeenCalledWith('SIGTERM')
})

it('does not taskkill an owned helper that exits or no longer matches during the grace period', () => {
  vi.useFakeTimers()
  const exited = helper(42, 0)
  const calls: string[] = []
  releaseOwnedHelper(exited, 42, 'win32', () => { calls.push('kill') })
  vi.advanceTimersByTime(LSP_HELPER_EXIT_GRACE_MS + 50)
  expect(calls).toEqual([])
  expect(exited.kill).not.toHaveBeenCalled()

  const closing = helper(42)
  releaseOwnedHelper(closing, 42, 'win32', () => { calls.push('kill') })
  closing.emit('close')
  vi.advanceTimersByTime(LSP_HELPER_EXIT_GRACE_MS + 50)
  expect(calls).toEqual([])

  const recycled = helper(99)
  releaseOwnedHelper(recycled, 42, 'win32', () => { calls.push('kill') })
  vi.advanceTimersByTime(LSP_HELPER_EXIT_GRACE_MS + 50)
  expect(calls).toEqual([])
  expect(recycled.kill).not.toHaveBeenCalled()
  expect(recycled.stdin?.end).toHaveBeenCalledOnce()
})

it('falls back to SIGTERM only when the Windows tree kill fails and the same helper is still live', () => {
  vi.useFakeTimers()
  const child = helper(42)
  withSystemRoot('C:\\Windows', () => {
    releaseOwnedHelper(child, 42, 'win32', () => { throw new Error('taskkill failed') })
    vi.advanceTimersByTime(LSP_HELPER_EXIT_GRACE_MS)
  })
  expect(child.kill).toHaveBeenCalledWith('SIGTERM')

  const gone = helper(43)
  withSystemRoot('C:\\Windows', () => {
    releaseOwnedHelper(gone, 43, 'win32', () => { gone.exitCode = 0; throw new Error('taskkill failed') })
    vi.advanceTimersByTime(LSP_HELPER_EXIT_GRACE_MS)
  })
  expect(gone.kill).not.toHaveBeenCalled()
})

it('signals a non-Windows helper immediately and does not use taskkill', () => {
  const child = helper(42)
  const calls: string[] = []
  releaseOwnedHelper(child, 42, 'linux', () => { calls.push('taskkill') })
  expect(child.stdin?.end).toHaveBeenCalledOnce()
  expect(child.kill).toHaveBeenCalledWith('SIGTERM')
  expect(calls).toEqual([])
})
