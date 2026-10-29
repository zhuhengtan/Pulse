# Continuous task controller (v57)

The new policy is opt-in. `legacy` remains the default and starts controller v56.
Restoration registers historical programs and v57 and uses the persisted version;
changing the current configuration does not migrate an existing run.

```sh
pulse run --task-controller-policy continuous "Complete the requested task"
```

The equivalent trusted CLI configuration and `LocalHostOptions` field is
`taskControllerPolicy: 'legacy' | 'continuous'`. Work still runs through the
existing Lane/Step/Effect/Scheduler, cancellation, privacy and atomic persistence
contracts. There is no second controller loop or task database.

## Execution and verification

- Work stays on its delivery lane. Every 16 working model calls, the controller
  records a local checkpoint (`executionSlices`, `nextAction`); it does not start
  a model review or replenish the original provider-attempt budget.
- Distinct sources, real file windows, changed errors and changed content are
  progress. Investigation alone does not require a write. Four unchanged rounds
  receive a focused recovery notice; eight exhaust that recovery window. Runtime
  Watchdog and bounded patch-conflict, approval and permission handling remain.
- The original DAG, caller requirements, frozen checks, failed required checks
  and final criterion-by-criterion acceptance remain enforced. Verification input
  fingerprints exclude accounting counters, but retain contract, instruction,
  schema, candidate and receipt identity. Only passed verdicts can be reused,
  with current filesystem/check freshness validated before and after reuse.
- Automatic approval reuse additionally binds the workspace/dependency stamp,
  operation, manifest, reviewer, model, user intent and current contract. Unknown
  dependencies disable reuse. Manual single-use grants never become reusable
  automatic grants. Arbitrary shell commands and media generation are excluded.
- Local argument, patch and truncation repairs use the existing lane. Existing
  writes, failed checks and the durable budget survive recovery and steering.

## Context

Explicit context isolation and native tool history are independent options.
V57 enables native assistant/tool history without exposing Global/Lane control
objects. Missing correlations produce a recovery notice, never a fabricated tool
receipt. Compacted checkpoints can precede subsequent native tool pairs.

Work requests carry recent receipts and the retained evidence index instead of
accumulating every receipt in SDK inputs. Full original evidence stays available
for verification and explicit retrieval. Fixed work instructions are shorter;
mechanical constraints remain in the tool schemas and original contract.

Compaction considers the full preceding request, model-reported input usage when
available, new history and output reserve, in addition to ordinary history limits.
It preserves the pinned proposal and exact selected prefix across at most two
summary repairs. Invalid summaries never execute tools or replace original
history. Repeated failure leaves the failed runtime/checkpoint recoverable under
the existing recovery preflight; it does not silently start a new run. Summary
requests alone cannot trigger recursive compaction without new work.

## Long commands

V57 adds `shell.start`, `shell.poll` and `shell.cancel`; `shell.exec` is unchanged.
Start uses the existing sandbox runner, argv validation, workspace confinement,
safe environment, command/check receipts and output archive limits.

- `shell.start({command,args,cwd,timeoutMs})` returns a run-owned process handle.
  Timeout defaults to 300 seconds and cannot exceed 300 seconds.
- `shell.poll({processId,offset,limit,waitMs})` reads bounded UTF-8 output and
  status. Defaults: 4 KiB page and 10-second wait, with at most a 30-second wait.
  Exit code and check receipts appear only after actual process completion.
- `shell.cancel({processId})` operates on the same lane's handle. Process records
  carry agent and lane ownership; another lane cannot poll or cancel them.
- Other workspace mutations and verification cannot overtake an active command.
  Polling a valid running process is waiting, not repeated investigation.
- Intent is persisted before dispatch, with one active command per run. The same
  Effect identity reuses its handle rather than replaying the command. After
  process replacement, a running record with no live handle is `unknown`; it
  cannot be silently relaunched or killed by an unverified PID. Settled records
  remain readable. Run cleanup cancels and settles owned live commands.

Process files are tool receipts, not an alternative Runtime task state store.
External side effects retain the existing reconciliation limitations.

## Offline validation

The new tests use script-driven effects, Mock Provider, temporary workspaces and
temporary Pulse configuration. Unexpected fetches fail. CLI configuration tests
set both `PULSE_HOME` and `PULSE_CONFIG`; passing only `--config` is insufficient
because the CLI normally merges the user's configuration layers.

The fixed scenarios include 100 work rounds, multiple compactions, restart at a
pending human question with the same durable budget, two failed summary repairs,
all-failed summary checkpoints, accounting/freshness-aware reuse, manual grant
isolation, native history visibility, local child process output/cancellation and
Host-level mutation exclusion. Domain-labelled scripts exercise the controller
protocol for coding, research, documents, file organization, browser fixtures and
multi-tool work; they are not independent real-provider quality evaluations.

```sh
node scripts/ci/test.mjs
pnpm exec tsc -b --pretty false
pnpm --filter @hunterzhu/pulse-web build
```

The CI test entry creates an isolated Pulse home and excludes `tests/live/**`.
The comparison test prints `MOCK_COMPARISON` metrics for a fixed 20-read/one-write
script. These measurements establish deterministic control-flow behavior only;
they do not establish autonomous completion rates or paid-token savings.

No real-provider evaluation, production installation, service restart or change
of the default policy is part of this implementation.
