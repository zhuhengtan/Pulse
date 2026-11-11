# Device Use

Device Use is an opt-in, host-installed CapabilityPack. It discovers devices, applies host-issued per-device/per-action grants, writes command receipts and confirms fresh target state. No real household account, gateway, credential, physical device, public endpoint or hardware deployment is configured by this implementation.

## Implemented boundaries

- `DeviceRegistry`: stable identity, room and aliases, capabilities, observations, explicit enrollment and expiring grants. Discovery does not enroll a device or authorize control. Ambiguous names fail rather than choosing one.
- `DeviceBroker`: one shared trusted Host, per-device serialization across tasks and Broker instances, independent-device concurrency, expected-version checks, durable request deduplication and command timelines. The ledger rejects a second living OS process. Do not run multiple independent device Hosts against the same home; there is no distributed device lock.
- `DeviceStore`: strict versioned JSON ledger, same-directory atomic replacement, fsync, private new files (0600) and directories (0700), process-owner recovery after a dead process. Existing parent directories must already be trusted and private. Invalid/corrupt state fails closed. A stale recovery marker requires operator inspection; it is not silently stolen.
- `createDeviceCapabilityPack`: seven finite tools, using the existing Tool Effect path. No model tool can grant permission, install adapters, read credentials, call arbitrary services, publish arbitrary MQTT topics, run shell or choose URLs. Register a host-owned Broker with the existing CapabilityPackRegistry. Installing the code alone does not enable it in every session.
- `SimulatedDeviceAdapter`: virtual light, temperature sensor and thermostat; injectable refusal, stale/offline state, unchanged target, send timeout and disconnect-after-send. This is explicitly a simulator, not hardware support.
- Home Assistant adapter and bounded event gateway: see the adapter section below.
- Voice-terminal protocol: a separate trusted transport callback API. It is not an authenticated network server, firmware, microphone driver or physical mute implementation.

## Local settings

The local Settings > Device Use page is the supported enrollment entry point. It starts disabled. Enable the simulator, discover its devices, enroll the lamp with its room/aliases, then issue a bounded, expiring power/brightness grant. The command history distinguishes accepted, attempted, observed and unknown receipts. Disabling invalidates old tool epochs and revokes control grants; it does not claim that a previously sent physical action stopped.

Local management APIs require the trusted local-admin session and same-origin mutation checks. Paired/remote clients cannot enroll, grant, connect a gateway or read these management records. The Home Assistant form explicitly hands over an in-memory token and exact entity allowlist; the token is cleared from the form and is not saved or supplied to the model. Real setup remains a user action, not an automatic connection made by this implementation.

Private durable storage currently fails closed on Windows until a Windows ACL implementation is provided. `DeviceStore` rejects both reads and writes before filesystem access, including ownership claims; temporary paths do not bypass this boundary. POSIX file-mode checks are not treated as Windows ACL evidence.

## Trusted host setup

The runnable TypeScript example is `examples/device-use.ts`. Build the workspace first, then run it with a TypeScript runner if available, or compile it as part of your host application. It only uses the simulator and a temporary private ledger. A persistent simulator Host must hydrate its recreated adapter from raw ledger device records before rediscovery; list projections include extra UI fields and are deliberately not accepted by the strict hydration schema.

Host integration must create one shared Broker for its lifetime, call `recover()` before admitting new device work, register adapters, and explicitly enable the `device` pack for the relevant task/session. Use a stable host-bound principal; never let model input select the principal. The existing Host tool execution and approval policy still apply to external tools.

Only trusted settings/enrollment UI or an authenticated host API may call `registry.enroll`, `registry.grant`, `registry.revoke` or `registry.registerScene`. They are deliberately not model tools. Show the concrete device, action, parameter limits, expiry and any required confirmation to the user. An authorizationRef is a reference to an existing scoped grant, not permission by itself.

A grant can require action confirmation. `DeviceBrokerOptions.confirm` must verify an action-bound host approval and return false unless approval is valid. It must not return a model-provided boolean. The Broker checks authorization again after this callback and atomically with its dispatch journal transition.

Do not put tokens, account identifiers, gateway secrets or raw adapter errors into device metadata or model context. Supply credentials to the adapter through trusted host callbacks. Real account connections and persistent credentials need their own authorization.

## Command contract

`device.set` takes requestId, stable deviceId, desiredState, optional expectedVersion, deadline (epoch milliseconds) and authorizationRef. The Host binds principal. Writable target fields are power, brightness (0–100), targetTemperatureC, mode and fanMode, further restricted by the actual device capability and grant. Temperature readings are never writable. Device modes and fan modes must come from the actual capability; the model cannot invent them. No toggle action exists.

Use the exact same requestId and payload for a retry. A changed payload with the same principal/requestId fails with `DEVICE_REQUEST_ID_CONFLICT`. A duplicate returns the original receipt, including an in-progress accepted receipt, without sending again. Host retries do not create a new requestId to get around an unknown result.

States:

- accepted: durably queued, not proven sent.
- sent: the write-ahead dispatch attempt was committed; this alone does not prove that the device moved.
- observed: a fresh, online observation from the adapter matches the target and is at or after dispatch. Evidence includes source, timestamp, version and state. This proves reported target state, not independent physical measurement.
- failed: known pre-dispatch failure or explicit adapter rejection.
- unknown: delivery/confirmation is uncertain. A network error after dispatch, timeout, non-confirmable action or an unchanged gateway state does not become success.
- cancelled/expired: known unsent work only. Cancelling playback is separate from stopping device actions. An attempted command cannot be called safely stopped.

Dispatch grants and deadlines are rechecked after queued waits, fresh reads and confirmation. A prior unresolved sent/unknown command on the same device blocks a new action until fresh read-only reconciliation resolves it. In-flight adapter calls are also tracked, so timing out a promise does not permit a conflicting action to race a late dispatch.

A restart marks accepted work cancelled and dispatched work unknown, without resending. Call `reconcile` to read state, never to retransmit. Automatically retrying unknown commands is unsupported. Broker cancellation only cancels known accepted work; it does not claim physical cancellation after send.

`device.scene.run` only runs registered scenes. It returns per-device commands, any pre-acceptance failures, and `atomic: false`. A request conflict on one step does not hide receipts from independently completed siblings. Partial failure is retained, and no implicit rollback or compensation occurs. `device.wait` is bounded to two minutes; long-lived sensor automations need a separately authorized persistent host rule system, not an immortal Lane.

## Task worker boundary

Task workers never create a DeviceStore, recover a ledger, hold gateway credentials or connect an adapter. After admission, the parent captures the finite tool manifests and the current settings epoch, then exposes a private per-child/per-Run IPC executor. The actual worker bootstrap installs remote Tool Effects that call this executor. Device actions still execute through the shared parent Broker.

Both ends validate the seven fixed tool names and structured inputs. A worker cannot request grant/enrollment mutation, a principal override, an arbitrary service or URL. Requests are capped at 64 KiB, results at 256 KiB, in-flight calls at 32 and seen request IDs at 4096 per Run. A random IPC session and exact Run binding reject cross-session messages. Duplicate requests never execute again. Cancellation, timeout or disconnect aborts the parent request and returns uncertainty, without automatic replay. An RPC abort does not prove physical cancellation; the Broker retains dispatch receipts and unresolved in-flight device quarantine. Changing settings invalidates old worker epochs.

## Home Assistant

`HomeAssistantAdapter` uses fixed REST state routes and restricted light target-state calls. Host configuration supplies an exact entity allowlist and explicit write flags; defaults are read-only. Temperature and climate capabilities are currently read-only. Actual climate control, Xiaomi and Midea model compatibility have not been claimed or validated.

HA Core 2026.11 and later include `temperature_unit` in climate state attributes. This is the unit of the displayed state values, matching HA's configured unit system, not the device's native unit. The adapter automatically converts explicitly marked `°C`/`°F` values from the existing allowlisted state response to Celsius without another API request. The integration-side `native_` property renames do not rename the REST state fields `current_temperature` and `temperature`.

Legacy climate states before Core 2026.11 can omit the marker. For those states, Local Settings > Device Use offers an explicit, gateway-scoped Celsius/Fahrenheit choice; embedded trusted hosts can supply `HomeAssistantOptions.climateTemperatureUnit`. Leave the choice unknown unless the gateway's displayed system unit has been verified. Without a known unit, or with an invalid/conflicting marker, the adapter omits both Celsius temperature values and the climate capability's unit claim; it still exposes non-temperature read-only state such as mode. It never guesses from locale or numeric magnitude and never calls `get_config` or `/api/config`. The host assertion is not a model tool and cannot create a device grant. Climate writes remain disabled.

Version reference: [HA Core 2026.11 climate temperature unit change](https://contributors.home-assistant.io/blog/2026/10/08/climate-native-temperature/).

Use HTTPS except explicitly authorized LAN HTTP. Do not expose the gateway or LAN devices publicly. A host-only token callback supplies authentication. `startEvents()` is an explicit connection operation; constructing the adapter does not connect a real account.

Event subscription uses HA's server-filtered `subscribe_entities` command with the exact, nonempty `entity_ids` allowlist. It never uses the household-wide `subscribe_events`/`state_changed` subscription. An unsupported/rejected scoped subscription closes the connection with no broader fallback. A server response containing another entity also closes the connection without fetching that entity. These request limits do not narrow the HA account/token's underlying permissions: configure the HA account with minimum permissions and retain Pulse's per-device/per-action grants.

After the scoped subscription is acknowledged, the adapter snapshots only the allowed entities through their fixed REST state routes. Compressed additions/changes (`a`/`c`) are bounded refresh hints for those same routes, not directly trusted state or executable content. Removal (`r`), disconnect and queue overflow invalidate fresh event reads and mark cached availability unavailable until a new snapshot. Restart `startEvents()` after a disconnect to resynchronize. The bounded gateway deduplicates observations and rejects old revisions; HA's original state timestamps and microsecond revisions remain the observation evidence. Refer to the adapter's exported option types for supported transport and policy hooks.

Protocol reference: [HA WebSocket API](https://contributors.home-assistant.io/core/internals/websocket-api/) and [HA server-side subscription implementation](https://github.com/home-assistant/core/blob/dev/homeassistant/components/websocket_api/commands.py). Compatibility with the user's actual HA version still requires a real, authorized connection; offline mocks do not establish that acceptance.

A successful HA REST call only proves gateway acceptance. HA state objects, even matching targets with new last_reported/last_updated, cannot prove physical execution, so HA commands remain unknown. Read-only reconciliation can report state-match-unverified but never closes that uncertainty or releases conflicting commands. IR-only or non-confirmable devices also cannot be promoted to observed from a mere send acknowledgement.

## Adapter SDK

Implement `DeviceAdapter` from `packages/server/src/device-use/types.ts`:

- `id`: host-installed stable adapter namespace.
- `discover(signal?)`: return validated DeviceRecord objects. Stable IDs must not be reused for another adapter/home identity.
- `read(device, signal?)`: return DeviceObservation for the exact device, with finite timestamps, a stable monotonic stateVersion, availability and source. Repeated observations of unchanged state may reuse a version and refresh observedAt. Older revisions cannot overwrite newer ones.
- `set(device, desiredState, {commandId, deadline, signal})`: honor the abort/deadline when possible. Return rejected only when definitely not executed or explicitly rejected. Return sent for gateway acceptance, never observed. If the execution outcome is uncertain, throw. Do not log secrets in thrown errors.
- Optional `subscribe(listener)` returns an unsubscribe function; optional `close()` releases resources. The Broker owns subscriptions and calls close at Host shutdown, not per pack activation.

Do not perform network I/O in LaneProgram.step. Device tool execution is a Tool Effect; Broker mutexes coordinate physical resources across tasks. Subscribe and credential lifecycle belong to the trusted Host.

## Verification and remaining acceptance

Run `pnpm exec vitest run tests/device-use-core.test.ts tests/device-use-ha.test.ts tests/device-use-voice-terminal.test.ts tests/device-use-worker-ipc.test.ts tests/device-use-worker-transport.test.ts` and `pnpm exec tsc -b packages/server`. Voice desktop integration has additional focused tests maintained with its implementation. The tests are offline/simulated and must not be presented as a real-home acceptance pass.

Core acceptance covers enrollment separation, same-name ambiguity, strict typed targets, scoped grants and limits, trusted confirmation, revoke-during-confirmation/queue, expectedVersion, stale/offline reads, deduplication/conflicting retries, same-device serialization, independent-device concurrency, unchanged target, uncertain send, read-only reconciliation, recovery, per-device scene outcomes, and the real CapabilityPack contract.

Still required with user authorization: connect one real HA installation, explicitly enroll one real lamp and one sensor, verify fresh readback/revocation/reconnect with those devices, then test a specific supported AC model. Voice requires actual selected input/output hardware, unplug/replug and acoustic AEC/interruption tests; physical mute requires hardware evidence. No promise is made for computer deep sleep, closed lid, all-room wake, firmware, custom hardware, Matter/MQTT/USB adapters, long-lived automation, or safe high-risk actions such as door unlock/security disable. None is substituted by a simulator pass.

## Local application settings and worker integration

Open **Settings → Device Use** (`/settings/device-use`) in a local administrator session. This is separate from **Device management**, which pairs phone/web clients. Device Use starts disabled and does not connect to household accounts or devices during installation, application startup or ordinary tests.

Simulator quick start:

1. Select **启用模拟器**, then **发现白名单设备**. All three entries are explicitly simulated.
2. Enroll the simulated light and optionally set its room/aliases. Enrollment alone grants no control.
3. Select that light, allowed actions, a brightness ceiling and an expiry (at most 24 hours), then review and confirm the grant.
4. Ask the chat/voice assistant to list the simulated devices and set the simulated light to 30%. The tool listing includes only this Host principal's valid grants, so the model does not invent authorization references.
5. Inspect the command receipt. `observed` means the simulator reported fresh target state; it is not real-hardware evidence. Revoke the grant to block future dispatch. **关闭并撤权** invalidates old tools/worker epochs and removes current control grants, but cannot undo an already-dispatched physical action.

The Home Assistant settings form is a deliberate, local credential handoff. The user supplies the exact gateway address, home identifier and entity allowlist, and manually pastes an already-created token into a masked field. The form clears that token on handoff. It is not saved in browser storage, general configuration, the device ledger, logs or model context. It remains in the trusted backend's memory only; after restart the UI requires a fresh handoff. The application neither creates HA credentials nor logs into an account. HTTPS is the default; LAN HTTP requires an explicit checkbox and a warning at connection confirmation. Connecting/discovery does not enroll devices or issue grants. Lamp writes require both an adapter write flag and a later, scoped per-device grant. Climate devices are read-only. High-risk writes are unsupported rather than voice-confirmed or silently approved.

All settings endpoints require an authenticated, loopback **local administrator** session; mutations additionally require same-origin requests. Paired clients cannot inspect or mutate these settings. Errors are sanitized and responses use `Cache-Control: no-store`.

One `HostDeviceService` owns the broker, principal, ledger, recovery, token and adapter lifecycle. Application chat/voice turns receive its finite tools only when enabled. Short actions still pass the existing external-tool approval path. Task workers use a bounded private parent/child IPC bridge to this same service; they do not open another device ledger, connect an adapter or receive tokens. The parent binds requests to that child/run and to the enablement epoch. Disabling/reconfiguring does not upgrade old workers to new permissions. Tool schemas forbid principal selection, authorization changes, arbitrary URL/service calls and model-supplied confirmation booleans. Disconnects/timeouts never replay an uncertain action.

Focused Host/UI checks: `pnpm exec vitest run tests/device-use-host.test.ts`; `pnpm --filter @hunterzhu/pulse-web exec vitest run tests/device-use-settings.test.tsx`. These are mocked/offline acceptance only. Real HA, one lamp/sensor, a specific AC model, microphone routing and acoustic tests still require the user's own configured equipment and authorization.

Private Host storage is currently supported on POSIX systems, including the selected Mac. Existing non-private directories and symlinks fail closed. The application Host entry explicitly refuses enablement on Windows until Windows ACL validation is implemented; Node's POSIX-style mode bits are not accepted as proof of a private Windows directory. This is a platform limitation, not a hardware acceptance pass.

## Authorization audit, provenance and retention

New commands carry a versioned, optional `audit` record. The acceptance snapshot preserves the matching grant as it existed when the request entered the ledger, explicitly marked `authorizationChecked: false`: acceptance is not permission to send. The final dispatch transaction atomically records the actual valid grant, finite action/parameter limits, expiry, stable device/adapter/home identity and whether a required action confirmation was verified by the trusted Host. Later grant replacement, expiry or revocation does not rewrite either snapshot. A denied/unsent command has no successful dispatch snapshot. Existing legacy command records remain readable and are never given invented historical approval evidence.

Origins contain a generated Broker ID and, in the application Host, an instance ID and enablement epoch. The capability pack binds the finite entry point; model tool schemas have no origin, principal-selection, audit or confirmation fields. Runtime tool/effect/agent identifiers are diagnostic correlation only. They do not prove that an external action was approved, identify the human speaker, or let a terminal claim to be the user/admin. Gateway names, event text, device descriptions and raw credentials are not copied into provenance. This local owner-controlled ledger is an audit trail, not a cryptographically tamper-proof or independently attested log.

Grant issuance/replacement and revocation append Host-registry lifecycle events with the relevant scoped grant snapshot. Repeated revocation of an already-absent grant adds no event. Closing/reconfiguring through the local settings path revokes current grants with the same lifecycle evidence. The local status/UI can read historical receipts and still-valid grants without connecting an adapter or receiving HA credentials. Withdrawing an existing scoped grant also operates directly on the local ledger when Device Use is disabled or HA credentials are unavailable; it never reconnects the gateway merely to revoke permission. All accepted/sent/unknown receipts are shown outside the recent-30-terminal-command display window, including evidence from a previously selected adapter mode. Terminal history is retained on disk even when the display is truncated. Neither disablement nor restart deletes unresolved evidence or automatically retransmits it.

Capacity is deliberately fail-closed. The default ledger ceiling is 10,000 command records. At that ceiling, a known request ID still returns its original receipt (or conflicts if the payload changed), but a new request fails with `DEVICE_COMMAND_AUDIT_CAPACITY` before sending. No command, deduplication record or unresolved receipt is pruned to make room. Hosts may configure a smaller ceiling for testing, not an unbounded one. The permission-event ceiling is 10,000: once reached, new grant issuance/replacement fails with `DEVICE_PERMISSION_AUDIT_CAPACITY`. Revocation of already-existing grants remains available and retains its event even above that ceiling, so capacity cannot lock the user out of withdrawing permission. Since new grants are refused and absent-grant revokes add nothing, only the finite existing grant set can grow that tail. Automatic archive/reset, tombstone compaction and audit-export retention administration are not implemented; operators must not delete records to bypass a capacity failure.

Offline regressions: `pnpm exec vitest run tests/device-use-audit.test.ts` and `pnpm --filter @hunterzhu/pulse-web exec vitest run tests/device-use-settings.test.tsx`. These cover snapshot immutability, confirmation-time grant changes, missing/denied approval, model audit forgery, capacity refusal with deduplication, revocation at capacity, unknown-result recovery, legacy compatibility, older unresolved history and disabled/credential-missing local history. They do not certify any real hardware.


### Explicit read-only HA climate units

Local Settings > Device Use offers unknown, Celsius, or Fahrenheit for climate states that omit `temperature_unit`. Only select a unit already verified for that gateway. The Host forwards this explicit choice to the adapter and persists the non-secret preference with the exact gateway origin and local home ID. Changing either field resets the UI choice to unknown; an API credential handoff omitting `climateTemperatureUnit` clears the previous preference rather than inheriting it. Existing version-1 settings without the field remain valid. Disable/simulator changes retain the scoped form preference, but no credentials are saved and restart still requires an explicit token handoff.

This never calls `get_config`, reads `/api/config`, or retrieves household configuration. Only exact allowlisted entity state endpoints are used. Unknown, invalid or contradictory device units continue to hide temperature values and the capability unit. Normalized known values use Celsius internally. Climate remains read-only, including when a temperature unit has been confirmed; this setting cannot grant thermostat writes.


### Local unresolved-command reconciliation

Settings > Device Use shows a **read-only query of the original command** for accepted, sent and unknown receipts. The local-admin, same-origin `/api/device-use/reconcile` endpoint accepts only the original command UUID. It never calls `set`, retries a dispatch, creates a command, enables an adapter or hands off credentials. A reliable adapter observation at or after the original send time may update the original receipt to observed (for example, simulator evidence is simulation-only). Generic HA snapshots never do: a match reports state-match-unverified and retains the original sent/unknown receipt and conflict isolation. Dispatch authorization snapshots remain unchanged.

Disabled adapters, missing credentials, offline/stale states, read timeouts/errors, unsupported evidence and mismatching states are reported explicitly without deleting the uncertain receipt. Accepted commands are not sent by this query. Repeated UI clicks are locked while a query runs; there is no polling or automatic retry.

Historical HA receipts lack a gateway-origin binding. The management query therefore only reconciles HA receipts from the current Host instance and connection epoch. After restart/reconfiguration, legacy or mismatched receipts remain unknown with a connection-unverified explanation rather than using another gateway with the same home/entity IDs. The user must independently verify those devices; reconnecting alone does not upgrade old evidence. Simulator reconciliation remains fixture-only and never represents real hardware verification.


HA evidence semantics: `last_reported` records an integration state write, not a command-correlated physical acknowledgement. `last_updated` may change for attributes; MQTT duplicates may not update either timestamp, while retained payloads can replay previous state. Neither timestamp, HA context, a version increase, optimistic/assumed state nor online availability independently establishes physical execution. HA capabilities therefore advertise `confirmable: false`, with a Host-only adapter declaration of `gateway-state` evidence that cannot be selected by a model or settings Boolean. The explicit query can still read exact allowlisted snapshots and explain matching/mismatching values. An older REST response replaced by the adapter's latest-state cache is labelled `home-assistant:cache` and treated as stale, not a new live observation. Existing historical observed receipts are preserved, never rewritten into new physical proof.

References: [HA state object](https://www.home-assistant.io/docs/configuration/state_object/), [MQTT last-reported semantics](https://www.home-assistant.io/integrations/mqtt/#the-last-reported-state-attribute).


### Per-command manual isolation handling

A local administrator may explicitly handle one unknown, audited low-risk light command after **关闭并撤权**. The preview displays its exact command ID, stable device/home identity, original desired state, send time and the risk that an old action may still arrive. The user must enter the exact device ID and separately confirm that they checked that device's current safety and accept this risk. This is a user declaration, not proof of execution, non-execution, cancellation or physical stop.

The local-only, same-origin `/api/device-use/manual-resolution/preview` and `/confirm` endpoints bind a two-minute, single-action challenge to the authenticated session, exact command snapshot and Host epoch. Challenges are bounded to 100 and expire across restarts; they prevent stale confirmation/replay, not prove human presence. The final write uses the shared device lock and one ledger transaction, refuses outstanding local dispatch/execution chains, checks disabled state and absence of active grants, and rejects unsupported/ambiguous identities, non-owned records, non-unknown states and high-risk targets. There is no model/worker/terminal management tool or bulk release.

Only an immutable optional `manualDisposition` is appended (one per command, bounded by command capacity). The original `unknown` status, request, authorization snapshots, timeline and evidence remain intact. The selected command alone ceases to block new independent commands; other unresolved records still block. The UI retains all unknown records, with separate counts for unresolved execution, blocking isolation and user-handled isolation. An administrative release does not clean up capacity by deleting evidence.

Device Use stays disabled and all old authority remains revoked. Reconnecting, granting fresh scope and issuing a new independent request are separate explicit actions. Reusing the original request ID still returns the original unknown receipt, never resends it. Locally unsettled sends can never be released through this interface. A settled local request or a restart cannot prove that a remote queue is empty: the late-action risk remains, so this escape hatch is limited to identifiable low-risk lights, not locks, security, HVAC or dangerous heating.

## Isolated simulated scene sandbox

Settings > Device Use includes an independently default-disabled scene sandbox. It does not register scenes in `HostDeviceService`, enable its device capability pack, connect an adapter/gateway, create real grants, or schedule automation. One named scene with one or two unique fixed virtual lights can be edited in memory. Only finite power/brightness targets are accepted. The sandbox creates its own private temporary ledger on explicit enablement; disablement/server shutdown remove only that owned directory. Re-enabling starts fresh simulated devices/results while retaining the in-memory draft; restart restores defaults. No real device history or authorization is reset.

Save a configuration, preview its before/target states, then explicitly confirm simulation. Preview creates no command and binds the exact configuration version, local-admin session, virtual state versions and a two-minute expiry. Editing, disablement or another preview invalidates the old preview. Execution gets a server-generated run ID; repeated execution of the same committed preview and fault returns its original receipt, including after preview expiry. A changed fault with that preview is rejected. Busy operations are rejected instead of queued, and a lost response requires a manual read rather than an automatic new run.

Steps run in parallel and results are shown by configuration index. Batch `completed` means processing ended, not every device succeeded; each row retains its own observed/failed/unknown/not-accepted result and command ID. Successful siblings stay applied after another step fails. No rollback, compensation or retry is generated. Fixed second-step rejection and lost-response faults expose partial/uncertain outcomes. An unknown result blocks configuration, new previews and new work until the user explicitly disables/cleans and re-enables this wholly simulated sandbox. This reset is not an escape hatch for real household command isolation.

The local-admin-only `/api/device-use/scene-sandbox` route uses same-origin mutation checks, strict bounded schemas and no-store snapshots. It accepts no endpoint, real device, principal, grant, shell, arbitrary service or timing trigger. Scene names are display-only and never instructions or model context. To bound temporary-ledger ownership bookkeeping, enablement is limited to 32 fresh sandboxes per backend process; this cannot create persistent access.

Offline evidence: `tests/device-use-scene-sandbox.test.ts`, `tests/device-use-scene-sandbox-http.test.ts` and web `scene-sandbox.test.tsx`. These establish isolated simulator behavior only, not real lighting, Home Assistant scenes or physical success.
