# Hardware connection foundation: isolated loopback test mode

This is an offline-verifiable foundation for the P0 hardware identity/pairing and authenticated transport work. It is not a production pairing service, firmware, cloud Bridge, LAN listener or completed real-hardware integration.

## What is implemented

- `HardwareIdentityRegistry`: process-local Ed25519 public-key identities, high-entropy one-use tickets, connection-bound proof of key possession, pending local approval, limited purpose scopes, revocation and monotonically changing generations.
- `HardwareLoopbackBridge`: default-disabled Node TLS 1.3 server. The only enabled mode is explicitly named `ephemeral-loopback-test`; it binds only `127.0.0.1` on an OS-assigned random port. It requires injected test server/client CA material and mutually authenticated clients. There is no LAN bind option, production mode, certificate issuer or credential persistence.
- `HardwareVirtualTerminal`: a synthetic Node client that verifies the test CA, hostname and exact server-certificate fingerprint. It never opens a microphone, speaker, USB/BLE device or native permission prompt. It sends supplied synthetic PCM through the existing voice protocol.
- The Bridge creates ordinary `VoiceTerminalBroker` sessions from authenticated certificate identities. It receives only fixed pairing, hello and voice-packet messages. It has no shell, arbitrary URL, device command, grant mutation or administrator RPC.

The modules are not automatically instantiated by Pulse Host startup or its existing H5 management routes. Existing phone/Web pairing remains a different security domain. This deliberate boundary prevents test enrollment from becoming production access.

## Trust and approval sequence

1. A trusted test operator constructs `HardwareIdentityRegistry({ hostId, temporaryTestOnly: true })`. Other modes are rejected. Nothing is loaded from disk.
2. The test operator supplies isolated temporary TLS server/client certificates and a test CA. Tests create these in a private temporary directory, delete them on normal cleanup, and never install the CA in the OS trust store. This is test PKI, not a household account or production credential.
3. A synthetic terminal verifies the pinned test Host and connects with its client certificate. The Bridge verifies that certificate against the injected test CA and extracts the public key from the verified certificate. Self-reported identity fields cannot replace it.
4. Only the trusted test control plane calls `createTicket()`. The raw ticket is returned once; the registry keeps its SHA-256 digest and expiration. The device presents it only over the pinned, mutually authenticated test TLS channel.
5. `beginPairing` burns the ticket and creates a challenge bound to the Host ID, random nonce, public-key fingerprint, requested scopes, expiration and this connection. The terminal signs the fixed, domain-separated challenge bytes with its temporary Ed25519 private key.
6. `completePairing` consumes the challenge and verifies the proof. Success creates a pending record, not permission. It does not create a certificate, save a token or grant control.
7. Only trusted code calls `bridge.approvePairing(pending.requestId, { roomId, scopes })`. There is deliberately no network approval message. The approved room and purposes come from the Host, never hello or a device name. A real UI/control-plane implementation remains future work requiring explicit authorization for persistent access.
8. The Bridge uses that approved identity to register and open a voice session. Every packet checks the active identity generation. ASR completion and admission check it again, so revocation does not rely on the next timer sweep. A new session starts reported-muted. Button and wake permissions remain distinct.
9. `revoke` invalidates active enrollment and in-flight enrollment, closes connected voice sessions and discards late transcripts before submission. A new pairing still needs a new ticket, proof and Host approval. It cannot silently expand the previously approved purpose ceiling.

Default limits are 60-second tickets, 30-second challenges, 120-second pending approval, 128 identity entries and 30 enrollment operations per minute. Records and authorization disappear when the registry is cleared or its process exits. Revocation/clear never reuse a previous generation.

## Separate kinds of permission

The kernel currently recognizes only `voice.button`, `voice.wake` and `telemetry.read`. The transport implements the voice path; telemetry is reserved for a future finite read-only protocol and currently supplies no extra RPC. These scopes do not authorize a lamp, thermostat, security system or administrator action.

A voice identity permits only the approved input path. The injected `submit` callback must route to ordinary authenticated assistant admission and the existing external-tool/device-grant approval boundary. The sample uses a deterministic callback, not a model or cloud service. Its synthetic transcript does not execute a device action.

Device metadata is untrusted display data. The Bridge derives stable device IDs from authenticated public keys and uses Host-approved rooms. Existing `VoiceTerminalBroker` sequence, capture replay, mute, ASR concurrency and playback-backpressure checks remain in force. Stop-playback never cancels a device action or a background task.

## Transport and recovery limits

- At most eight connections by default, including pre-handshake peers; no broad address/port configuration.
- Client frames are newline-delimited strict JSON, limited to 64 KiB, 16 outstanding requests, 200 frames per second and 4096 distinct request IDs per connection. Unknown fields/messages are rejected rather than forwarded.
- Session takeover is rejected. Reconnect creates a new voice session; old packets, audio and playback are not resumed or replayed.
- Identity generation is rechecked per packet, after asynchronous transcription and immediately before ordinary admission. Revocation, room changes, registry clear and disconnect invalidate pending voice input.
- Failed or timed-out submission remains unknown, with no automatic retry. A disconnect cannot undo a task that admission already accepted.
- Outbound queues and retained client diagnostics are bounded. Automatic replies are separately disabled by default. A trusted test Host must opt in and the session must negotiate `replyProtocolVersion: 1`; this selects a format, not additional permissions.
- Optional reply delivery follows the flat ordinary-admission receipt, exact original request/run and completed final assistant messages, excluding `pre_reply`. Only the trusted Host callback can read `/api/assistant` or request `/api/voice/speech`; terminals cannot choose URLs, principals or providers.
- Final text and bounded WAV chunks return only to their original authenticated device/room/session/generation. Mute, a newer turn, disconnect or revocation isolates pending output. Already-admitted assistant/device work is not cancelled by stopping audio.
- At most two chunks remain sent but unacknowledged. A chunk ACK means received; separate reports mean started, completed or error. Completed requires started and all chunk ACKs. These are terminal reports, not physical/acoustic evidence. Missing or uncertain delivery becomes unknown and is never replayed on reconnect.
- Outstanding Host callbacks remain capacity-accounted until they actually settle, even after abort/timeout. Bridge cleanup reports an error if either coordinator or Host transport callbacks remain unconfirmed.
- `close()` destroys owned sockets and waits for server closure; an unconfirmed cleanup is an error. It never silently declares a listener stopped.

## Running the offline evidence

Run:

`pnpm exec vitest run tests/device-use-hardware-identity.test.ts tests/device-use-hardware-bridge.test.ts`

The socket tests require a local OpenSSL executable to create temporary test PKI. If it is unavailable those socket tests are explicitly skipped, not counted as a transport pass. No package, service, root certificate or OS trust is installed.

`examples/hardware-loopback.ts` provides an importable developer sample with injected temporary test credentials. Importing it has no side effects. The tests exercise the same full chain: certificate authentication → one-use ticket → proof → pending approval → trusted approval → fresh voice session → synthetic PCM → mock ASR → ordinary-admission callback.

Covered negative cases include wrong server pin, untrusted client CA, ticket replay, proof on another connection, network approval attempts, self-reported device/room overrides, muted/wake restrictions, concurrent session takeover, old session replay, mute and revocation during ASR, ambiguous submission, oversized frames, idle closure, playback acknowledgments and shutdown cleanup.

## Authorization boundary and remaining work

This change does not create persistent Host/device credentials, pair a real device, open a LAN/public listener, modify a firewall, install certificates, connect an account, activate real audio or grant control of any household device.

Production use must stop at a clear user-approved setup step before creating persistent keys/certificates, adding trusted hardware, enabling network exposure or widening access. It still needs an authenticated local management UI, approved credential storage/provider, production certificate provisioning and rotation, platform permission handling, network discovery policy and the actual firmware/transport acceptance. Do not repurpose the test-only mode or auto-approve device requests to bypass that work.

The reply loop is exercised only with injected Host responses, synthetic WAV/PCM and the authenticated test loopback. It does not activate an automatic production listener or claim model-provider or physical speaker acceptance.

Real microphone/speaker routing, physical disconnect/mute, wake-word/AEC performance, battery behavior and deep-sleep recovery require actual selected hardware. The loopback pass establishes software protocol behavior only.

## Correlated terminal reply evidence

Run `pnpm exec vitest run tests/device-use-terminal-turns.test.ts tests/device-use-terminal-replies.test.ts tests/device-use-terminal-host-reply.test.ts tests/device-use-terminal-reply-loopback.test.ts` for receipt lifecycle, bounded asynchronous delivery, exact Host final selection and the temporary-mTLS synthetic end-to-end loop. The virtual terminal exposes explicit synthetic ACK/status helpers; it does not auto-report physical playback.

## Local simulated terminal diagnostics

Settings > Device Use includes a separately default-disabled synthetic terminal diagnostic panel. Enabling it creates no listener, certificate, pairing record, microphone/speaker, model request, assistant task or device adapter. It runs only fixed in-process `VoiceTerminalBroker` scenarios: completed playback, missing-playback-receipt timeout, and a controlled ASR callback which ignores cancellation. No arbitrary text, audio, endpoint, identity or grant is accepted.

The local-admin-only `/api/device-use/terminal-diagnostics` route uses same-origin mutation checks and no-store responses. The snapshot contains bounded stage/timing records and counts, not transcript text, audio, credentials or raw errors. Remote/paired browser sessions cannot access it. Running a scenario requires explicit enablement; requests while another scenario is busy are rejected, not queued or replayed. Opening the page only reads the disabled status.

The panel distinguishes sent, received, started, completed, failed and unknown; terminal reports remain synthetic evidence, never acoustic proof. The quarantine scenario closes its virtual session but intentionally retains one pending callback, so cleanup stays unconfirmed. Only releasing the owned synthetic callback allows cleanup to complete. Disablement and server shutdown release only this diagnostic service's controlled callbacks and close its own session; they do not alter normal voice settings, Device Use grants, household commands or real tasks. State is in memory and resets on restart.

Run `pnpm exec vitest run tests/device-use-terminal-diagnostics.test.ts tests/device-use-terminal-diagnostics-http.test.ts` and the web `terminal-diagnostics.test.tsx` suite for these boundaries. This is a developer/user diagnostic simulation, not production hardware enrollment or real microphone/speaker acceptance.
