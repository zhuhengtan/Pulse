# Host task controller

The Host owns task policy; the Runtime owns execution, cancellation, scheduling,
and atomic persistence. `packages/server/src/task-controller/` implements the
policy as version 5 of `pulse.assistant`, using the existing Runtime DSL. It
does not add an external scheduler loop or a second mutable task database.

## Execution

1. Preserve the original `taskRecord` acceptance criteria.
2. Plan up to eight stages, validate criterion coverage and an acyclic dependency
   graph, then select a ready stage. The first implementation is serial.
3. Execute only that stage with bounded tool rounds. Verify successful tool
   ResultRefs independently of the candidate report. A stage reaching its work
   limit goes to verification if it has settled evidence; queued tool requests
   are not evidence. An achievable correction gets at most one additional attempt.
   An explicitly requested failing baseline or negative test may use nonzero
   exits only when the verifier identifies them as `expectedFailureRefs`; this
   does not make a failed post-fix test successful.
4. Block dependent stages when their prerequisite is blocked; independent work
   can continue. All stages share the total model budget. Replanning does not
   reset the budget.
5. Independently review the original criteria after every stage passes. Only
   complete, evidenced acceptance produces `taskOutcome.status = accepted`.
   Runtime success alone does not mean the task was accepted.

An invalid dependency/criterion mapping gets one bounded planning correction.
Final verification can cite evidence from any passed stage: later test and
readback stages may prove earlier implementation criteria. Unknown references
remain invalid. Inline numbered lists keep their numbers attached to the task
instead of generating numbering-only criteria; persisted older criteria retain
their IDs during continuation.

Real-provider, non-status requests with multiple criteria or implementation,
review, analysis, or optimization intent select this controller automatically.
SDK clients can explicitly set `LocalHostOptions.taskController`. Simple requests
and legacy snapshots retain their existing programs. Saved inputs include the
program selection and model budget.

## Interruption and recovery

Ordinary input to a running controlled task is routed as steering. A checkpoint
after the active effect settles records its evidence, invalidates queued tool
calls, archives the old plan and requests a revised plan. It does not pretend an
in-flight write was cancelled or replay it. Explicit cancellation continues to
use the Runtime cancellation protocol. Pending human approvals still need a
response before their continuation can reach a checkpoint.

State lives in `global.taskController`, committed with Runtime steps. It records
revision, stages, dependencies, attempts, evidence, updates and budget usage.
Snapshots restore an in-progress stage without rerunning already passed stages.
Terminal runs additionally export `task-controller.json` for inspection. This
file is an export, not an independently editable source of truth. A new run in
the conversation retains the original task contract but may replan; it is not
the same operation as restoring an interrupted Runtime snapshot.

The Host enforces the total model-effect budget, including compaction; the
controller's progress counter tracks planning, work and verification decodes.
`task_progress` notices feed both JSONL and the existing TUI notice stream.

## Verification and limits

`tests/task-controller.test.ts` covers dependency validation, failed evidence,
shared budgets, independent work after a blocker, steering with queued writes,
cancellation, stage-limit verification, final rejection, and mid-task restore.
The controller does not grant permissions, install dependencies, introduce
parallel writes, or turn an environment failure into acceptance.

Real DeepSeek trials exposed excessive re-reading, a stage-limit transition
issue, and an incorrect model conclusion about bounded file reads. After fixes
and explicit feedback, the original review/report task reached acceptance.
The code-fix sample also exposed expected-failure and cross-stage evidence
handling issues. These transitions are covered by regression tests; technical
conclusions still require evidence review. This is not evidence of three-platform
acceptance or reliable completion of arbitrary large tasks.

For source navigation, `fs.read` accepts a one-based `startLine` independently
of its byte `offset`. This avoids guessing byte offsets from `fs.search` line
numbers. Line scanning checks cancellation and stops after 16 MiB; returned
content still uses the existing bounded UTF-8 window and full-file hash check.


## Efficient continuation (program version 6)

The controller explicitly projects the original objective and all acceptance
criteria, the supplied conversation (including earlier design proposals), current steering, budget, active stage,
dependencies and prior-stage ledger. Implicit duplicate global/history/lane
blocks are omitted from model requests, not removed from durable Runtime state.
Earlier assistant proposals, retained lane history and current-run result bodies
remain available through `task.conversation`, `task.history` and `task.evidence`
with bounded Unicode-safe pages. Child workers cannot retrieve the root
conversation. Private/tainted results are not exposed through public retrieval.
Version 5 snapshots remain registered for compatibility.

On an exact “继续” / “continue” request, the Host may seed the previous plan from
`checkpoint.json`. It revalidates the tracked/non-ignored workspace manifest and
referenced file hashes and issues a **new Runtime tool ResultRef** carrying the
historical filesystem evidence. Only unchanged, passed `fs.read`, `fs.write` and
`fs.apply_patch` evidence qualifies. Shell tests and external calls always need
fresh execution. Invalid dependencies, changed goals, files, symlinks, malformed
checkpoints, missing evidence, oversized receipts and unsupported workspaces
fall back to executing affected stages. Final independent acceptance remains
mandatory. Reuse can survive multiple continuations, with the original evidence
and hashes retained rather than a chain of unsupported “passed” flags.

This conservative cache is deliberately bounded: Git workspace inventory at
most 5,000 files / 64 MB total, 8 MB per file, bounded evidence per stage and a
bounded receipt. Exceeding a bound disables reuse; it does not reduce execution
capability or the task's budget. More specific follow-up instructions replan.

`operations.json` and `task.audit` expose this Runtime's tool operations and
result references. Shell entries include the executable and exit code, not
arguments or environment. This is operation attribution, **not** a complete
filesystem diff or proof that all dirty changes belong to Pulse. Existing dirty
files and concurrent modifications still need review.

See `tests/task-efficiency.test.ts` and
`pulse-efficiency-2026-09-24.md` for regression and real-model measurements.

Passed dependency evidence is also supplied to later work and stage verification,
including transitive dependencies. It remains subject to tool outcome and exit
code checks. A final verifier that cites an unavailable historical ID gets one
explicit correction request within the shared model budget; it does not trigger
a rerun of successful tools. A second invalid citation still fails acceptance.

Final verification receives candidate report texts as deliverables, while their
claims still need tool evidence. Declared expected-failure references are retained
even if the verifier lists them only in `expectedFailureRefs`; they must be known
stage/dependency tool results. Ordinary failed checks are still rejected.
