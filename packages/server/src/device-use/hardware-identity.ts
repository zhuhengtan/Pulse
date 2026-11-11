import { createHash, createPublicKey, randomBytes, verify, type KeyObject } from 'node:crypto';

/** Experimental, process-local identities only. Never load production credentials here. */
export const HARDWARE_IDENTITY_SCOPES = ['voice.button', 'voice.wake', 'telemetry.read'] as const;
export type HardwareIdentityScope = typeof HARDWARE_IDENTITY_SCOPES[number];
export interface HardwarePairingChallenge {
  protocol: 'pulse.hardware-pairing.test.v1';
  hostId: string;
  challengeId: string;
  nonce: string;
  publicKeyFingerprint: string;
  requestedScopes: HardwareIdentityScope[];
  connectionBindingHash: string;
  expiresAt: number;
}
export interface HardwarePendingIdentity {
  requestId: string;
  deviceId: string;
  publicKeyFingerprint: string;
  name: string;
  requestedScopes: HardwareIdentityScope[];
  status: 'pending';
  expiresAt: number;
}
export interface HardwareActiveIdentity {
  deviceId: string;
  publicKeyFingerprint: string;
  name: string;
  roomId: string;
  scopes: HardwareIdentityScope[];
  generation: number;
  status: 'active';
}
export interface HardwareIdentityRegistryOptions {
  hostId: string;
  temporaryTestOnly: true;
  now?: () => number;
  ticketTtlMs?: number;
  challengeTtlMs?: number;
  pendingTtlMs?: number;
  maxEntries?: number;
  maxAttemptsPerWindow?: number;
  rateWindowMs?: number;
}
const digest = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
const token = (): string => randomBytes(32).toString('base64url');
function boundedText(value: unknown, label: string, max = 256): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`Invalid ${label}`);
}
function positive(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Invalid ${label}`);
  return value;
}
function scopes(value: readonly HardwareIdentityScope[]): HardwareIdentityScope[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 3 ||
      value.some(scope => !HARDWARE_IDENTITY_SCOPES.includes(scope)) || new Set(value).size !== value.length) {
    throw new Error('Invalid hardware scopes');
  }
  return [...value].sort();
}
function publicKey(pem: string): KeyObject {
  boundedText(pem, 'public key', 4096);
  if (!/^-----BEGIN PUBLIC KEY-----\r?\n/.test(pem) || !/-----END PUBLIC KEY-----\s*$/.test(pem)) throw new Error('Expected SPKI public key');
  const key = createPublicKey(pem);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('Only Ed25519 public keys are supported');
  return key;
}
export function fingerprintHardwarePublicKey(publicKeyPem: string): string {
  return digest(publicKey(publicKeyPem).export({ type: 'spki', format: 'der' }));
}
/** Fixed field order and domain separation: devices must sign exactly these bytes. */
export function hardwarePairingSigningBytes(challenge: HardwarePairingChallenge): Buffer {
  return Buffer.from(JSON.stringify([
    challenge.protocol, challenge.hostId, challenge.challengeId, challenge.nonce,
    challenge.publicKeyFingerprint, challenge.requestedScopes,
    challenge.connectionBindingHash, challenge.expiresAt,
  ]), 'utf8');
}
type ChallengeRecord = { challenge: HardwarePairingChallenge; key: KeyObject; name: string };
type KnownIdentity = { deviceId: string; publicKeyFingerprint: string; ceiling: HardwareIdentityScope[]; active?: HardwareActiveIdentity };

/** Call ticket creation and approval ONLY from a trusted Host control plane, never a device route.
 * No persistence, sockets, private keys, production enrollment, or actuator permissions exist here.
 */
export class HardwareIdentityRegistry {
  private readonly hostId: string;
  private readonly now: () => number;
  private readonly ticketTtlMs: number;
  private readonly challengeTtlMs: number;
  private readonly pendingTtlMs: number;
  private readonly maxEntries: number;
  private readonly maxAttempts: number;
  private readonly rateWindowMs: number;
  private readonly tickets = new Map<string, number>();
  private readonly challenges = new Map<string, ChallengeRecord>();
  private readonly pending = new Map<string, HardwarePendingIdentity>();
  private readonly known = new Map<string, KnownIdentity>();
  private rateStart = 0;
  private attempts = 0;
  private generation = 0;

  constructor(options: HardwareIdentityRegistryOptions) {
    if (options.temporaryTestOnly !== true) throw new Error('Only explicit temporary test identities are supported');
    boundedText(options.hostId, 'hostId');
    this.hostId = options.hostId;
    this.now = options.now ?? Date.now;
    this.ticketTtlMs = positive(options.ticketTtlMs ?? 60_000, 'ticket TTL');
    this.challengeTtlMs = positive(options.challengeTtlMs ?? 30_000, 'challenge TTL');
    this.pendingTtlMs = positive(options.pendingTtlMs ?? 120_000, 'pending TTL');
    this.maxEntries = positive(options.maxEntries ?? 128, 'capacity');
    this.maxAttempts = positive(options.maxAttemptsPerWindow ?? 30, 'attempt limit');
    this.rateWindowMs = positive(options.rateWindowMs ?? 60_000, 'rate window');
  }
  private sweep(): void {
    const now = this.now();
    for (const [id, expiry] of this.tickets) if (expiry <= now) this.tickets.delete(id);
    for (const [id, record] of this.challenges) if (record.challenge.expiresAt <= now) this.challenges.delete(id);
    for (const [id, record] of this.pending) if (record.expiresAt <= now) this.pending.delete(id);
  }
  private attempt(): void {
    const now = this.now();
    if (now < this.rateStart || now - this.rateStart >= this.rateWindowMs) { this.rateStart = now; this.attempts = 0; }
    if (++this.attempts > this.maxAttempts) throw new Error('Pairing rate limit exceeded');
    this.sweep();
  }
  private capacity(size: number): void { if (size >= this.maxEntries) throw new Error('Hardware identity capacity exceeded'); }

  createTicket(options: { ttlMs?: number } = {}): { ticket: string; expiresAt: number } {
    this.attempt();
    this.capacity(this.tickets.size);
    const ttl = positive(options.ttlMs ?? this.ticketTtlMs, 'ticket TTL');
    if (ttl > this.ticketTtlMs) throw new Error('Ticket TTL exceeds policy');
    const ticket = token();
    const expiresAt = this.now() + ttl;
    this.tickets.set(digest(ticket), expiresAt);
    return { ticket, expiresAt };
  }
  beginPairing(input: { ticket: string; publicKeyPem: string; name: string; requestedScopes: HardwareIdentityScope[]; connectionBinding: string }): HardwarePairingChallenge {
    this.attempt();
    boundedText(input.ticket, 'ticket', 128);
    const hash = digest(input.ticket);
    if (!this.tickets.delete(hash)) throw new Error('Invalid or consumed ticket');
    // A ticket is burned even on invalid input; each permits just one enrollment attempt.
    boundedText(input.name, 'name');
    boundedText(input.connectionBinding, 'connection binding', 1024);
    const requestedScopes = scopes(input.requestedScopes);
    const key = publicKey(input.publicKeyPem);
    const fingerprint = digest(key.export({ type: 'spki', format: 'der' }));
    const prior = this.known.get(fingerprint);
    if (prior && requestedScopes.some(scope => !prior.ceiling.includes(scope))) throw new Error('Re-pairing cannot expand scopes');
    if (!prior) this.capacity(this.known.size);
    this.capacity(this.challenges.size);
    const challenge: HardwarePairingChallenge = {
      protocol: 'pulse.hardware-pairing.test.v1', hostId: this.hostId,
      challengeId: token(), nonce: token(), publicKeyFingerprint: fingerprint,
      requestedScopes, connectionBindingHash: digest(input.connectionBinding), expiresAt: this.now() + this.challengeTtlMs,
    };
    this.challenges.set(challenge.challengeId, { challenge, key, name: input.name });
    return structuredClone(challenge);
  }
  completePairing(input: { challengeId: string; signature: string; connectionBinding: string }): HardwarePendingIdentity {
    this.attempt();
    boundedText(input.challengeId, 'challengeId', 128);
    const record = this.challenges.get(input.challengeId);
    this.challenges.delete(input.challengeId);
    if (!record) throw new Error('Invalid or consumed challenge');
    boundedText(input.connectionBinding, 'connection binding', 1024);
    const { challenge, key, name } = record;
    if (digest(input.connectionBinding) !== challenge.connectionBindingHash) throw new Error('Connection binding mismatch');
    if (typeof input.signature !== 'string' || !/^[A-Za-z0-9_-]{86}$/.test(input.signature)) throw new Error('Invalid possession proof');
    const signature = Buffer.from(input.signature, 'base64url');
    if (signature.toString('base64url') !== input.signature || !verify(null, hardwarePairingSigningBytes(challenge), key, signature)) throw new Error('Invalid possession proof');
    this.capacity(this.pending.size);
    const pending: HardwarePendingIdentity = {
      requestId: token(), deviceId: `hardware-${challenge.publicKeyFingerprint}`,
      publicKeyFingerprint: challenge.publicKeyFingerprint, name, requestedScopes: [...challenge.requestedScopes],
      status: 'pending', expiresAt: this.now() + this.pendingTtlMs,
    };
    this.pending.set(pending.requestId, pending);
    return structuredClone(pending);
  }
  approvePending(requestId: string, approval: { roomId: string; scopes: HardwareIdentityScope[] }): HardwareActiveIdentity {
    this.sweep();
    const pending = this.pending.get(requestId);
    this.pending.delete(requestId);
    if (!pending) throw new Error('Invalid or consumed pending request');
    if (typeof approval.roomId !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(approval.roomId)) {
      throw new Error('Invalid roomId');
    }
    const approved = scopes(approval.scopes);
    const prior = this.known.get(pending.publicKeyFingerprint);
    if (approved.some(scope => !pending.requestedScopes.includes(scope) || (prior && !prior.ceiling.includes(scope)))) throw new Error('Approval cannot expand scopes');
    if (!prior) this.capacity(this.known.size);
    const active: HardwareActiveIdentity = {
      deviceId: pending.deviceId, publicKeyFingerprint: pending.publicKeyFingerprint, name: pending.name,
      roomId: approval.roomId, scopes: approved, generation: ++this.generation, status: 'active',
    };
    this.known.set(active.publicKeyFingerprint, { deviceId: active.deviceId, publicKeyFingerprint: active.publicKeyFingerprint, ceiling: [...approved], active });
    this.invalidateEnrollment(active.publicKeyFingerprint);
    return structuredClone(active);
  }
  getActiveByFingerprint(fingerprint: string): HardwareActiveIdentity | undefined {
    const active = this.known.get(fingerprint)?.active;
    return active ? structuredClone(active) : undefined;
  }
  private invalidateEnrollment(fingerprint: string): void {
    for (const [id, value] of this.pending) if (value.publicKeyFingerprint === fingerprint) this.pending.delete(id);
    for (const [id, value] of this.challenges) if (value.challenge.publicKeyFingerprint === fingerprint) this.challenges.delete(id);
  }
  revoke(deviceId: string): boolean {
    const known = [...this.known.values()].find(value => value.deviceId === deviceId);
    if (!known) {
      const pending = [...this.pending.values()].find(value => value.deviceId === deviceId);
      const challenge = [...this.challenges.values()].find(value => `hardware-${value.challenge.publicKeyFingerprint}` === deviceId);
      const fingerprint = pending?.publicKeyFingerprint ?? challenge?.challenge.publicKeyFingerprint;
      if (!fingerprint) return false;
      this.invalidateEnrollment(fingerprint);
      ++this.generation;
      return true;
    }
    this.invalidateEnrollment(known.publicKeyFingerprint);
    const wasActive = Boolean(known.active);
    delete known.active;
    ++this.generation;
    return wasActive;
  }
  list(): (HardwareActiveIdentity | HardwarePendingIdentity)[] {
    this.sweep();
    return structuredClone([...this.pending.values(), ...[...this.known.values()].flatMap(value => value.active ? [value.active] : [])]);
  }
  clear(): void {
    this.tickets.clear(); this.challenges.clear(); this.pending.clear(); this.known.clear();
    // Preserve the generation counter to prevent an old transport session becoming valid again.
    ++this.generation;
  }
}

export const hardwarePublicKeyFingerprint = fingerprintHardwarePublicKey;
export const hardwarePairingProofBytes = hardwarePairingSigningBytes;
