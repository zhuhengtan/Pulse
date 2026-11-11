import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { HardwareIdentityRegistry, hardwarePairingProofBytes, hardwarePublicKeyFingerprint, type HardwareIdentityScope, type HardwarePairingChallenge } from '../packages/server/src/device-use/hardware-identity.js';

function fixture(options: Partial<ConstructorParameters<typeof HardwareIdentityRegistry>[0]> = {}) {
  const registry = new HardwareIdentityRegistry({ hostId: 'test-host', temporaryTestOnly: true, maxAttemptsPerWindow: 1000, ...options });
  const keys = generateKeyPairSync('ed25519');
  const publicKeyPem = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const fingerprint = hardwarePublicKeyFingerprint(publicKeyPem);
  const binding = 'temporary-test-transport';
  const begin = (requestedScopes: HardwareIdentityScope[] = ['voice.button']) => registry.beginPairing({ ticket: registry.createTicket().ticket, publicKeyPem, name: 'fixture', requestedScopes, connectionBinding: binding });
  const proof = (challenge: HardwarePairingChallenge, connectionBinding = binding) => ({ challengeId: challenge.challengeId, connectionBinding, signature: sign(null, hardwarePairingProofBytes(challenge), keys.privateKey).toString('base64url') });
  const pending = () => registry.completePairing(proof(begin()));
  const activate = () => registry.approvePending(pending().requestId, { roomId: 'trusted-room', scopes: ['voice.button'] });
  return { registry, keys, publicKeyPem, fingerprint, binding, begin, proof, pending, activate };
}

describe('temporary hardware identity registry', () => {
  it('requires explicit temporary test mode', () => {
    expect(() => new HardwareIdentityRegistry({ hostId: 'host' } as never)).toThrow('temporary');
  });
  it('keeps possession proof pending until trusted host approval and derives identity from SPKI', () => {
    const f = fixture();
    const challenge = f.begin();
    expect(challenge.hostId).toBe('test-host');
    expect(challenge.publicKeyFingerprint).toBe(f.fingerprint);
    const pending = f.registry.completePairing(f.proof(challenge));
    expect(f.registry.getActiveByFingerprint(f.fingerprint)).toBeUndefined();
    const active = f.registry.approvePending(pending.requestId, { roomId: 'host-selected', scopes: ['voice.button'] });
    expect(active.deviceId).toBe(`hardware-${f.fingerprint}`);
    expect(active.roomId).toBe('host-selected');
    expect(active.generation).toBeGreaterThan(0);
    expect(f.registry.getActiveByFingerprint(f.fingerprint)).toEqual(active);
    expect(() => f.registry.approvePending(pending.requestId, { roomId: 'evil', scopes: ['voice.button'] })).toThrow();
  });
  it('restricts approved room IDs to the voice terminal identity grammar', () => {
    for (const roomId of ['', ' ', 'room with spaces', '../room/path', '房间', 'room\n', 'x'.repeat(129)]) {
      const f = fixture(); const pending = f.pending();
      expect(() => f.registry.approvePending(pending.requestId, { roomId, scopes: ['voice.button'] })).toThrow('roomId');
      expect(f.registry.getActiveByFingerprint(f.fingerprint)).toBeUndefined();
    }
    const f = fixture();
    expect(f.registry.approvePending(f.pending().requestId, { roomId: 'Room_1.floor:west-wing', scopes: ['voice.button'] }).roomId).toBe('Room_1.floor:west-wing');
  });
  it('consumes tickets and proofs once, including failed attempts', () => {
    const f = fixture();
    const ticket = f.registry.createTicket().ticket;
    const input = { ticket, publicKeyPem: f.publicKeyPem, name: 'test', requestedScopes: ['voice.button'] as HardwareIdentityScope[], connectionBinding: f.binding };
    const challenge = f.registry.beginPairing(input);
    expect(() => f.registry.beginPairing(input)).toThrow('ticket');
    const proof = f.proof(challenge);
    f.registry.completePairing(proof);
    expect(() => f.registry.completePairing(proof)).toThrow('challenge');
    const other = f.begin();
    expect(() => f.registry.completePairing({ ...f.proof(other), signature: 'invalid' })).toThrow();
    expect(() => f.registry.completePairing(f.proof(other))).toThrow('challenge');
  });
  it('binds proof to transport, host, nonce, key and scopes', () => {
    for (const mutate of [
      (c: HardwarePairingChallenge) => { c.hostId = 'other'; },
      (c: HardwarePairingChallenge) => { c.nonce = 'other'; },
      (c: HardwarePairingChallenge) => { c.publicKeyFingerprint = 'other'; },
      (c: HardwarePairingChallenge) => { c.requestedScopes = ['voice.wake']; },
    ]) {
      const f = fixture(); const challenge = f.begin(); mutate(challenge);
      expect(() => f.registry.completePairing(f.proof(challenge))).toThrow('proof');
    }
    const f = fixture(); const challenge = f.begin();
    expect(() => f.registry.completePairing(f.proof(challenge, 'different-connection'))).toThrow('binding');
  });
  it('rejects signatures from another temporary key', () => {
    const f = fixture(); const challenge = f.begin();
    const wrong = generateKeyPairSync('ed25519');
    expect(() => f.registry.completePairing({ ...f.proof(challenge), signature: sign(null, hardwarePairingProofBytes(challenge), wrong.privateKey).toString('base64url') })).toThrow('proof');
  });
  it('expires ticket, challenge and pending request at their deadlines', () => {
    let now = 1000;
    const f = fixture({ now: () => now, ticketTtlMs: 10, challengeTtlMs: 10, pendingTtlMs: 10 });
    const ticket = f.registry.createTicket().ticket; now += 10;
    expect(() => f.registry.beginPairing({ ticket, publicKeyPem: f.publicKeyPem, name: 'test', requestedScopes: ['voice.button'], connectionBinding: f.binding })).toThrow('ticket');
    const challenge = f.begin(); now += 10;
    expect(() => f.registry.completePairing(f.proof(challenge))).toThrow('challenge');
    const pending = f.pending(); now += 10;
    expect(() => f.registry.approvePending(pending.requestId, { roomId: 'room', scopes: ['voice.button'] })).toThrow('pending');
  });
  it('rejects dangerous and unrequested scopes and keeps re-pairing within prior grants', () => {
    const f = fixture();
    for (const scope of ['admin', 'shell', 'actuator.execute']) expect(() => f.begin([scope as HardwareIdentityScope])).toThrow('scopes');
    const p = f.pending();
    expect(() => f.registry.approvePending(p.requestId, { roomId: 'room', scopes: ['voice.wake'] })).toThrow('expand');
    f.activate();
    expect(() => f.begin(['voice.button', 'voice.wake'])).toThrow('expand');
    f.registry.revoke(`hardware-${f.fingerprint}`);
    expect(() => f.begin(['voice.wake'])).toThrow('expand');
  });
  it('revokes sessions and in-flight pairing, and generates a fresh generation on re-pair', () => {
    const f = fixture(); const first = f.activate();
    const pending = f.pending(); const challenge = f.begin();
    expect(f.registry.revoke(first.deviceId)).toBe(true);
    expect(f.registry.getActiveByFingerprint(f.fingerprint)).toBeUndefined();
    expect(() => f.registry.approvePending(pending.requestId, { roomId: 'room', scopes: ['voice.button'] })).toThrow();
    expect(() => f.registry.completePairing(f.proof(challenge))).toThrow();
    const second = f.activate();
    expect(second.generation).toBeGreaterThan(first.generation);
    f.registry.clear();
    expect(f.registry.list()).toEqual([]);
    expect(f.activate().generation).toBeGreaterThan(second.generation);
  });
  it('can revoke a pending-only device before its first approval', () => {
    const f = fixture(); const pending = f.pending();
    expect(f.registry.revoke(pending.deviceId)).toBe(true);
    expect(() => f.registry.approvePending(pending.requestId, { roomId: 'room', scopes: ['voice.button'] })).toThrow();
  });
  it('invalidates sibling pending approvals and isolates returned object mutations', () => {
    const f = fixture(); const p1 = f.pending(); const p2 = f.pending();
    const active = f.registry.approvePending(p1.requestId, { roomId: 'room', scopes: ['voice.button'] });
    active.scopes.push('voice.wake');
    const lookup = f.registry.getActiveByFingerprint(f.fingerprint)!; lookup.roomId = 'tampered';
    expect(f.registry.getActiveByFingerprint(f.fingerprint)?.scopes).toEqual(['voice.button']);
    expect(f.registry.getActiveByFingerprint(f.fingerprint)?.roomId).toBe('room');
    expect(() => f.registry.approvePending(p2.requestId, { roomId: 'room', scopes: ['voice.button'] })).toThrow();
  });
  it('bounds capacity, attempts and TTL without revealing tickets in list', () => {
    const f = fixture({ maxEntries: 1 }); const ticket = f.registry.createTicket().ticket;
    expect(JSON.stringify(f.registry.list())).not.toContain(ticket);
    expect(() => f.registry.createTicket()).toThrow('capacity');
    const limited = fixture({ maxAttemptsPerWindow: 1 }); limited.registry.createTicket();
    expect(() => limited.registry.createTicket()).toThrow('rate limit');
    expect(() => fixture().registry.createTicket({ ttlMs: 1e9 })).toThrow('TTL');
  });
  it('accepts only SPKI Ed25519 public keys, never private keys', () => {
    const f = fixture();
    const privatePem = f.keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    expect(() => hardwarePublicKeyFingerprint(privatePem)).toThrow('SPKI');
    const ec = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    expect(() => hardwarePublicKeyFingerprint(ec.publicKey.export({ type: 'spki', format: 'pem' }).toString())).toThrow('Ed25519');
  });
});
