import { createPrivateKey, randomUUID, sign, X509Certificate } from 'node:crypto'
import { checkServerIdentity, connect, type TLSSocket } from 'node:tls'
import { z } from 'zod'
import { fingerprintHardwarePublicKey, hardwarePairingSigningBytes, type HardwareActiveIdentity, type HardwareIdentityScope, type HardwarePairingChallenge, type HardwarePendingIdentity } from './hardware-identity.js'
import { voiceTerminalPacketSchema, type VoiceTerminalResult } from './voice-terminal.js'
import type { HardwareLoopbackTlsIdentity } from './hardware-bridge.js'

const identitySchema = z.object({ deviceId: z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/), publicKeyFingerprint: z.string().regex(/^[a-f0-9]{64}$/), name: z.string().max(256), roomId: z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/), scopes: z.array(z.enum(['voice.button', 'voice.wake', 'telemetry.read'])).min(1).max(3), generation: z.number().int().positive(), status: z.literal('active') }).strict()
const challengeSchema = z.object({ protocol: z.literal('pulse.hardware-pairing.test.v1'), hostId: z.string().min(1).max(256), challengeId: z.string().min(1).max(128), nonce: z.string().min(1).max(128), publicKeyFingerprint: z.string().regex(/^[a-f0-9]{64}$/), requestedScopes: z.array(z.enum(['voice.button', 'voice.wake', 'telemetry.read'])).min(1).max(3), connectionBindingHash: z.string().regex(/^[a-f0-9]{64}$/), expiresAt: z.number().finite() }).strict()
export interface HardwareVirtualTerminalOptions {
  mode: 'ephemeral-loopback-test'
  port: number
  tls: HardwareLoopbackTlsIdentity
  pinnedServerFingerprint: string
  expectedHostId: string
  requestTimeoutMs?: number
  onOutput?: (packet: Record<string, unknown>) => void
}
/** Synthetic terminal only: no microphone, speaker, firmware, USB/BLE or stored keys. */
export class HardwareVirtualTerminal {
  private socket: TLSSocket | undefined
  private connecting: Promise<void> | undefined
  private closed = false
  private buffer = Buffer.alloc(0)
  private identity: HardwareActiveIdentity | undefined
  private session: { deviceId: string; roomId: string; sessionId: string; sequence: number } | undefined
  private readonly pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  private readyResolve!: () => void
  private readyReject!: (error: Error) => void
  private readonly ready = new Promise<void>((resolve, reject) => { this.readyResolve = resolve; this.readyReject = reject })
  private readonly identityWaiters = new Set<{ resolve: (identity: HardwareActiveIdentity) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  readonly outputs: Record<string, unknown>[] = []
  private outputBytes = 0
  constructor(private readonly options: HardwareVirtualTerminalOptions) {
    void this.ready.catch(() => {})
    if (options.mode !== 'ephemeral-loopback-test' || !Number.isSafeInteger(options.port) || options.port < 1 || options.port > 65535 || !/^(?:[A-Fa-f0-9]{2}:){31}[A-Fa-f0-9]{2}$/.test(options.pinnedServerFingerprint) || !options.expectedHostId || options.expectedHostId.length > 256) throw new Error('HARDWARE_TEST_CLIENT_CONFIGURATION')
    if (options.requestTimeoutMs !== undefined && (!Number.isFinite(options.requestTimeoutMs) || options.requestTimeoutMs < 10 || options.requestTimeoutMs > 120_000)) throw new Error('HARDWARE_TEST_CLIENT_CONFIGURATION')
  }
  connect(): Promise<void> {
    if (this.closed) return Promise.reject(new Error('HARDWARE_TERMINAL_CLOSED'))
    return this.connecting ??= (async () => {
      const socket = connect({ host: '127.0.0.1', port: this.options.port, servername: 'localhost', key: this.options.tls.key, cert: this.options.tls.cert, ca: this.options.tls.ca, minVersion: 'TLSv1.3', rejectUnauthorized: true, checkServerIdentity: (host, certificate) => {
        const hostnameError = checkServerIdentity(host, certificate)
        if (hostnameError) return hostnameError
        if (certificate.fingerprint256?.toUpperCase() !== this.options.pinnedServerFingerprint.toUpperCase()) return new Error('HARDWARE_SERVER_PIN_MISMATCH')
        return undefined
      } })
      this.socket = socket; socket.setNoDelay(true)
      socket.on('data', chunk => this.ingest(Buffer.from(chunk)))
      socket.on('error', () => this.fail('HARDWARE_TLS_AUTHENTICATION_FAILED'))
      socket.once('close', () => this.fail('HARDWARE_CONNECTION_CLOSED'))
      const timeout = setTimeout(() => this.fail('HARDWARE_CONNECT_TIMEOUT'), this.options.requestTimeoutMs ?? 5_000)
      try { await this.ready } finally { clearTimeout(timeout) }
    })()
  }
  private ingest(chunk: Buffer): void {
    if (this.closed) return
    this.buffer = Buffer.concat([this.buffer, chunk])
    for (;;) {
      const index = this.buffer.indexOf(10)
      if (index < 0) break
      if (index > 1_600_000) { this.fail('HARDWARE_SERVER_FRAME_TOO_LARGE'); return }
      const frame = this.buffer.subarray(0, index); this.buffer = this.buffer.subarray(index + 1)
      let value: Record<string, unknown>
      try { value = JSON.parse(frame.toString('utf8')); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error() } catch { this.fail('HARDWARE_SERVER_MESSAGE_INVALID'); return }
      try {
        if (value.type === 'bridge-ready') {
          if (value.mode !== 'ephemeral-loopback-test' || !Array.isArray(value.protocolVersions) || !value.protocolVersions.includes(1)) throw new Error()
          if (value.identity) this.setIdentity(identitySchema.parse(value.identity))
          this.readyResolve()
        } else if (value.type === 'pairing-approved') this.setIdentity(identitySchema.parse(value.identity))
        else if (value.type === 'result') {
          const pending = typeof value.requestId === 'string' ? this.pending.get(value.requestId) : undefined
          if (!pending) continue
          this.pending.delete(value.requestId as string); clearTimeout(pending.timer)
          if (value.ok === true) pending.resolve(value.value)
          else pending.reject(new Error(typeof value.error === 'string' && /^(HARDWARE|VOICE_TERMINAL)_[A-Z_]{1,90}$/.test(value.error) ? value.error : 'HARDWARE_REQUEST_REJECTED'))
        } else if (value.type === 'terminal-output') {
          const packet = value.packet as Record<string, unknown>
          if (!packet || typeof packet !== 'object' || !this.session || packet.deviceId !== this.session.deviceId || packet.roomId !== this.session.roomId || packet.sessionId !== this.session.sessionId) throw new Error()
          const size = Buffer.byteLength(JSON.stringify(packet))
          if (size > 1_600_000) throw new Error()
          while (this.outputs.length && (this.outputs.length >= 16 || this.outputBytes + size > 2_000_000)) this.outputBytes -= Buffer.byteLength(JSON.stringify(this.outputs.shift()))
          this.outputs.push(packet); this.outputBytes += size
          this.options.onOutput?.(packet)
        } else if (value.type === 'error') { this.fail('HARDWARE_PROTOCOL_CLOSED'); return }
        else throw new Error()
      } catch { this.fail('HARDWARE_SERVER_MESSAGE_INVALID'); return }
    }
    if (this.buffer.length > 1_600_000) this.fail('HARDWARE_SERVER_FRAME_TOO_LARGE')
  }
  private setIdentity(identity: HardwareActiveIdentity): void {
    this.identity = identity
    for (const waiter of this.identityWaiters) { clearTimeout(waiter.timer); waiter.resolve(structuredClone(identity)) }
    this.identityWaiters.clear()
  }
  async waitForIdentity(timeoutMs = 5_000): Promise<HardwareActiveIdentity> {
    await this.connect()
    if (this.identity) return structuredClone(this.identity)
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, timer: setTimeout(() => { this.identityWaiters.delete(waiter); reject(new Error('HARDWARE_LOCAL_APPROVAL_REQUIRED')) }, timeoutMs) }
      this.identityWaiters.add(waiter)
    })
  }
  private async request(type: string, input: Record<string, unknown>): Promise<unknown> {
    await this.connect()
    if (this.closed || !this.socket || this.socket.destroyed) throw new Error('HARDWARE_CONNECTION_CLOSED')
    if (this.pending.size >= 16) throw new Error('HARDWARE_CLIENT_LIMIT')
    const requestId = randomUUID(), frame = JSON.stringify({ type, requestId, ...input }) + '\n'
    if (Buffer.byteLength(frame) > 65_536 || this.socket.writableLength + Buffer.byteLength(frame) > 131_072) throw new Error('HARDWARE_CLIENT_BACKPRESSURE')
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(requestId); reject(new Error('HARDWARE_REQUEST_OUTCOME_UNKNOWN')) }, this.options.requestTimeoutMs ?? 5_000)
      this.pending.set(requestId, { resolve, reject, timer })
      this.socket!.write(frame, error => {
        if (!error) return
        const pending = this.pending.get(requestId); if (!pending) return
        this.pending.delete(requestId); clearTimeout(timer); pending.reject(new Error('HARDWARE_REQUEST_OUTCOME_UNKNOWN'))
      })
    })
  }
  async pair(ticket: string, name: string, requestedScopes: HardwareIdentityScope[]): Promise<HardwarePendingIdentity> {
    const response = await this.request('pairing-begin', { ticket, name, requestedScopes }) as { state?: unknown; challenge?: unknown }
    if (response.state !== 'challenge') throw new Error('HARDWARE_PAIRING_CHALLENGE_INVALID')
    const challenge = challengeSchema.parse(response.challenge) as HardwarePairingChallenge
    const privateKey = createPrivateKey(this.options.tls.key)
    const publicKeyPem = new X509Certificate(this.options.tls.cert).publicKey.export({ type: 'spki', format: 'pem' }).toString()
    if (challenge.hostId !== this.options.expectedHostId || challenge.publicKeyFingerprint !== fingerprintHardwarePublicKey(publicKeyPem) || challenge.requestedScopes.join(',') !== [...requestedScopes].sort().join(',') || challenge.expiresAt <= Date.now() || challenge.expiresAt > Date.now() + 120_000) throw new Error('HARDWARE_PAIRING_CHALLENGE_INVALID')
    const signature = sign(null, hardwarePairingSigningBytes(challenge), privateKey).toString('base64url')
    const completed = await this.request('pairing-proof', { challengeId: challenge.challengeId, signature }) as { state?: unknown; pending?: HardwarePendingIdentity }
    if (completed.state !== 'pending-local-approval' || !completed.pending || completed.pending.publicKeyFingerprint !== challenge.publicKeyFingerprint || completed.pending.status !== 'pending') throw new Error('HARDWARE_PAIRING_PENDING_INVALID')
    return structuredClone(completed.pending)
  }
  async openVoice(options: { replyProtocolVersion?: 1 } = {}): Promise<{ sessionId: string; deviceId: string; roomId: string }> {
    const identity = await this.waitForIdentity()
    const response = await this.request('hello', { protocolVersions: [1], ...options, audio: { codec: 'pcm_s16le', sampleRate: 16000, channels: 1 } }) as { state?: unknown; sessionId?: unknown; deviceId?: unknown; roomId?: unknown; nextSequence?: unknown; replyProtocolVersion?: unknown }
    if (response.state !== 'session-opened' || typeof response.sessionId !== 'string' || !z.string().uuid().safeParse(response.sessionId).success || response.deviceId !== identity.deviceId || response.roomId !== identity.roomId || response.nextSequence !== 0) throw new Error('HARDWARE_VOICE_SESSION_INVALID')
    if (response.replyProtocolVersion !== undefined && (response.replyProtocolVersion !== 1 || options.replyProtocolVersion !== 1)) throw new Error('HARDWARE_REPLY_PROTOCOL_INVALID')
    this.session = { deviceId: identity.deviceId, roomId: identity.roomId, sessionId: response.sessionId, sequence: 0 }
    return { sessionId: response.sessionId, deviceId: identity.deviceId, roomId: identity.roomId }
  }
  async sendPacket(payload: z.infer<typeof voiceTerminalPacketSchema>['payload']): Promise<VoiceTerminalResult> {
    const session = this.session
    if (!session) throw new Error('HARDWARE_VOICE_SESSION_REQUIRED')
    const packet = voiceTerminalPacketSchema.parse({ protocolVersion: 1, deviceId: session.deviceId, roomId: session.roomId, sessionId: session.sessionId, sequence: session.sequence++, payload })
    return await this.request('packet', { packet }) as VoiceTerminalResult
  }
  async captureSyntheticPcm(pcm: Buffer, trigger: 'button' | 'wake' = 'button'): Promise<VoiceTerminalResult> {
    if (!pcm.length || pcm.length % 2 || pcm.length > 960_000) throw new Error('HARDWARE_SYNTHETIC_PCM_INVALID')
    const captureId = randomUUID()
    await this.sendPacket({ type: 'capture-start', captureId, trigger })
    let audioSequence = 0
    for (let offset = 0; offset < pcm.length; offset += 16_000) await this.sendPacket({ type: 'audio', captureId, audioSequence: audioSequence++, pcm: pcm.subarray(offset, offset + 16_000).toString('base64') })
    return this.sendPacket({ type: 'capture-end', captureId })
  }
  /** Synthetic receipt only, never evidence that a physical speaker played audio. */
  async acknowledgePlayback(packet: Record<string, unknown>): Promise<VoiceTerminalResult> {
    if (packet.type !== 'playback' || typeof packet.playbackId !== 'string' || !Number.isSafeInteger(packet.audioSequence)) throw new Error('HARDWARE_PLAYBACK_RECEIPT_INVALID')
    return this.sendPacket({ type: 'playback-ack', playbackId: packet.playbackId, audioSequence: packet.audioSequence as number })
  }
  async reportPlayback(packet: Record<string, unknown>, stage: 'received' | 'started' | 'completed' | 'error', errorCode?: string): Promise<VoiceTerminalResult> {
    if (packet.type !== 'playback' || typeof packet.requestId !== 'string' || typeof packet.replyId !== 'string' || typeof packet.playbackId !== 'string') throw new Error('HARDWARE_PLAYBACK_RECEIPT_INVALID')
    return this.sendPacket({ type: 'playback-status', requestId: packet.requestId, replyId: packet.replyId, playbackId: packet.playbackId, stage, ...(errorCode ? { errorCode } : {}) })
  }
  /** Malformed-packet probe for local tests. Never exposed as a Pulse model tool. */
  async sendRawTestFrame(value: unknown): Promise<void> { await this.connect(); if (this.closed || !this.socket) throw new Error('HARDWARE_CONNECTION_CLOSED'); this.socket.write(JSON.stringify(value) + '\n') }
  private fail(code: string): void {
    if (this.closed) return
    this.closed = true; this.readyReject(new Error(code))
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error(code)) }; this.pending.clear()
    for (const waiter of this.identityWaiters) { clearTimeout(waiter.timer); waiter.reject(new Error(code)) }; this.identityWaiters.clear()
    this.socket?.destroy()
  }
  async close(): Promise<void> {
    const socket = this.socket
    const closing = socket && !socket.closed ? new Promise<void>(resolve => socket.once('close', () => resolve())) : Promise.resolve()
    this.fail('HARDWARE_CONNECTION_CLOSED'); await closing
  }
}
