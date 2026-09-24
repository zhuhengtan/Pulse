# Incremental editing

Pulse's code-editing guidance asks for a short plan with dependencies and checks,
then one small verified change at a time. This is backed by these tool/runtime
constraints, not only prompt text:

- At most four read-only calls per main-agent round. Built-in writes, Shell, and
  tools not explicitly recognized as read-only execute sequentially. The runtime
  persists excess calls in a queue rather than requiring the model to reissue
  them. A failed operation stops the remaining queue and returns control to the
  model with the completed evidence.
- `fs.read` returns a full-file hash alongside a bounded UTF-8 window. A change
  detected during the read requires another read.
- `fs.write` is bounded to 8192 UTF-8 bytes. Without `expectedHash` it creates only;
  it cannot overwrite an existing file. Prefer `fs.apply_patch` for existing code.
- `fs.apply_patch` bounds each find/replace fragment to 8192 bytes, rejects missing
  or ambiguous context, bounds broad replace-all changes, and always uses an
  atomic compare-and-write. Existing file permission bits are preserved.
- These locks coordinate Pulse writers. They do not provide a filesystem-wide
  transaction against every unrelated editor; concurrent external edits should
  still be reviewed.

## Large new files and deliberate rewrites

Use `fs.stage`, with operation-specific arguments:

1. `begin`: `path`, plus `expectedHash` for an existing target.
2. `append`: `draftId`, latest `revision`, `content` (up to 8192 UTF-8 bytes).
3. `inspect`: `draftId` to recover bytes, revision, content hash and commit state.
4. `commit`: `draftId`, latest `revision`, and confirmed `expectedBytes`.

Draft checkpoints live in `.pulse/drafts/<id>.json` in the workspace. They survive
process restarts. Old revisions cannot append twice. An interrupted draft never
changes the target. Final commit checks the baseline, writes a temporary file,
then publishes atomically; new targets use exclusive creation. A replay after a
crash can reconcile an already committed content hash without rewriting it.
Drafts are retained for inspection, bounded to 500000 content bytes each, and can
be removed after review. They are not automatically added to version control.

The commit validates revision, size and file baseline, not language syntax or
business correctness. The agent must run appropriate syntax/tests afterwards;
a successful file operation alone is not task acceptance. Arbitrary Shell scripts
remain a separate capability, so prompts prohibit using Shell to evade these edit
limits, but these tool limits are not an OS-level ban on large writes.

Existing conversation/task persistence remains readable. Plans are currently
model guidance; this change does not introduce a mandatory dependency-graph
planner or prove real-model performance on every complex task.

## Continuing an unfinished task

Messages beginning with `继续`, `接着`, `恢复任务`, `恢复执行`, `continue`, or `resume` inherit the preceding non-status task's original objective and acceptance criteria. Host API clients can explicitly set `continueTask: true` (or `false` to start a fresh task). Unrelated messages still start a new task.

The runtime TaskRecord remains the live source of truth. Each run exports `task-record.json` at creation and completion so a terminal run can be continued after a host restart. Old runs without this export fall back to their saved input objective; malformed exports are rejected. Old conversations whose original checklist was never recorded cannot have that checklist reconstructed reliably by this migration.

Prior assessments are historical context only. ResultRefs are scoped to their originating run and are not imported into the new run. The agent must inspect current files and establish fresh evidence, preserving completed edits rather than replaying writes. A narrowed continuation retains the original acceptance criteria; deferred items remain pending, and a subset cannot establish overall acceptance. Explicitly unrelated new tasks or `continueTask: false` create new criteria.

When the verifier finds both a blocked/unverifiable item and a correctable unmet item, bounded replanning continues for the correctable item. It never converts the blocked item into a pass. Tool failure feedback distinguishes absent files and permission/network denials and asks for independent authorized work. Repeated identical failures still stop after three consecutive failures; successful rounds reset the count. This does not grant extra permissions or implement automatic dependency installation.

### Local validation (2026-09-24)

- `pnpm check`: 102 files, 707 tests passed, including restart continuity, subset-only acceptance rejection, legacy records, cross-run reference isolation, mixed blocked/correctable criteria, and resetting consecutive failure detection after independent progress.
- Real DeepSeek conversation `conv-623df7eb-25e5-42b1-a4f8-467f5b28b147`: `run-1623c591-be89-43c6-99be-d22e2eb61d17` recovered from an absent file by creating and reading `.tmp/continuity-smoke.txt`, while leaving the unknown license choice pending. `run-e7b1eb8f-7f5e-4b3f-aaaa-c5f662768493` resumed with a narrower read-only request, performed no writes, retained the original requirements, and explicitly reported overall incompletion. Both runtime outcomes succeeded; both task outcomes were intentionally `unverifiable`, so the CLI exit code was 1.
- These are macOS local checks and two real-provider samples, not proof of arbitrary task planning quality or Windows execution.
