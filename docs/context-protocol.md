# Task context protocol 2

New controlled runs persist `contextProtocolVersion: 2` in `input.json`. Runs with
no version retain their original builder and wire representation on restore.
Task-controller versions 56 and 57 keep their existing scheduling and acceptance
semantics; this is a context protocol change, not another controller generation.

The model-facing transcript is retained in the existing submitted Effect
projection. A journal cursor identifies its lane, stream, prefix fingerprint,
compaction checkpoint, delivered evidence and latest Host state. Subsequent
requests reuse that transcript and append completed model/tool exchanges and
state deltas. Whole request inputs are already protected by Runtime persistence;
no second execution log or external cache is introduced.

Tool schemas are deterministically ordered and sent once through native tools.
Permission and plugin changes still apply at admission; a changed tool surface
invalidates its segment. Compaction and phase changes rebuild a segment from
retained history and current requirements. Private provider continuation remains
scoped to its originating provider. Unavailable tool receipts are recovery gaps,
never invented successful executions.

State JSON updates contain `set`, `append` and `removed` fields. User text keeps
its original role and wording. Evidence is sent once per segment and remains
retrievable through its original reference. Stage deliveries also carry goals,
checks, unresolved work, next actions and dependency fingerprints. Startup
validates committed stages, dependencies and evidence visibility.

Pressure uses the full projected request plus output/schema/image reserves and
the provider's reported input usage when available. Compression starts at 80%
of the usable input window. It preserves at most four complete recent rounds,
reducing that tail under pressure to leave room for a checkpoint. Failed or
invalid summaries retain original history and use bounded retries. Required
context that still cannot fit fails with its checkpoint retained rather than
looping or replaying writes. Token counts are estimates until reported by the
provider; a particular compression ratio is not guaranteed.

`context.request` execution observations contain sizes, fingerprints, segment
changes and locally matching prefix bytes, not prompt text. These are diagnostics,
not evidence of a provider cache hit. Run usage reports cache reads, writes and
misses only when available. Anthropic's total input includes fresh input, cache
reads and cache creation; OpenAI/DeepSeek totals use their reported prompt input.
Missing metrics remain unknown.

## Comparison

Build TypeScript packages, then run the network-free synthetic comparison:

```sh
node scripts/eval/context-cache.mjs --output /tmp/pulse-context-cache.json
```

Real requests are opt-in and bounded; the script never writes task files or uses
tools. Supply your configured provider/model/endpoint and an environment-variable
name containing the key. For example:

```sh
node scripts/eval/context-cache.mjs --live --provider deepseek --model MODEL \
  --base-url https://api.deepseek.com --api-key-env DEEPSEEK_API_KEY \
  --max-calls 6 --output /tmp/pulse-context-cache-live.json
```

The limit covers both protocols; each receives half the calls. There are no
implicit retries. Reports include individual calls and actual usage when returned.
Shared prefixes may warm the second protocol's cache, so this small sequential
probe demonstrates reuse only, not a controlled speed/cost ranking. Coding task
success is covered by offline Host/Runtime acceptance tests, not this probe.
