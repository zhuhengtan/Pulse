import { describe, expect, it } from 'vitest'
import { option, parse } from '../packages/cli/src/bin.js'

describe('parse inline option values that contain equals signs', () => {
  it('splits only on the first equals sign and keeps the rest of the value', () => {
    const parsed = parse(['run', '--task=key=value=tail'])
    expect(option(parsed.options, 'task')).toBe('key=value=tail')
    expect(parsed.options['task']).toBe('key=value=tail')
  })

  it('keeps adjacent and trailing equals signs in the value', () => {
    expect(option(parse(['--task=a==b']).options, 'task')).toBe('a==b')
    expect(option(parse(['--task===']).options, 'task')).toBe('==')
    expect(option(parse(['--task=a=b']).options, 'task')).toBe('a=b')
  })

  it('keeps an inline URL-shaped value with repeated equals signs', () => {
    const parsed = parse(['run', '--mock-response=token=a=b&sig=c=d'])
    expect(option(parsed.options, 'mock-response')).toBe('token=a=b&sig=c=d')
    expect(parsed.command).toBe('run')
  })

  it('yields an empty string for an inline option with an empty value', () => {
    const parsed = parse(['--cwd='])
    expect(parsed.options['cwd']).toBe('')
    expect(option(parsed.options, 'cwd')).toBe('')
  })

  it('keeps an empty-valued option distinct from an absent option', () => {
    const parsed = parse(['run', '--task='])
    expect(option(parsed.options, 'task')).toBe('')
    expect(option(parsed.options, 'config')).toBeUndefined()
  })

  it('reads a space-separated value verbatim, including equals signs', () => {
    const parsed = parse(['--cwd', 'a=b=c'])
    expect(option(parsed.options, 'cwd')).toBe('a=b=c')
  })

  it('does not consume a following flag as the value when a value is inline', () => {
    const parsed = parse(['--cwd=a=b', '--trust-workspace'])
    expect(option(parsed.options, 'cwd')).toBe('a=b')
    expect(parsed.options['trust-workspace']).toBe(true)
  })

  it('treats known boolean flags without equals as true', () => {
    const parsed = parse(['--help', '--force', '--no-color'])
    expect(parsed.options['help']).toBe(true)
    expect(parsed.options['force']).toBe(true)
    expect(parsed.options['no-color']).toBe(true)
    expect(option(parsed.options, 'help')).toBeUndefined()
  })

  it('treats an unknown dashless option without a following token as true', () => {
    expect(parse(['--jarvis-allow-remote']).options['jarvis-allow-remote']).toBe(true)
    expect(parse(['--unknown-flag']).options['unknown-flag']).toBe(true)
  })

  it('collects everything after a bare -- as positionals, untouched', () => {
    const parsed = parse(['run', '--', '--a=b', 'c=d', 'plain'])
    expect(parsed.command).toBe('run')
    expect(parsed.positionals).toEqual(['--a=b', 'c=d', 'plain'])
    expect(parsed.options['a']).toBeUndefined()
  })

  it('treats a leading -- as a forwarded separator, not an option', () => {
    const parsed = parse(['--', 'task'])
    expect(parsed.positionals).toEqual(['task'])
    expect(parsed.options['task']).toBeUndefined()
  })
})
