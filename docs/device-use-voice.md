# Device Use voice terminal and audio routing

Implementation boundary, 2026-11-09 local Mac time (2026-11-08 UTC).

## Desktop audio

`DeviceVoiceController` extends the current `VoiceController`; the existing wake, speaker matching, ASR, TTS and background assistant queue remain in that controller. The desktop entry imports the extension. Existing uncommitted changes in `controller.mjs`, `engine.mjs` and `worker.mjs` are not replaced.

Voice settings save `microphoneId` and `speakerId` independently. An old config without `speakerId` uses system default. The device refresh action enumerates inputs/outputs in a short-lived hidden audio window without opening a microphone, downloading models or starting inference. Device names may be blank until OS/browser permissions have already been granted. Refresh does not grant them.

Every playback chunk binds a non-default output with `HTMLMediaElement.setSinkId` before `play`. Unsupported routing, rejection and missing selected devices stop playback; the application does not intentionally substitute another speaker. Output-only changes invalidate old playback without reopening capture. Hardware/OS routing behavior still needs an actual unplug test.

Audio `devicechange` refreshes availability. Selected-output loss discards queued playback. Reconnection allows future speech and never resumes an interrupted reply. A lost microphone retains the existing explicit “恢复收听” behavior instead of repeatedly requesting permission. Device refresh can be used before background wake is enabled.

Selected-output preview is played in a short-lived window using the same audio partition and file origin as background audio. Media device IDs are origin/partition scoped, so the main UI must not directly use the audio host's selected ID. Preview creates no capture and cannot submit an assistant message. Closing, stopping or timeout destroys its window. Default-output preview retains the existing UI player.

## Voice terminal SDK boundary

`packages/server/src/device-use/voice-terminal.ts` implements an **in-process protocol engine**, not a network listener, pairing service, firmware, ESPHome integration or hardware driver. Import `VoiceTerminalBroker`, `voiceTerminalHostIO` and the hello/packet schemas. The caller owns an authenticated encrypted transport and explicit enrollment. No credentials, pairing permissions or new persistent access are created here.

1. A trusted host enrolls a stable device/room using `register({ deviceId, roomId, allowButton, allowWake })`. Discovery is not enrollment. Replacing a grant closes an old session. Revocation invalidates the session and pending capture.
2. The authenticated transport passes a verified `VoiceTerminalIdentity` to `open(principal, hello)`. Identity must come from transport authentication, **never** from terminal-provided hello. Version 1 supports mono 16 kHz PCM signed 16-bit little endian input. Unsupported versions/formats are rejected. Concurrent session takeover is rejected.
3. The host returns a fresh random session ID and `nextSequence: 0`. Packets bind version, stable device, room, session and increasing sequence. Duplicate packets are ignored. A sequence gap invalidates buffered capture and asks for resynchronization. Reconnect uses a new session and never replays old audio, output or commands.
4. A fresh session starts muted. A status event reports `muted`, `light` and optional battery percentage. These are device reports, not proof of a physical electrical mute. The snapshot always says `physicalMuteVerified: false`.
5. Button or wake starts a capture only within its explicit grant. Capture IDs cannot be reused within a session. Audio frames have their own strict sequence, canonical base64 and maximum 500 ms per frame. Capture is bounded to at most 30 seconds/960 kB PCM. Session capture IDs, enrollment and concurrent ASR are bounded. Heartbeats keep a session fresh; default idle expiry is 15 seconds. The host must call `sweep()` periodically or inspect snapshots, and must close the session when transport disconnects.
6. Capture end converts transient PCM into WAV and uses the injected ASR callback. No recording is persisted. Mute, disconnect, revocation, another turn or expired presence invalidates late ASR before submission. ASR receives an optional cooperative `AbortSignal`. Mute, disconnect, revocation, resynchronization or a new capture aborts the old wait immediately. The default transcription deadline is 60 seconds (`transcriptionTimeoutMs`, 1–180,000 ms). Late results never submit. The four-slot bound counts the underlying callback until its promise actually settles: ignored cancellation remains quarantined, appears as `transcriptionPending` / `transcriptionQuarantined` in snapshots, and a full bound reports `VOICE_TERMINAL_ASR_UNAVAILABLE` instead of starting more work. Timeout is reported explicitly. A promise settling after a transport abort proves only that local callback ended, not that a remote provider stopped computing or deleted audio. Remote cancellation needs its own adapter guarantee; the broker never claims it.
7. The supplied `voiceTerminalHostIO` uses `/api/voice/transcribe` and the ordinary `/api/assistant/messages` admission path with `delivery: immediate`, `inputMode: voice`, and an idempotent request ID. It provides no shell, raw device service, URL or MQTT passthrough. Room metadata is supplied to custom host callbacks but is not silently injected as executable instructions or assumed device authorization.
8. Submission is `submitted` only after the ordinary queue callback returns. A failed/ambiguous submit is `unknown`, never an automatic retry. Once submitted, stopping playback or disconnecting cannot undo the assistant/device task. Persistent outcome inspection remains the ordinary assistant queue's responsibility.
9. Outbound `play` uses explicit playback IDs, contiguous audio chunk sequences and at most two unacknowledged chunks. Transport send means `sent`; terminal acknowledgments are still terminal reports, not acoustic proof. A stop clears only playback, not assistant/device tasks. Reconnect does not resume output.

Input capture and output playback channels are separate from DeviceBroker commands. A voice grant does not authorize controlling a lamp or thermostat. Device actions still need normal tool permissions and device-specific authorization.

## Optional correlated terminal replies

Automatic terminal replies are disabled by default. A trusted caller must provide reply/synthesis callbacks, set `enableReplies: true`, and the authenticated session must negotiate `replyProtocolVersion: 1`. The selected protocol does not add device-control or administrator permissions. `createVoiceTerminalReplyHostIO` reuses the fixed authenticated Host routes and the flat ordinary-admission receipt; it follows only the exact original request/run and its completed final messages, excluding pre-replies.

Request IDs contain the session and a stable SHA-256 digest of the capture ID, staying within the ordinary H5 128-character limit even when the capture ID reaches its own 128-character maximum. The original capture ID remains correlation metadata. An observed admission receipt is tracked separately from reply delivery: an interrupted or ambiguous admission is unknown, even when audio delivery was superseded.

Final text and bounded WAV chunks return only to the original device/room/session/generation. Chunk ACK means received; distinct authenticated reports mean started, completed or error. Completion requires started plus all chunk ACKs. These are terminal reports, not proof of physical playback. Missing or uncertain delivery is not replayed. Mute, a newer capture, revocation or disconnect isolates late output without cancelling already-admitted assistant/device tasks. Abort/timeout does not release uncooperative callbacks until they actually settle, and cleanup reports unconfirmed ASR/reply/Host requests.

The H5 integration tests run the real local HTTP authentication, assistant inbox, model runtime, approval endpoints and final-message projections. Only model/audio providers are synthetic; test identities and PKI are temporary. Approval denial produces a failed ordinary assistant receipt with no device command or synthesized success. Approved actions still recheck the current device grant immediately before dispatch. These tests do not enable a production terminal service or exercise a real model/audio account.

Run `pnpm exec vitest run tests/device-use-terminal-h5-approval.test.ts tests/device-use-terminal-h5-lifecycle.test.ts` for the actual-H5 synthetic chain.

## Verified and still pending

Automated tests use synthetic PCM, fake media devices, fake IPC and a fake authenticated transport. They exercise packet deduplication/gaps, replay, reconnect, mute/revoke during ASR, unknown submission, time limits, backpressure, route-before-play, output loss/recovery, unsupported sinks and cancellation during sink setup. Existing voice/controller/service and web interaction suites are run separately.

Not performed: real USB/Bluetooth/Wi-Fi connection, pairing, firmware flashing, service installation, settings/permission changes, hardware purchasing, speaker/microphone activation, electrical mute measurement, acoustic echo/television/false-wake testing, battery/抢连, far-field room performance, long-duration standby, deep sleep/clamshell wake or unlock. These require selected physical devices and their own acceptance evidence. Software status and protocol simulation do not establish these claims.
