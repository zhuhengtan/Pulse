import { win32 } from 'node:path'
import { expect, it } from 'vitest'
import { readOnlySystemGitUsing, type SystemGitIO } from '../packages/server/src/system-git.js'

const lsFiles = ['ls-files', '--cached', '--others', '--exclude-standard', '-z'] as const

function windowsFiles(entries: Record<string, string>): SystemGitIO['realpath'] {
  const known = new Map(Object.entries(entries).map(([key, value]) => [win32.normalize(key).replace(/[\\/]+$/, '').toLowerCase(), value]))
  return async path => known.get(win32.normalize(path).replace(/[\\/]+$/, '').toLowerCase())
}

function recorder(stdoutFor: (args: readonly string[]) => string) {
  const calls: { file: string; args: readonly string[]; env: NodeJS.ProcessEnv }[] = []
  const exec: SystemGitIO['exec'] = async (file, args, options) => {
    calls.push({ file, args, env: options.env })
    return { stdout: stdoutFor(args) }
  }
  return { calls, exec }
}

function windowsIO(pathValue: string, files: Record<string, string>, exec: SystemGitIO['exec'], extra: Partial<SystemGitIO> = {}): SystemGitIO {
  return { platform: 'win32', pathValue, realpath: windowsFiles(files), exec, ...extra }
}

const systemGit = 'C:\\Program Files\\Git\\cmd\\GIT.EXE'
const systemDir = 'C:\\Program Files\\Git\\cmd'

it('runs a known Windows Git.exe with helper suppression and the original read argv', async () => {
  const { calls, exec } = recorder(args => args.includes('config') ? 'filter.probe.clean\0' : 'keep.txt\0')
  const result = await readOnlySystemGitUsing(windowsIO('c:/program files/git/cmd', {
    [systemDir]: systemDir,
    [systemGit]: systemGit,
  }, exec), 'D:\\repo', lsFiles, { timeout: 5000, maxBuffer: 1_000_000 })
  expect(result.stdout).toBe('keep.txt\0')
  expect(calls.map(call => call.file)).toEqual([systemGit, systemGit])
  expect(calls[0]?.args).toEqual(['--no-pager', '-c', 'core.fsmonitor=', '-c', 'core.hooksPath=NUL', '-c', 'core.pager=cat', 'config', '--includes', '--list', '--name-only', '-z'])
  expect(calls[1]?.args).toEqual(['--no-pager', '-c', 'core.fsmonitor=', '-c', 'core.hooksPath=NUL', '-c', 'core.pager=cat', '-c', 'diff.external=', '-c', 'diff.trustExitCode=false', '-c', 'filter.probe.clean=', ...lsFiles])
  expect(calls[1]?.env).toEqual({ PATH: 'c:/program files/git/cmd', GIT_CONFIG_GLOBAL: 'NUL', GIT_CONFIG_NOSYSTEM: '1', GIT_OPTIONAL_LOCKS: '0' })
})

it('accepts the other known Git for Windows executable directories', async () => {
  for (const directory of ['C:\\Program Files\\Git\\bin', 'C:\\Program Files\\Git\\mingw64\\bin', 'C:\\Program Files (x86)\\Git\\mingw32\\bin']) {
    const executable = win32.join(directory, 'git.exe')
    const { calls, exec } = recorder(() => '')
    await readOnlySystemGitUsing(windowsIO(directory, { [directory]: directory, [executable]: executable }, exec), 'D:\\repo', ['rev-parse', '--show-toplevel'], { timeout: 5000 })
    expect(calls.map(call => call.file)).toEqual([executable, executable])
  }
})

it('trusts Git.exe on the SystemRoot drive and rejects a lookalike Windows directory', async () => {
  const directory = 'D:\\Program Files\\Git\\cmd'
  const executable = win32.join(directory, 'git.exe')
  const files = { [directory]: directory, [executable]: executable }
  const { calls, exec } = recorder(() => '')
  await readOnlySystemGitUsing(windowsIO(directory, files, exec, { systemRoot: 'D:\\Windows' }), 'D:\\repo', lsFiles, { timeout: 5000 })
  expect(calls.map(call => call.file)).toEqual([executable, executable])
  const rejected = recorder(() => '')
  await expect(readOnlySystemGitUsing(windowsIO(directory, files, rejected.exec, { systemRoot: 'D:\\Users\\Windows' }), 'D:\\repo', lsFiles, { timeout: 5000 })).rejects.toMatchObject({ code: 'ENOENT' })
  expect(rejected.calls).toEqual([])
})

it.each([
  ['workspace shadow before the system git', 'D:\\repo;C:\\Program Files\\Git\\cmd', { 'D:\\repo\\git.exe': 'D:\\repo\\git.exe', [systemDir]: systemDir, [systemGit]: systemGit }],
  ['user-writable Git.exe', 'C:\\Users\\me\\AppData\\Local\\Programs\\Git\\cmd', { 'C:\\Users\\me\\AppData\\Local\\Programs\\Git\\cmd': 'C:\\Users\\me\\AppData\\Local\\Programs\\Git\\cmd', 'C:\\Users\\me\\AppData\\Local\\Programs\\Git\\cmd\\git.exe': 'C:\\Users\\me\\AppData\\Local\\Programs\\Git\\cmd\\git.exe' }],
  ['another program under Program Files', 'C:\\Program Files\\NotGit', { 'C:\\Program Files\\NotGit': 'C:\\Program Files\\NotGit', 'C:\\Program Files\\NotGit\\git.exe': 'C:\\Program Files\\NotGit\\git.exe' }],
  ['empty PATH entry resolves the workspace first', ';C:\\Program Files\\Git\\cmd', { 'D:\\repo\\git.exe': 'D:\\repo\\git.exe', [systemDir]: systemDir, [systemGit]: systemGit }],
])('does not execute %s', async (_label, pathValue, files) => {
  const { calls, exec } = recorder(() => 'should-not-run')
  await expect(readOnlySystemGitUsing(windowsIO(pathValue, files, exec), 'D:\\repo', lsFiles, { timeout: 5000 })).rejects.toMatchObject({ code: 'ENOENT' })
  expect(calls).toEqual([])
})

it('stops at a PATHEXT predecessor instead of skipping it for git.exe', async () => {
  const directory = systemDir
  const { calls, exec } = recorder(() => 'should-not-run')
  await expect(readOnlySystemGitUsing(windowsIO(directory, {
    [directory]: directory,
    [win32.join(directory, 'git.cmd')]: win32.join(directory, 'git.cmd'),
    [systemGit]: systemGit,
  }, exec, { pathext: '.CMD;.EXE' }), 'D:\\repo', lsFiles, { timeout: 5000 })).rejects.toMatchObject({ code: 'ENOENT' })
  expect(calls).toEqual([])
})

it('does not execute an argv outside the fixed reads', async () => {
  const { calls, exec } = recorder(() => '')
  await expect(readOnlySystemGitUsing(windowsIO(systemDir, { [systemDir]: systemDir, [systemGit]: systemGit }, exec), 'D:\\repo', ['status', '--short'], { timeout: 5000 })).rejects.toMatchObject({ code: 'ENOENT' })
  expect(calls).toEqual([])
})

it.each(['linux', 'darwin'] as const)('keeps the %s system git path and still rejects the first PATH shadow', async platform => {
  const identity = async (path: string) => path === '/usr/bin' || path === '/usr/bin/git' ? path : undefined
  const trusted = recorder(args => args.includes('config') ? '' : 'tracked\0')
  const result = await readOnlySystemGitUsing({ platform, pathValue: '/usr/bin', realpath: identity, exec: trusted.exec }, '/work', lsFiles, { timeout: 5000 })
  expect(result.stdout).toBe('tracked\0')
  expect(trusted.calls.map(call => call.file)).toEqual(['/usr/bin/git', '/usr/bin/git'])
  expect(trusted.calls[1]?.args).toContain('core.hooksPath=/dev/null')
  expect(trusted.calls[1]?.env.GIT_CONFIG_GLOBAL).toBe('/dev/null')
  const shadow = recorder(() => 'should-not-run')
  const shadowed = async (path: string) => path === '/tmp/shadow/git' ? '/tmp/shadow/git' : identity(path)
  await expect(readOnlySystemGitUsing({ platform, pathValue: '/tmp/shadow:/usr/bin', realpath: shadowed, exec: shadow.exec }, '/work', lsFiles, { timeout: 5000 })).rejects.toMatchObject({ code: 'ENOENT' })
  expect(shadow.calls).toEqual([])
})

it('does not execute a PATH git whose canonical target is another program in a trusted directory', async () => {
  const unix = recorder(() => 'should-not-run')
  const unixPath = async (path: string) => path === '/tmp/shadow/git' || path === '/usr/bin/true' ? '/usr/bin/true' : path === '/usr/bin' || path === '/usr/bin/git' ? path : undefined
  await expect(readOnlySystemGitUsing({ platform: 'linux', pathValue: '/tmp/shadow:/usr/bin', realpath: unixPath, exec: unix.exec }, '/work', lsFiles, { timeout: 5000 })).rejects.toMatchObject({ code: 'ENOENT' })
  expect(unix.calls).toEqual([])
  const windows = recorder(() => 'should-not-run')
  const alias = 'C:\\shadow\\git.exe'
  const target = 'C:\\Windows\\System32\\cmd.exe'
  await expect(readOnlySystemGitUsing(windowsIO('C:\\shadow;C:\\Program Files\\Git\\cmd', {
    [alias]: target,
    [target]: target,
    'C:\\Windows\\System32': 'C:\\Windows\\System32',
    [systemDir]: systemDir,
    [systemGit]: systemGit,
  }, windows.exec), 'D:\\repo', lsFiles, { timeout: 5000 })).rejects.toMatchObject({ code: 'ENOENT' })
  expect(windows.calls).toEqual([])
})
