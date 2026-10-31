# Responses WebSocket transport

Host provider configuration may explicitly set `apiMode: "responses"` and
`responsesTransport: "websocket"` for `openai`/`openai-compatible`.
HTTP is the default. Workspace configuration cannot select this transport;
there is no new client panel and no credential or production migration.

Connections are scoped by provider/endpoint/authentication/model and a trusted
Runtime/lane identity. Auxiliary Runtime calls use separate identities while
sharing the existing durable budget and provider concurrency limits.
The connection cache is bounded and disposed with the run. No socket state is
required for cold recovery: saved runs retain their explicit transport, and old
runs without the field use HTTP even if today's setting selects WebSocket.

Pulse sends `previous_response_id` only if all request conditions are unchanged
and the exact prior request plus confirmed native output is a prefix of the new
history. Compaction, changed instructions/tools/model/authentication or private
continuation mismatch force full legal history. The Host's per-request budget
ledger is preserved; its changing content can make real Host calls use full
history even while reusing their socket. Incremental requests are conditional,
not a promised hit rate or reason to remove safety context.

Only a matching completed terminal may produce executable tool calls. Partial
calls, foreign/stale/duplicate terminals, malformed frames and sent requests
without a terminal invalidate the connection. A disconnect after sending is
unknown/non-retryable; Pulse never silently falls back to HTTP and repeats it.
Explicit cancellation closes the owned connection. Subsequent independently
scheduled work uses the existing budget and effect receipts, never a new budget.

Verification uses local mock WebSocket servers and scripted models only. Native
provider compatibility and native Windows are not asserted by these tests.

Protocol reference: [OpenAI WebSocket mode](https://developers.openai.com/api/docs/guides/websocket-mode).
This implementation uses the implicit default lane on each owned socket; it does
not promise multiplexed named streams, steering, or background generation.
