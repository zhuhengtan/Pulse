/** Developer sample only. The caller supplies temporary, isolated test PKI.
 * Importing this file creates no listener, key, grant or persistent access. */
import { HardwareIdentityRegistry } from '../packages/server/src/device-use/hardware-identity.js'
import { HardwareLoopbackBridge, hardwareTestCertificateFingerprint, type HardwareLoopbackTlsIdentity } from '../packages/server/src/device-use/hardware-bridge.js'
import { HardwareVirtualTerminal } from '../packages/server/src/device-use/hardware-virtual-terminal.js'

export async function runHardwareLoopbackSample(temporaryTestCredentials: { server: HardwareLoopbackTlsIdentity; client: HardwareLoopbackTlsIdentity }) {
  const identities = new HardwareIdentityRegistry({ hostId: 'sample-test-host', temporaryTestOnly: true })
  const submitted: unknown[] = []
  const bridge = new HardwareLoopbackBridge({ mode: 'ephemeral-loopback-test', identities, tls: temporaryTestCredentials.server, voice: {
    transcribe: async () => 'Synthetic button request. No microphone or cloud ASR.',
    submit: async (text, metadata) => { submitted.push({ text, metadata }); return { accepted: true, simulated: true } },
  } })
  let terminal: HardwareVirtualTerminal | undefined
  try {
    const address = await bridge.start()
    if (address.state !== 'listening') throw new Error('HARDWARE_SAMPLE_NOT_ENABLED')
    terminal = new HardwareVirtualTerminal({ mode: 'ephemeral-loopback-test', port: address.port, tls: temporaryTestCredentials.client, pinnedServerFingerprint: hardwareTestCertificateFingerprint(temporaryTestCredentials.server.cert), expectedHostId: 'sample-test-host' })
    await terminal.connect()
    const pending = await terminal.pair(identities.createTicket().ticket, 'Synthetic button terminal', ['voice.button'])
    // This direct approval stands for the trusted test operator only. Never expose
    // approvePairing or ticket creation to a terminal/network/model tool.
    bridge.approvePairing(pending.requestId, { roomId: 'test-room', scopes: ['voice.button'] })
    await terminal.waitForIdentity(); await terminal.openVoice()
    await terminal.sendPacket({ type: 'status', muted: false, light: 'idle' })
    const receipt = await terminal.captureSyntheticPcm(Buffer.alloc(3200))
    return { simulated: true, persistentAccessCreated: false, receipt, submitted, snapshotAtReceipt: bridge.snapshot() }
  } finally {
    const cleanup = await Promise.allSettled([terminal?.close(), bridge.close()])
    identities.clear()
    const failures = cleanup.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
    if (failures.length) throw new AggregateError(failures, 'HARDWARE_SAMPLE_CLEANUP_FAILED')
  }
}
