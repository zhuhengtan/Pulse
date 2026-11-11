import { afterEach, describe, expect, it, vi } from 'vitest'
import { X509Certificate } from 'node:crypto'
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hardwareTestTlsAvailable, temporaryHardwareTestTls } from './helpers/hardware-test-tls.js'

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => {
  vi.unstubAllEnvs()
  for (const close of cleanup.splice(0).reverse()) await close()
})

describe.skipIf(!hardwareTestTlsAvailable)('disposable hardware test PKI', () => {
  it('owns its certificate extensions independently of the ambient OpenSSL configuration', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pulse-openssl-config-test-'))
    cleanup.push(() => rm(directory, { recursive: true, force: true }))
    const config = join(directory, 'ambient.cnf')
    // OpenSSL 1.1.1 appends -addext to configured extensions, including duplicate
    // Basic Constraints. Other host defaults must not enter a test identity either.
    await writeFile(config, '[req]\ndistinguished_name=dn\nx509_extensions=host_defaults\n[dn]\n[host_defaults]\nbasicConstraints=critical,CA:TRUE\nsubjectAltName=DNS:ambient.example.invalid\nextendedKeyUsage=codeSigning\n')
    vi.stubEnv('OPENSSL_CONF', config)
    const pki = await temporaryHardwareTestTls()
    cleanup.push(() => pki.close())
    const ca = new X509Certificate(pki.server.ca)
    expect(ca.ca).toBe(true)
    expect(ca.checkIssued(ca)).toBe(true)
    expect(ca.verify(ca.publicKey)).toBe(true)
    expect(ca.subjectAltName).toBeUndefined()
    expect(ca.keyUsage).toBeUndefined()
    for (const [identity, usage] of [[pki.server, '1.3.6.1.5.5.7.3.1'], [pki.client, '1.3.6.1.5.5.7.3.2']] as const) {
      const certificate = new X509Certificate(identity.cert)
      expect(certificate.ca).toBe(false)
      expect(certificate.checkIssued(ca)).toBe(true)
      expect(certificate.verify(ca.publicKey)).toBe(true)
      expect(certificate.keyUsage).toEqual([usage])
      expect(Date.parse(certificate.validFrom)).toBeLessThanOrEqual(Date.now())
      expect(Date.parse(certificate.validTo)).toBeGreaterThan(Date.now())
    }
    const server = new X509Certificate(pki.server.cert)
    expect(server.checkHost('localhost')).toBe('localhost')
    expect(server.checkIP('127.0.0.1')).toBe('127.0.0.1')
    expect(server.checkHost('ambient.example.invalid')).toBeUndefined()
    const untrusted = new X509Certificate(pki.untrusted.cert)
    expect(untrusted.subjectAltName).toBeUndefined()
    expect(untrusted.keyUsage).toEqual(['1.3.6.1.5.5.7.3.2'])
    expect(untrusted.checkIssued(ca)).toBe(false)
    expect(untrusted.verify(ca.publicKey)).toBe(false)
    await pki.close()
    await expect(access(pki.directory)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
