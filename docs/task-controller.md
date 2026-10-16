# Host task controller

The Host owns task policy; the Runtime owns execution, cancellation, scheduling,
and atomic persistence. `packages/server/src/task-controller/` implements the
policy as version 18 of `pulse.assistant`, using the existing Runtime DSL. It
does not add an external scheduler loop or a second mutable task database.

## Current execution policy (version 18)

The durable Host `maxModelCalls` ledger counts actual provider requests, including
approval reviews, retries and compaction. Each request receives its current
limit/used/remaining counters. Controller `usedTurns` is diagnostic and is not a
replacement for that ledger. Versions 5–13 remain registered for restoration.

Plans retain every original criterion and check. Oversplit DAGs are coalesced in
topological order when their goals/checks still fit the schema; no checks are
truncated to fit. The target stage count is `max(1, min(8, floor((limit - 4) / 5)))`.
This is a scheduling estimate, not a guarantee of completion within the budget.
Versions 11–14 permit up to 16 work rounds per stage, bounded by the overall ledger.
Research should create a usable report early and fill it incrementally.

A settled failed/cancelled child exposes its own same-agent tool receipts to its
parent. Actual admitted provider attempts are retained even without a completion
ResultRef; failed admission counts zero. Budget exhaustion saves stage evidence
and fails the run immediately, without replanning. Passed file reads include a
path/hash/window/ref index and the underlying content for later stages; changed
files, missing content and later pages remain valid reasons to read again.

New `.mjs`/`.cjs` files are parsed with `node --check` before direct fs.write or staged commit,
without executing code. Invalid syntax keeps any draft and leaves the target
absent. This guard does not establish semantic correctness or validate other
languages. Existing file edits retain baseline hashes and fragment limits.

The following sections also describe historical policies; the Host ledger
applies to new and restored runs independently of the controller turn counter.

## Delivery-chain continuity (version 14)

The Host partitions a validated stage DAG into dependency-connected deliveries.
Every stage in a connected delivery, including branching/fan-in stages, runs
serially on one living lane. A single delivery uses the controller lane; multiple
unrelated deliveries use separate carrier lanes (up to four concurrently). This
conservative policy favors context continuity over parallelizing branches within
one delivery. It does not classify arbitrary natural-language task similarity.

A carrier remains alive between stages and during bounded stage corrections.
Its per-stage work-turn counter resets at the stage/attempt boundary, while its
append-only history, completed writes, human decisions, evidence and whole-run
provider budget remain intact. Stage verification and final original-criterion
verification are still required. Failed required checks cannot pass because a
later stage omitted their citations. Old v5–13 snapshots retain their programs;
waiting historical runs are not automatically migrated.

Carrier checkpoints live in the lane's durable Context, not in a competing global
task database. Root joins merge only the carrier's assigned stages, validate their
original goals/checks/criterion ids, and account for actual settled attempts.
Blocked/cancelled/failed carriers retain their checkpoints and source receipts.
A missing or non-public checkpoint stops automatic reuse with
`DELIVERY_CHECKPOINT_UNAVAILABLE`; a compact manifest cannot replace that proof.
New runs record `deliveryProtocol: 1`; old restores do not silently gain a new
inspection tool or change their tool-catalog recovery fingerprint.

### Model-visible continuity and handoff format

`includeLaneHistory` independently enables the lane's history with explicit
context: Global and lane control state remain hidden. Historical selected result
bodies appear once in the history block; the current result catalog can contain
`{id, fromHistory:true}` instead of repeating those bodies. Model-internal
continuation/reasoning fields are not copied into ordinary history text. Privacy
and visible-ResultRef checks remain enforced. Existing history compaction is
retained; moving to another stage does not clear the history.

Cross-lane or cross-stage delivery uses this versioned index, not a transcript:

```json
{
  "version": 1,
  "stageId": "module",
  "ownerLaneId": "lane-3",
  "status": "passed",
  "summary": "Module created and local checks passed",
  "lookup": { "tool": "task.delivery", "stageId": "module" },
  "evidence": [
    { "ref": "result-12", "tool": "fs.write", "path": "src/module.ts", "hash": "<full file hash>" },
    { "ref": "result-15", "tool": "shell.exec", "exitCode": 0 }
  ],
  "evidenceCount": 2,
  "omitted": 0
}
```

Each manifest is at most 4 KiB, with a 200-character summary and at most 12
reference descriptors. Read descriptors may include `offset`/`nextOffset`;
check descriptors identify their original receipt, not a newly executed check.
The Host retains all source refs and acceptance evidence, including failures.
The manifest does not grant authorization, prove current freshness, or carry
source bodies, log transcripts, model reasoning or credentials.

`task.delivery({stageId,offset})` pages the visible public evidence index, up to
16 refs per page. Its offset counts entries. Use `task.evidence({ref,offset})`
for one needed original receipt and its complete command/arguments/content.
Both interfaces preserve visibility restrictions and are read-only. Omission
counts are explicit; the consumer must retrieve missing detail rather than
rerun the original operation. Current-stage inputs do not automatically inject
all prerequisite file bodies again. The original contract stays available;
bounded dependency manifests, context-surface links and file-window metadata
provide navigation. This does not guarantee lower paid token use without a
subsequent separately authorized provider evaluation.

## Execution

1. Preserve the original `taskRecord` acceptance criteria.
2. Plan up to eight stages, validate criterion coverage and an acyclic dependency
   graph, then select a ready stage. The first implementation is serial.
3. Execute only that stage with bounded tool rounds. Verify successful tool
   ResultRefs independently of the candidate report. A stage reaching its work
   limit goes to verification if it has settled evidence; queued tool requests
   are not evidence. An achievable correction is bounded by `maxStageAttempts = 4` total attempts and the remaining Host budget. An unusable verifier never restarts implementation; unavailable citations cannot justify edits.
   An explicitly requested failing baseline or negative test may use nonzero
   exits only when the verifier identifies them as `expectedFailureRefs`; this
   does not make a failed post-fix test successful.
4. Block dependent stages when their prerequisite is blocked; independent work
   can continue. Program version 8 does not stop the run because a model-call
   count is reached. Versions 5–7 still share one model-call budget, and
   replanning does not reset that budget. Restored snapshots keep the program
   version they were started with.
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

The Host ledger enforces actual provider attempts for new and restored runs, including approval, retries and compaction. Historical version 8/9 controller counters are diagnostic; they do not disable the Host ledger. No wall-clock limit is implicit: only an explicit `maxRuntimeMs` sets one.

Version 9 does not place the whole conversation or every stage into each model
request, and it does not take an arbitrary page of that history. User turns,
context notes, and the latest exchange (the proposal before the latest user
turn and the latest assistant reply) remain explicit conversation context with
their original roles and complete text. Older assistant detail is retrieved
through the structural graph. The original
objective, acceptance criteria, current goal, and active stage are the point.
The surface grows from that point along dependency links, attached evidence,
and records that cite those ids or paths. A farther record cannot jump ahead
of a closer one. If a ring does not fit, its remainder stays in that ring's
order. The next expansion starts at one id already on that surface, through
`task.surface`. An offset into `task.conversation` or `task.history` is not a
way to sample the large history. `task.evidence` still reads one known
ResultRef. Paths in the objective and stage text also seed the graph before
tool evidence exists. A lane can continue from points returned by its earlier
successful expansions; the Host reads those public receipts from durable
Runtime results, so this also works after restoration without a separate
progress store. Versions 5–8 keep the previous full injection. Code search stays
on `fs.search`.
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

Provider failures retain measured attempt latency even without provider token usage. `RunUsage.durationMs` sums available attempt latencies (including failed admitted requests); it is not wall-clock run duration. Unknown token counts and costs remain unknown, and rejected budget admission contributes no provider latency.

## Progress and verification safeguards

Repeated successful reads are compared by actual path/hash/byte window, not a larger ignored maxBytes request. Draft progress uses target/content hash/bytes/commit state, never UUIDs; repeated begin resumes the active draft and returns a bounded UTF-8 tail. begin and inspect are not committed file evidence. Append or a changed file/new page/new user reply is valid progress. After two unchanged rounds one correction is sent; after four the run retains evidence and stops, without automatic goal replanning.

Structured correction passes only bounded field paths and error codes as data; rejected model output stays in ResultRefs and never becomes a control instruction or tool evidence. Original check failure remains failure. Research must create a concise complete report before expanding sections; an outline is incomplete.

Confirmed interview questions, options, selected label/value and actual replies remain in Runtime locals and are included in subsequent requests after compression/restoration. Final execution approval stays separate. The plan gate and evaluator share conservative-first option recognition, preserving opaque values such as hold/execute.

## Evidence reuse and verifier correction (version 13)

The Host checks a planner's `kind`: pure integration/status checks are `verify`,
even if labelled `edit`. An explicit file update still requires a real edit.
Passed stages retain read windows and write versions separately in `contextRefs`
(maximum 128 per stage); these references are context, not additional acceptance
claims. Original validation evidence remains unchanged.

Before dispatch, repeated visible reads reuse their existing ResultRefs. One
specific correction appears at two repeated proposals; four stop with
`NO_PROGRESS`. Alternating reads are covered, while unread pages, new file
versions and fresh user answers permit new work. A matching successful stable
check goes directly to stage verification using its original receipt, without a
new shell effect or a fabricated check result. A later failure cannot reuse an
older pass. The Host recomputes check inputs, definitions and environment before
and after verification; changed evidence cannot pass. External changes not yet
observed by file tools may cause a safe `EVIDENCE_CHANGED` stop at this gate.

A verifier that cites a nonzero read-only status observation alongside successful
checks receives one citation-only correction, persisted as `citationRepairs`.
The observation never becomes a successful check; required failed tests remain
blocking even if omitted from citations. A second bad citation stops that stage
without reopening work or retrying the command. Recovery criterion IDs are
structured inputs, keeping recovery instructions within the existing 2 KB limit.

## Independent acceptance (version 15)

Candidate self-tests prove only the behavior their assertions actually exercise. A green
unit test, a source-string search, and `node --check` do not establish that the full CLI
rejects invalid input before dispatch. Version 15 adds a separate Host-owned gate:

- The trusted SDK caller supplies `LocalHostOptions.acceptanceChecks` before work starts.
  Each check names an installed read tool, fixed arguments, original criterion IDs,
  and the exact expected assertion IDs. The Host clones and persists this contract in
  `taskRecord`; a planner, candidate file, or verifier response cannot replace it.
- After all stages settle, the Host submits these tools itself. They are excluded from
  the implementation loop's allowed tools. Every assertion must appear exactly once
  with an explicit boolean result; omission, duplication, denial, cancellation, timeout,
  or malformed results stay unverified. Any failed assertion makes its original
  criterion `not_met`, even when the final model response says `passed`.
- The tool should capture the candidate source/environment in `checkReceipt`; existing
  before/after freshness checks then prevent acceptance of a changed candidate.
  Check implementations belong to the trusted Host extension, not candidate test files.
- CLI requests explicitly requiring invalid budgets/arguments to fail additionally need
  coverage for a valid entry, invalid value, conflicting options, duplicate option,
  and missing value. Without the declared independent contract, these criteria remain
  `unverifiable` with `INDEPENDENT_ACCEPTANCE_REQUIRED`; the Host must not invent a pass.
  Read-only analysis is exempt. This is a conservative gate for this recognized request
  shape, not a general proof of correctness for every natural-language requirement.
- The contract and settled results survive cold recovery. Recovery uses the saved task
  contract, even if the caller's current defaults have changed. A denied check is not
  retried by a model; completed stages and their evidence remain available. The report
  includes the failed or missing assertion instead of only displaying green stages.

Example of a trusted extension returning its actual positive and negative results:

```ts
const acceptanceChecks = [{
  id: 'argument-contract',
  description: 'Actual CLI entry acceptance before side effects',
  criterionIds: ['criterion-2'],
  toolName: 'project-checks.arguments',
  input: {},
  expectedChecks: ['valid', 'invalid', 'conflict', 'duplicate', 'missing'],
  covers: ['valid-entry', 'invalid-value', 'conflicting-options',
    'duplicate-option', 'missing-value'],
}]
// Trusted project-checks.arguments returns:
// { checks: [{ id: 'valid', passed: true, detail: '...' }, ...], checkReceipt }
```

The LT01 harness now installs this adapter before execution. It runs the helper's exact
string contract and the actual runner in a separate local probe copy, using a fake CLI
that records dispatch and the real compiled artifact grader. The model's own test file
cannot redefine these assertions. Fake CLI probes establish forwarding and rejection;
they do not prove real CLI model-budget enforcement. No additional model call is used
by the independent tool. The existing product budget and approval rules remain in force.

New runs use version 18; versions 5–17 remain registered for saved runs. Historical
scores and snapshots are not rewritten or silently migrated.


## Stage candidates and unread mixed batches (version 16)

Continuous lanes retain conversation history, but each dispatched stage attempt
clears its candidate and records only that attempt's settled work-model result.
`candidateAttempt` persists with the candidate through checkpoints and restore.
A stable check may send work straight to stage verification without assistant
prose; it must never select a candidate by scanning the entire lane history.
The final report renders candidate text only for its owning attempt.

When the edit gate is active, a mixed read-only proposal may execute legitimate
unread file windows and baseline validation while deferring the other calls.
Deferred searches are explicitly reported as unexecuted, with no fabricated
receipts or automatic replay. Repeated windows, stale-version offsets and mixed
human questions do not gain an exemption. This policy is opt-in for version 16;
saved programs 5–15 keep their historical behavior.


## Actual-budget scheduling and terminal verification (version 17)

History compaction accepts only a nonempty summary without tool proposals,
truncation, refusal, or DSML calls. An invalid summary stops with
`HISTORY_COMPACTION_INVALID`; the original history and rejected receipt remain
available for audit. No proposed operation is executed or recorded as a created
file. Summary requests expose no tool definitions and do not replay history as
new user instructions.

After an approval refusal, work and equivalent retries stop. Frozen read checks
and a deterministic final report remain available without another model call.
The report omits obsolete stage prose and preserves known failed assertions as
`not_met`, including when a later runtime failure interrupts reporting. Existing
frozen receipts are reused rather than re-executed. Host-only check tools are
excluded from the working model's tool discovery.

The Host supplies a live scheduling view from the same durable
`ModelAttemptBudget` admission policy used for actual provider attempts.
`actualBudget` is authoritative; `usedTurns` in the saved controller remains
its legacy decoder count. User/model progress exposes actual usage, including
local approvals, retries and auxiliary calls. No counter or limit is reset.

At the work allocation boundary, the controller retains settled effects,
blocks unstarted stages, and uses the reserved stage/final verification calls.
A failed stage check remains failed and cannot reopen work after the boundary.
Frozen independent read assertions run even when stages fail. If an unexpected
Runtime failure prevents this step, the Host executes still-missing frozen
read assertions as terminal checks, records their real outputs separately in
`terminal-acceptance.json`, and creates no synthetic Runtime ResultRef.
User cancellation does not launch these checks. Failed/cancelled runs receive
an interrupted stage projection and a current-state summary, rather than a
concatenation of historical candidate bodies. The original Runtime checkpoint
remains audit evidence.

Automatic approval first rejects unsupported shell syntax without a model.
Task-authorized syntax/tests, strict file-scoped grep/rg, version queries and
read-only git status use deterministic rules. Arbitrary `node -e`, mutating or
compound commands and out-of-workspace/sensitive paths are not exempt.
Remaining review uses only the configured loopback Ollama reviewer and the
shared ledger. In version 17, reviewer unavailability creates a native manual
approval for the exact immutable operation; cold restore keeps it pending.
Only explicit approval permits replay, once. Denial/cancellation and unrelated
operations retain the stop rule; the primary cloud model is never a reviewer
fallback. Direct non-controller runs retain their native ask-mode review path.

## 分页与过期补丁恢复

文件读取按当前文件哈希分别记录已读字节区间。下一页可带少量上下文重叠：重叠不超过 512 字节且不超过有效窗口的四分之一，并且必须暴露实际未读内容。有效窗口仍最多 3000 字节；超大 `maxBytes`、已读区间、EOF 后空读和微小滑动不能绕过编辑门禁。`startLine` 可使用实际 `fs.search` 返回的精确行号；相同版本已读的行窗口不能反复申请，文件修改使旧搜索锚点失效。混合批次只放行合法窗口，其余调用明确标为未执行。

SDK 和任务控制器共用实际读取进展判断。真正的新页、搜索定位窗口及实际文件版本变化允许继续；仅仅换文件名、使用正数偏移或重复已读区域不免除调查次数限制。

`fs.apply_patch` / `fs.apply_patches` 冲突保留失败，并提供当时观察到的 `currentHash` 与有界 `suggestedRead`。恢复读取可穿过编辑门禁一次；需要新补丁时，必须依据实际新窗口重新构造精确片段并使用当前哈希。不会自动模糊匹配、忽略哈希或替用户重基后写入。

当原 `expectedHash`、反向还原的完整文件和正向重放共同证明当前文件就是该补丁的精确结果时，工具仅返回 `alreadyApplied: true`、`changed: false`、`replacements: 0`，不重新写文件。这是当前文件的观察回执，不是一次新编辑，也不替代阶段验收。仅出现替换文本、部分批次已完成、不同注释或无法还原的删除均不能据此认定完成。只读与人工审批限制仍先执行。

同一文件版本上的冲突计数会随检查点保存。修改替换注释、省略 `expectedHash`、切换路径别名或夹杂读操作不能清空计数；第二次针对性纠偏，第四次以 `NO_PROGRESS / STALE_PATCH_LOOP` 停止并保留证据。真实新文件版本可使旧冲突失效；实际新窗口和重基后的精确补丁允许继续。

旧 SDK 的无哈希自定义读取结果仅保留原精确 `nextOffset` 连续读取计数兼容；不能据此进入开发版的版本化读取门禁，也不能作为已验证文件版本或新编辑证据。

## Work, verification and independent documentation (version 18)

- Worker rounds without new settled evidence are counted on the stage, across verifier transitions, stage retries and checkpoint restoration. A single correction is issued at two rounds; four rounds stop with `NO_PROGRESS`. Timing and log identifiers are normalized by the existing evidence identity; real file changes, unread windows and new answers remain progress.
- Named frozen Host assertion IDs are explicitly listed as Host-owned checks. The Host executes them at the stage boundary and again at final acceptance; workers must not search for these IDs as files. A current read plus matching native file-manifest hashes and every frozen assertion passing may establish an already implemented edit. Self-reports, stale hashes or partial/failed checks cannot establish it.
- Documentation of current behavior may proceed after a test/verification dependency settles, even when it fails. Source implementation prerequisites and explicit user requirements that tests pass first remain hard gates. Missing source implementations still cascade. This changes scheduling only; failed tests and overall incomplete acceptance remain intact.
- Final text expands each root cause once, lists every criterion status and evidence reference, and separately lists saved files and unstarted stages. Full per-criterion rationales remain in the task outcome.
- Native shell checks read the Host installation's module directories, including package aliases, with no added write grant. Workspace-proposed links, sibling source/configuration and credential paths gain no read grant. Evaluation environment prechecks now run through the same sandboxed shell adapter as native checks.
