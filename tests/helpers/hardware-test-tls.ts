import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { HardwareLoopbackTlsIdentity } from '../../packages/server/src/device-use/hardware-bridge.js'

export const hardwareTestTlsAvailable = spawnSync('openssl', ['version'], { stdio: 'ignore' }).status === 0
/** Explicit test PKI in a temporary directory; never installed in an OS trust store. */
export async function temporaryHardwareTestTls() {
  const directory = await mkdtemp(join(tmpdir(), 'pulse-hardware-test-pki-'))
  const openssl = (...args: string[]) => execFileSync('openssl', args, { cwd: directory, stdio: 'ignore', timeout: 10_000 })
  try {
    // OpenSSL 1.1.1 appends -addext to host-configured x509_extensions, so a
    // default v3_ca section would duplicate Basic Constraints and invalidate
    // the CA. Own req configuration rather than inheriting machine defaults.
    await writeFile(join(directory, 'request.cnf'), '[req]\ndistinguished_name=dn\n[dn]\n', { mode: 0o600 })
    openssl('genpkey', '-algorithm', 'ED25519', '-out', 'ca.key')
    openssl('req', '-config', 'request.cnf', '-new', '-x509', '-key', 'ca.key', '-out', 'ca.crt', '-days', '1', '-subj', '/CN=Pulse ephemeral TEST CA', '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign')
    for (const [name, usage, serial] of [['server', 'serverAuth', '2'], ['client', 'clientAuth', '3']] as const) {
      openssl('genpkey', '-algorithm', 'ED25519', '-out', `${name}.key`)
      openssl('req', '-config', 'request.cnf', '-new', '-key', `${name}.key`, '-out', `${name}.csr`, '-subj', `/CN=${name === 'server' ? 'localhost' : 'Pulse synthetic terminal'}`)
      await writeFile(join(directory, `${name}.ext`), `basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=${usage}\n${name === 'server' ? 'subjectAltName=DNS:localhost,IP:127.0.0.1\n' : ''}`, { mode: 0o600 })
      openssl('x509', '-req', '-in', `${name}.csr`, '-CA', 'ca.crt', '-CAkey', 'ca.key', '-set_serial', serial, '-out', `${name}.crt`, '-days', '1', '-extfile', `${name}.ext`)
    }
    openssl('genpkey', '-algorithm', 'ED25519', '-out', 'untrusted.key')
    openssl('req', '-config', 'request.cnf', '-new', '-x509', '-key', 'untrusted.key', '-out', 'untrusted.crt', '-days', '1', '-subj', '/CN=Untrusted TEST terminal', '-addext', 'extendedKeyUsage=clientAuth')
    const ca = await readFile(join(directory, 'ca.crt'), 'utf8')
    const identity = async (name: string): Promise<HardwareLoopbackTlsIdentity> => ({ key: await readFile(join(directory, `${name}.key`), 'utf8'), cert: await readFile(join(directory, `${name}.crt`), 'utf8'), ca })
    return { directory, server: await identity('server'), client: await identity('client'), untrusted: await identity('untrusted'), close: () => rm(directory, { recursive: true, force: true }) }
  } catch { await rm(directory, { recursive: true, force: true }); throw new Error('HARDWARE_TEST_PKI_SETUP_FAILED') }
}
