import { describe, it, expect } from 'vitest'
import { providerNetworkError } from '../packages/adapters/src/providers/normalize.js'

describe('providerNetworkError', () => {
  it('retains safe DOM timeout/abort names while ignoring their numeric codes and messages', () => {
    for (const name of ['TimeoutError', 'AbortError']) {
      const error = providerNetworkError(new DOMException('https://user:secret@private/path', name))
      expect(error.message).toBe(`PROVIDER_NETWORK_ERROR (${name})`)
      expect(error.message).not.toContain('secret')
    }
  })
  it('appends nested whitelisted cause codes', () => {
    const cause = { code: 'UNKNOWN_A', cause: { code: 'ECONNREFUSED', cause: { code: 'ENOTFOUND' } } }
    const err = providerNetworkError(cause)
    expect(err.code).toBe('PROVIDER_NETWORK_ERROR')
    expect(err.retryable).toBe(true)
    expect(err.message).toContain('ENOTFOUND')
    expect(err.message).toContain('ECONNREFUSED')
    expect(err.message).not.toContain('UNKNOWN_A')
    expect(err.cause).toBe(cause)
  })

  it('does not leak unknown codes or sensitive messages', () => {
    const cause = { code: 'EACCES', message: 'http://user:pass@host/secret' }
    const err = providerNetworkError(cause)
    expect(err.message).toBe('PROVIDER_NETWORK_ERROR')
    expect(err.message).not.toContain('EACCES')
    expect(err.message).not.toContain('pass')
    expect(err.message).not.toContain('secret')
  })

  it('handles an empty cause', () => {
    const err = providerNetworkError(undefined)
    expect(err.message).toBe('PROVIDER_NETWORK_ERROR')
    expect(err.code).toBe('PROVIDER_NETWORK_ERROR')
    expect(err.retryable).toBe(true)
  })
})
