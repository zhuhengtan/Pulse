import { randomUUID, X509Certificate } from 'node:crypto'
import { createServer, type Server, type TLSSocket } from 'node:tls'
import { z } from 'zod'
import { HardwareIdentityRegistry, fingerprintHardwarePublicKey, type HardwareActiveIdentity, type HardwarePendingIdentity } from './hardware-identity.js'
import { VoiceTerminalBroker, voiceTerminalPacketSchema, type VoiceTerminalIO, type VoiceTerminalIdentity, type VoiceTerminalRequest } from './voice-terminal.js'

export const HARDWARE_LOOPBACK_MAX_FRAME_BYTES = 65_536
const requestId = z.string().uuid()
const scopes = z.array(z.enum(['voice.button', 'voice.wake', 'telemetry.read'])).min(1).max(3)
const messages = z.discriminatedUnion('type', [
  z.object({ type: z.literal('pairing-begin'), requestId, ticket: z.string().min(1).max(512), name: z.string().min(1).max(80), requestedScopes: scopes }).strict(),
  z.object({ type: z.literal('pairing-proof'), requestId, challengeId: z.string().min(1).max(200), signature: z.string().min(1).max(512) }).strict(),
  z.object({ type: z.literal('hello'), requestId, protocolVersions: z.array(z.literal(1)).min(1).max(4), replyProtocolVersion: z.literal(1).optional(), audio: z.object({ codec: z.literal('pcm_s16le'), sampleRate: z.literal(16000), channels: z.literal(1) }).strict() }).strict(),
  z.object({ type: z.literal('packet'), requestId, packet: voiceTerminalPacketSchema }).strict(),
])
type Message = z.infer<typeof messages>
export interface HardwareLoopbackTlsIdentity { key: string | Buffer; cert: string | Buffer; ca: string | Buffer }
export interface HardwareLoopbackBridgeOptions {
  /** No transport or enrollment is enabled unless this test-only mode is explicit. */
  mode?: 'disabled' | 'ephemeral-loopback-test'
  tls?: HardwareLoopbackTlsIdentity
  identities?: HardwareIdentityRegistry
  voice?: Pick<VoiceTerminalIO, 'transcribe' | 'submit' | 'reply' | 'synthesize' | 'diagnostics'>
  /** Separate explicit opt-in; does not authorize a listener or any physical device. */
  enableReplies?: boolean
  replyTimeoutMs?: number
  maxConnections?: number
  idleTimeoutMs?: number
  onPendingPairing?: (identity: HardwarePendingIdentity) => void
}
interface Connection {
  socket: TLSSocket; connectionId: string; publicKeyPem: string; fingerprint: string; buffer: Buffer; seen: Set<string>
  identity?: HardwareActiveIdentity; pendingId?: string; challengeId?: string; principal?: VoiceTerminalIdentity; sessionId?: string
  outstanding: number; windowStart: number; windowFrames: number; lastSeen: number; opened: boolean
}
export type HardwareLoopbackStart = { state: 'disabled' } | { state: 'listening'; mode: 'ephemeral-loopback-test'; host: '127.0.0.1'; port: number }
function safeCode(error: unknown): string {
  const code = error instanceof Error ? error.message : ''
  return /^(HARDWARE|VOICE_TERMINAL)_[A-Z_]{1,90}$/.test(code) ? code : 'HARDWARE_REQUEST_REJECTED'
}

/** Test-only local bridge. It has no production listener, credential creation,
 * persisted pairing, LAN bind, browser admin credential or actuator executor. */
export class HardwareLoopbackBridge {
  private server: Server | undefined
  private voice: VoiceTerminalBroker | undefined
  private starting: Promise<HardwareLoopbackStart> | undefined
  private closing: Promise<void> | undefined
  private closed = false
  private timer: ReturnType<typeof setInterval> | undefined
  private readonly sockets = new Set<TLSSocket>()
  private readonly connections = new Map<string, Connection>()
  private readonly maxConnections: number
  private readonly idleTimeoutMs: number
  constructor(private readonly options: HardwareLoopbackBridgeOptions = {}) {
    if (!['disabled', 'ephemeral-loopback-test'].includes(options.mode ?? 'disabled')) throw new Error('HARDWARE_PRODUCTION_AUTHORIZATION_REQUIRED')
    this.maxConnections = options.maxConnections ?? 8
    this.idleTimeoutMs = options.idleTimeoutMs ?? 30_000
    if (!Number.isSafeInteger(this.maxConnections) || this.maxConnections < 1 || this.maxConnections > 32 || !Number.isFinite(this.idleTimeoutMs) || this.idleTimeoutMs < 50 || this.idleTimeoutMs > 120_000) throw new Error('HARDWARE_BRIDGE_LIMIT_INVALID')
  }
  start(): Promise<HardwareLoopbackStart> {
    if (this.closed) return Promise.reject(new Error('HARDWARE_BRIDGE_CLOSED'))
    if ((this.options.mode ?? 'disabled') === 'disabled') return Promise.resolve({ state: 'disabled' })
    return this.starting ??= this.listen()
  }
  private async listen(): Promise<HardwareLoopbackStart> {
    const { tls, identities, voice } = this.options
    if (!tls || !identities || !voice) throw new Error('HARDWARE_TEST_CONFIGURATION_REQUIRED')
    this.voice = new VoiceTerminalBroker({
      transcribe: async (wav, request, signal) => {
        this.requireRequestIdentity(request)
        const text = await voice.transcribe(wav, request, signal)
        this.requireRequestIdentity(request)
        return text
      },
      submit: (text, request) => { this.requireRequestIdentity(request); return voice.submit(text, request) },
      ...(voice.reply ? { reply: async (admission: unknown, request: VoiceTerminalRequest, signal: AbortSignal) => {
        this.requireRequestIdentity(request)
        const result = await voice.reply!(admission, request, signal)
        this.requireRequestIdentity(request)
        return result
      } } : {}),
      ...(voice.synthesize ? { synthesize: async (final: Parameters<NonNullable<VoiceTerminalIO['synthesize']>>[0], request: VoiceTerminalRequest, signal: AbortSignal) => {
        this.requireRequestIdentity(request)
        const result = await voice.synthesize!(final, request, signal)
        this.requireRequestIdentity(request)
        return result
      } } : {}),
      ...(voice.diagnostics ? { diagnostics: () => voice.diagnostics!() } : {}),
      send: (principal, packet) => {
      const connection = this.connections.get(principal.connectionId)
      if (!connection || !this.authorized(connection)) throw new Error('HARDWARE_IDENTITY_REVOKED_OR_CHANGED')
      this.send(connection, { type: 'terminal-output', packet })
    } }, { enableReplies: this.options.enableReplies ?? false, ...(this.options.replyTimeoutMs !== undefined ? { replyTimeoutMs: this.options.replyTimeoutMs } : {}) })
    const server = createServer({ key: tls.key, cert: tls.cert, ca: tls.ca, minVersion: 'TLSv1.3', requestCert: true, rejectUnauthorized: true, handshakeTimeout: 5_000 }, socket => this.accept(socket))
    this.server = server
    server.on('connection', socket => {
      // Include pre-handshake peers in the capacity bound.
      if (this.closed || this.sockets.size >= this.maxConnections) { socket.destroy(); return }
      this.sockets.add(socket as TLSSocket); socket.once('close', () => this.sockets.delete(socket as TLSSocket))
    })
    server.on('tlsClientError', () => { /* Invalid peers receive no identity or raw diagnostic data. */ })
    await new Promise<void>((resolve, reject) => {
      const failed = () => reject(new Error('HARDWARE_BRIDGE_LISTEN_FAILED'))
      server.once('error', failed)
      server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => { server.off('error', failed); resolve() })
    })
    server.on('error', () => { void this.close().catch(() => {}) })
    if (this.closed) throw new Error('HARDWARE_BRIDGE_CLOSED')
    const address = server.address()
    if (!address || typeof address === 'string' || address.address !== '127.0.0.1') throw new Error('HARDWARE_LOOPBACK_REQUIRED')
    this.timer = setInterval(() => this.sweep(), Math.min(1_000, this.idleTimeoutMs)); this.timer.unref?.()
    return { state: 'listening', mode: 'ephemeral-loopback-test', host: '127.0.0.1', port: address.port }
  }
  private accept(socket: TLSSocket): void {
    if (this.closed || !socket.authorized || !['127.0.0.1', '::ffff:127.0.0.1'].includes(socket.remoteAddress ?? '')) { socket.destroy(); return }
    try {
      const certificate = socket.getPeerX509Certificate()
      if (!certificate) throw new Error('HARDWARE_CERTIFICATE_REQUIRED')
      const publicKeyPem = certificate.publicKey.export({ format: 'pem', type: 'spki' }).toString()
      const fingerprint = fingerprintHardwarePublicKey(publicKeyPem)
      const identity = this.options.identities!.getActiveByFingerprint(fingerprint)
      const connection: Connection = { socket, connectionId: randomUUID(), publicKeyPem, fingerprint, buffer: Buffer.alloc(0), seen: new Set(), outstanding: 0, windowStart: Date.now(), windowFrames: 0, lastSeen: Date.now(), opened: false, ...(identity ? { identity } : {}) }
      this.connections.set(connection.connectionId, connection)
      socket.setNoDelay(true)
      socket.on('data', bytes => this.ingest(connection, Buffer.from(bytes)))
      socket.on('error', () => { this.disconnect(connection) })
      socket.once('close', () => this.disconnect(connection))
      this.send(connection, { type: 'bridge-ready', protocolVersions: [1], mode: 'ephemeral-loopback-test', ...(identity ? { identity } : {}) })
    } catch { socket.destroy() }
  }
  private authorized(connection: Connection): boolean {
    const identity = connection.identity
    if (!identity) return false
    const current = this.options.identities!.getActiveByFingerprint(connection.fingerprint)
    return Boolean(current && current.deviceId === identity.deviceId && current.generation === identity.generation && current.roomId === identity.roomId && current.scopes.length === identity.scopes.length && current.scopes.every(scope => identity.scopes.includes(scope)))
  }
  private requireAuthorized(connection: Connection): HardwareActiveIdentity {
    if (!this.authorized(connection)) throw new Error('HARDWARE_IDENTITY_REVOKED_OR_CHANGED')
    return connection.identity!
  }
  private ingest(connection: Connection, chunk: Buffer): void {
    if (this.closed || connection.socket.destroyed) return
    connection.buffer = Buffer.concat([connection.buffer, chunk])
    for (;;) {
      const index = connection.buffer.indexOf(10)
      if (index < 0) break
      if (index > HARDWARE_LOOPBACK_MAX_FRAME_BYTES) { this.rejectConnection(connection, 'HARDWARE_FRAME_TOO_LARGE'); return }
      const frame = connection.buffer.subarray(0, index); connection.buffer = connection.buffer.subarray(index + 1)
      let message: Message
      try { message = messages.parse(JSON.parse(frame.toString('utf8'))) } catch { this.rejectConnection(connection, 'HARDWARE_MESSAGE_INVALID'); return }
      const now = Date.now()
      if (now - connection.windowStart >= 1_000) { connection.windowStart = now; connection.windowFrames = 0 }
      if (++connection.windowFrames > 200 || connection.outstanding >= 16 || connection.seen.size >= 4096) { this.rejectConnection(connection, 'HARDWARE_CONNECTION_LIMIT'); return }
      if (connection.seen.has(message.requestId)) { this.send(connection, { type: 'result', requestId: message.requestId, ok: false, error: 'HARDWARE_REQUEST_REPLAY' }); continue }
      connection.seen.add(message.requestId); connection.lastSeen = now; connection.outstanding++
      // Do not serialize ASR completion ahead of fresh mute/revoke/stop packets.
      void this.handle(connection, message).then(value => this.send(connection, { type: 'result', requestId: message.requestId, ok: true, value }), error => {
        this.send(connection, { type: 'result', requestId: message.requestId, ok: false, error: safeCode(error) })
        if (connection.identity && !this.authorized(connection)) this.disconnect(connection)
      }).finally(() => { connection.outstanding-- })
    }
    if (connection.buffer.length > HARDWARE_LOOPBACK_MAX_FRAME_BYTES) this.rejectConnection(connection, 'HARDWARE_FRAME_TOO_LARGE')
  }
  private async handle(connection: Connection, message: Message): Promise<unknown> {
    if (message.type === 'pairing-begin') {
      if (connection.identity || connection.challengeId || connection.pendingId) throw new Error('HARDWARE_PAIRING_STATE_INVALID')
      const challenge = this.options.identities!.beginPairing({ ticket: message.ticket, publicKeyPem: connection.publicKeyPem, name: message.name, requestedScopes: message.requestedScopes, connectionBinding: connection.connectionId })
      connection.challengeId = challenge.challengeId
      return { state: 'challenge', challenge }
    }
    if (message.type === 'pairing-proof') {
      if (!connection.challengeId || connection.challengeId !== message.challengeId || connection.pendingId || connection.identity) throw new Error('HARDWARE_PAIRING_STATE_INVALID')
      const pending = this.options.identities!.completePairing({ challengeId: message.challengeId, signature: message.signature, connectionBinding: connection.connectionId })
      connection.pendingId = pending.requestId
      this.options.onPendingPairing?.(pending)
      return { state: 'pending-local-approval', pending }
    }
    const identity = this.requireAuthorized(connection)
    if (message.type === 'hello') {
      if (connection.opened || !identity.scopes.some(scope => scope === 'voice.button' || scope === 'voice.wake')) throw new Error('HARDWARE_VOICE_SCOPE_REQUIRED')
      if ([...this.connections.values()].some(c => c !== connection && c.opened && c.identity?.deviceId === identity.deviceId)) throw new Error('HARDWARE_DEVICE_ALREADY_CONNECTED')
      this.voice!.register({ deviceId: identity.deviceId, roomId: identity.roomId, allowButton: identity.scopes.includes('voice.button'), allowWake: identity.scopes.includes('voice.wake') })
      const principal = { connectionId: connection.connectionId, deviceId: identity.deviceId, roomId: identity.roomId }
      const session = this.voice!.open(principal, { protocolVersions: message.protocolVersions, audio: message.audio, ...(message.replyProtocolVersion ? { replyProtocolVersion: message.replyProtocolVersion } : {}), deviceId: identity.deviceId, roomId: identity.roomId })
      connection.principal = principal; connection.sessionId = session.sessionId; connection.opened = true
      return { state: 'session-opened', deviceId: identity.deviceId, roomId: identity.roomId, ...session }
    }
    if (!connection.opened || !connection.principal) throw new Error('HARDWARE_VOICE_SESSION_REQUIRED')
    return this.voice!.receive(connection.principal, message.packet)
  }
  private requireRequestIdentity(request: VoiceTerminalRequest): void {
    const connection = [...this.connections.values()].find(c => c.opened && c.sessionId === request.sessionId && c.identity?.deviceId === request.deviceId && c.identity?.roomId === request.roomId)
    if (!connection || !this.authorized(connection)) throw new Error('HARDWARE_IDENTITY_REVOKED_OR_CHANGED')
  }
  /** Trusted local host operation only. There is deliberately no network approval message. */
  approvePairing(requestId: string, approval: { roomId: string; scopes: ('voice.button' | 'voice.wake' | 'telemetry.read')[] }): HardwareActiveIdentity {
    z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/).parse(approval.roomId)
    const connection = [...this.connections.values()].find(c => c.pendingId === requestId && !c.socket.destroyed)
    if (!connection || this.closed) throw new Error('HARDWARE_PAIRING_CONNECTION_CLOSED')
    const identity = this.options.identities!.approvePending(requestId, approval)
    if (identity.publicKeyFingerprint !== connection.fingerprint) throw new Error('HARDWARE_PAIRING_IDENTITY_MISMATCH')
    connection.identity = structuredClone(identity)
    this.send(connection, { type: 'pairing-approved', identity })
    return structuredClone(identity)
  }
  revoke(deviceId: string): boolean {
    const revoked = this.options.identities?.revoke(deviceId) ?? false
    for (const connection of [...this.connections.values()]) if (connection.identity?.deviceId === deviceId) this.disconnect(connection)
    return revoked
  }
  play(deviceId: string, chunk: Parameters<VoiceTerminalBroker['play']>[1]): { state: 'sent' } {
    const connection = [...this.connections.values()].find(c => c.opened && c.identity?.deviceId === deviceId)
    if (!connection?.principal) throw new Error('HARDWARE_DEVICE_OFFLINE')
    this.requireAuthorized(connection)
    return this.voice!.play(connection.principal, chunk)
  }
  snapshot() {
    this.sweep()
    return { mode: this.options.mode ?? 'disabled', enabled: this.server?.listening ?? false, productionReady: false as const, persistentCredentials: false as const, connections: this.connections.size, terminals: this.voice?.snapshot() ?? [], replies: this.voice?.replySnapshot() ?? [] }
  }
  private sweep(): void {
    this.voice?.sweep()
    const sessions = this.voice?.snapshot() ?? []
    for (const connection of [...this.connections.values()]) {
      if (Date.now() - connection.lastSeen > this.idleTimeoutMs || connection.identity && !this.authorized(connection) || connection.opened && !sessions.some(s => s.sessionId && s.deviceId === connection.identity?.deviceId)) this.disconnect(connection)
    }
  }
  private send(connection: Connection, value: unknown): void {
    if (connection.socket.destroyed) return
    let frame: string
    try { frame = JSON.stringify(value) + '\n' } catch { this.disconnect(connection); return }
    if (Buffer.byteLength(frame) > 1_600_000 || connection.socket.writableLength + Buffer.byteLength(frame) > 3_200_000) { this.disconnect(connection); return }
    connection.socket.write(frame)
  }
  private rejectConnection(connection: Connection, error: string): void { this.send(connection, { type: 'error', error }); this.disconnect(connection) }
  private disconnect(connection: Connection): void {
    this.connections.delete(connection.connectionId)
    if (connection.principal) this.voice?.close(connection.principal)
    connection.socket.destroy()
  }
  close(): Promise<void> {
    return this.closing ??= (async () => {
      this.closed = true; clearInterval(this.timer)
      await this.starting?.catch(() => {})
      for (const connection of [...this.connections.values()]) this.disconnect(connection)
      for (const socket of this.sockets) socket.destroy()
      const server = this.server
      if (server?.listening) await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('HARDWARE_BRIDGE_CLEANUP_TIMEOUT')), 5_000)
        server.close(error => { clearTimeout(timeout); error ? reject(new Error('HARDWARE_BRIDGE_CLEANUP_FAILED')) : resolve() })
      })
      this.server = undefined
      if ((this.voice?.closeReplies().pendingCallbacks ?? 0) > 0) throw new Error('HARDWARE_REPLY_CLEANUP_UNCONFIRMED')
    })()
  }
}

/** Public certificate fingerprint for test client pinning, not a stored secret. */
export function hardwareTestCertificateFingerprint(cert: string | Buffer): string { return new X509Certificate(cert).fingerprint256 }
