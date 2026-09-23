import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isSameModulePath } from '../packages/cli/src/utils/is-main-module.js'

describe('CLI entrypoint path detection', () => {
  it('matches equivalent Windows paths despite drive and directory casing', () => {
    expect(isSameModulePath(
      'C:\\Users\\Alice\\AppData\\Local\\npm-cache\\_npx\\pulse-cli\\dist\\bin.js',
      'c:/users/alice/appdata/local/npm-cache/_npx/pulse-cli/dist/bin.js',
      'win32',
    )).toBe(true)
  })

  it('does not treat a different Windows entrypoint as the main module', () => {
    expect(isSameModulePath(
      'C:\\Users\\Alice\\node_modules\\other\\dist\\bin.js',
      'C:\\Users\\Alice\\node_modules\\pulse\\dist\\bin.js',
      'win32',
    )).toBe(false)
  })

  it('keeps POSIX path comparisons case-sensitive', () => {
    expect(isSameModulePath('/tmp/pulse/bin.js', '/tmp/pulse/Bin.js', 'linux')).toBe(false)
  })

  it.skipIf(process.platform === 'win32')('matches a package-manager symlink to its real module file', () => {
    const directory = mkdtempSync(join(tmpdir(), 'pulse-entrypoint-'))
    try {
      const realModule = join(directory, 'packages/pulse/dist/bin.js')
      const argvPath = join(directory, 'node_modules/@hunterzhu/pulse-cli/dist/bin.js')
      mkdirSync(join(directory, 'packages/pulse/dist'), { recursive: true })
      mkdirSync(join(directory, 'node_modules/@hunterzhu'), { recursive: true })
      writeFileSync(realModule, 'export {}')
      symlinkSync(join(directory, 'packages/pulse'), join(directory, 'node_modules/@hunterzhu/pulse-cli'), 'dir')

      expect(isSameModulePath(argvPath, realModule)).toBe(true)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
