# Host task controller

Host uses one current continuous task controller. `legacy` configuration values and old caller version labels select the same implementation. An update diagnoses saved work with the current code rather than keeping historical controller implementations alive. See [current controller reliability](current-controller-reliability.md) and [continuous execution](continuous-controller-v57.md).

## Task contract and execution

The original objective, exact acceptance criterion IDs, caller-owned checks, decisions, artifacts and cumulative provider-attempt budget are durable facts. Replanning, compaction, model fallback and update takeover do not reset them. A successful Runtime outcome is distinct from accepted business work.

The controller validates an executable DAG against the original criteria. Related stages share a living delivery lane and its native assistant/tool history; unrelated delivery chains can use separate carrier lanes. A one-stage task stays on the controller lane. Root joins retain settled carrier evidence and merge only the assigned stages. A missing checkpoint cannot be replaced with a model-authored success claim.

Work proceeds continuously until it finishes, reaches an actual blocker or consumes its allocation. Local execution slices record checkpoints without replenishing the budget or forcing a model review every few turns. Changed file windows, source windows, human answers and real check results establish progress; a changed plan description does not.

Read-only inventory stages expose read capabilities and restrict shell inspection. Retained-artifact verification allows current reads and actual checks; it cannot rewrite a completed artifact just because its verifier was unavailable. Implementation repair remains available when an actual required check fails or a delivery is incomplete.

## Recovery and updates

Failures are normalized to `FailureRecord`. Recovery chooses input correction, current-artifact verification, authorized environment repair, compatible configured models, smaller requests, authorized alternatives, reconciliation or delivery repair. Permission denial never authorizes bypass. Unknown side effects must be reconciled before replay.

`RecoveryAttempt` retains original failures, the chosen method, settled evidence and the progress decision. Completed stages survive scoped replanning. New plans cover the unmet criteria; they cannot replace already passed stages or relax frozen checks. There is no fixed three-replan stop. The real model budget, explicit user decisions and bounded periods without new evidence remain hard limits.

Restore preserves the original snapshot and migration journal, binds numeric task-controller checkpoints to the current implementation and schedules diagnosis at the next safe boundary. Pending questions receive their actual answer before diagnosis. Undispatched obsolete proposals are cancelled; running or uncertain operations retain their identities and enter Runtime reconciliation. Build and policy drift are diagnostic inputs rather than a requirement for exact-build confirmation. The generic Runtime SDK compatibility contract remains separate.

Immediate user input is interpreted independently of outstanding worker effects. Information requests can receive an answer without granting approval. An explicit correction updates the task at a safe checkpoint; cancellation remains authoritative. A stored plan that requires confirmation must be persisted, reviewed and approved at its current hash before implementation. Closing or deferring that decision keeps execution closed.

## Evidence and acceptance

The Host keeps a complete same-agent visible receipt index. Model-selected citations do not decide whether source or visual auditing runs. Evidence lookup obeys visibility and privacy labels; it does not widen access. Native tool receipts remain authoritative over generated prose or proposed operations.

Stage verification checks the active contribution. Final verification covers every original criterion using actual available evidence. Missing, duplicated or invented citations receive bounded correction. Unavailable verification retains deliverables and routes to verification recovery; it cannot establish a pass.

Failed required checks survive stage changes and replanning. A later passing receipt must cover the original check and current artifact. Named test delivery, unchanged baseline definitions, check coverage and file freshness remain independently enforced. Candidate tests cannot stand in for caller-owned assertions. A model's optimistic verdict cannot override a failed native check.

Fetched primary sources and actual visual observations trigger independent factual audits. Persisted delivered content is read back when required. Absolute factual assertions receive bounded per-claim assessment with actual primary-source quotations; omitted source citations, unsupported claims and partial coverage do not establish acceptance.

## Processes, budget and presentation

A settled `shell.start` receipt is not process completion. The controller polls the same owned handle before verification; exit code and check evidence appear only after actual exit. Unknown processes after a cold restart are not silently relaunched or killed. Only explicitly declared services started in the enforced read-only workspace sandbox can remain running with native readiness evidence. See the service contract in [current controller reliability](current-controller-reliability.md).

Planning, work, review, approval, fallback and compaction consume the shared durable model-attempt budget. Verification and final reporting retain reserved capacity. `RunHealth` projects execution, acceptance and environment separately; it is presentation data and grants no runtime authority. Unknown dependency health remains unknown.

## Validation scope

Offline tests use scripted effects, local Mock Providers and isolated directories. They verify protocol invariants, not universal real-model success. Live-task evaluations require real provider calls and independent checker evidence. Browser, native desktop and platform lifecycle results are reported separately. See [harness reliability](harness-reliability.md).
