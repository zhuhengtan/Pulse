# 长任务的验收、预算与恢复

## 验收和需求

任务控制器的最终结果必须完整覆盖原始验收条目，每个 ID 恰好一次，并引用本运行实际提供的证据。最终验证缺项、重复、引用错误或执行异常都返回未完成，保留已完成文件与阶段，不自动重做实现。

正文、列表和附件的要求分别保留来源 hash 与字符范围。单次命令可明确指定需求附件：

```sh
pulse run '实现注册模块' --requirements-doc docs/requirements.md
```

Host API 的 `sendMessage` 支持 `requirementPaths`；继续旧任务时，`continueTask: true, requirementUpdate: true` 将明确的新要求追加到契约中。当前运行中的新用户要求也带有对应 human 输入来源。改变原有要求的优先关系仍需明确描述，旧来源不会被删除。

检查回执记录实际 command/args/cwd、被测文件与静态本地导入依赖、检查定义和 Node/平台版本。修改产物后，旧成功不能用于验收。项目级检查使用有上限的保守源码清单；命名的 JavaScript 检查使用本地导入闭包。动态读取、远程依赖和其他语言的依赖图没有全覆盖保证。

固定测试定义和所调用的项目检查脚本存放在 Host 的运行数据中。检查定义变更会阻止原规格验收；正常的依赖清单编辑可通过重跑当前检查获得新证据。明确“禁止新增依赖”的任务还会独立比较开始时与当前的 npm 依赖名称。

## 文件与命令输出

- 新文件块上限为 16 KiB UTF-8；已有文件仍使用小范围 patch、CAS、草稿归属和提交前语法保护。
- `fs.stage.capacity` 根据模型输出能力、剩余实际调用和验证预留，报告交付尺寸是否可行。16 KiB 是接收上限，模型输出较小时建议更小的块。不会自动增加预算。
- `shell.exec` 的模型观察保持有界，长输出保留首尾；原始字节流存入本 run 的私有 `shell-output` 文件。通过 `shell.output` 的 id/offset/limit 分页读取，不必重跑命令。
- 每个输出流归档最多 16 MiB，每个 run 总共最多 64 MiB；达到上限或写盘失败会明确标记不完整。原始字节数、保存字节数、hash 和省略范围仍可核对。读取继承原命令结果的可见范围。

## 预算配置

在用户配置中可指定：

```json
{
  "maxModelCalls": 16,
  "modelBudgetPolicy": {
    "verificationReserve": 2,
    "maxTokens": 200000,
    "unknownUsage": "stop"
  },
  "persistenceBackend": "external-files"
}
```

控制器任务默认保留最后两次调用，其中最后一次只供最终验证。普通执行、规划、进度审查、审批、压缩、前置模型和 provider 内部重试使用同一持久账本；恢复使用保存的限额和统计。`run.usage().budget` 可查看用途、已用 token、未知用量与费用。

`modelBudgetPolicy.maxCostByCurrency` 可设已报告费用的限额，`maxCostByCurrency` 同时接入 Runtime 的费用护栏。token/费用在响应结算后检查后续调用，因此单个已开始的请求可能超出剩余额度；这不是预付费上限。费用未报告时不把它当作零，严格限额默认停止。`unknownUsage: "allow"` 是显式允许在用量未知时继续；配置的模型价格估算仍与 provider 报告费用分开。

## 长会话与迁移

新 run 默认使用 `external-files`：原子 JSON 活跃状态、外置结果、分页事件归档，以及有界的按需结果缓存。也可显式选择 `json` 或 `sqlite`；SQLite 使用 Node 内置支持。已有 run 自动识别并沿用原格式，不因改默认值静默转换。

模型常驻决定表面固定保留重要约束，再按阶段相关性和时间选择，完整问答仍通过 ResultRef 查询。提问可带稳定 `decisionId`、`decisionScope` 和 `decisionPriority`（`constraint`、`stage` 或 `normal`）；更新记录包含版本与被替代的结果引用。

恢复检查构建、工具 schema/权限和策略指纹。结果分为兼容、可迁移或不兼容；可迁移时先保存原快照和记录，再绑定新契约。不兼容时给出具体工具或策略原因，保留原件。构建发生变化且已有旧指纹时，需要审核代码变更，再通过 `pulse resume <conversation-id> --accept-build-migration <oldhash:newhash>` 明确授权诊断中的精确构建对；不会自动放行未知构建。迁移不回答问题，不重放写入，不赋予旧的未绑定执行批准效力。

旧 ownerless 草稿需要人明确认领：

```sh
pulse drafts <conversation-id> <run-id> <draft-id>
pulse drafts <conversation-id> <run-id> <draft-id> --revision <预览返回的hash> --confirm-owner
```

第一条只预览，第二条确认相同修订后迁移，并保存原草稿。该入口没有注册为模型工具；不会按文件名或时间猜测归属。

## Controller v13 and usage completeness

New controlled runs persist a stage `kind` (`edit`, `verify`, or `analyze`). Host
validation recognizes integration and documentation updates independently of
verbs inside filenames. Discovery-only prerequisites may be merged into their
single deliverable without dropping criteria, checks or dependencies. Earlier
program versions remain registered; pending historical runs require the existing
explicit build compatibility checks, never automatic migration.

Successful check evidence is compared using command, arguments, scope versions,
exit status and stable assertions. Recognized test timing fields and archive IDs
are not progress. Raw logs, failures and archive errors remain evidence. Editing
stages also enter verification after successful checks. Malformed progress
reviews get one structured correction; a single proven unread page may be used
as recovery, otherwise `PROGRESS_REVIEW_UNAVAILABLE` retains the checkpoint.

The durable model ledger records per-field known counts for input/output,
cached/uncached input, reasoning, visible output and request latency. `RunUsage`
adds `fieldCompleteness`; partially known totals are lower bounds. Missing fields
remain `null`/unavailable, including legacy request latency. `durationMs` is a
sum of known request latencies, not wall-clock duration. Original limits and
usage survive event archival and recovery; settlement receipts are deduplicated.

The isolated evaluator accepts `--sample-calls none --no-deadline --task LT01`.
This disables only additional evaluator limits. Pulse's existing 256-call ceiling,
approval rules and no-progress guards still apply. The independent runner probe
uses a fake CLI plus the real compiled artifact grader, with a separate workspace
and no provider credentials. No fake grader is used for final acceptance.

### LT01 execution follow-up (2026-10-16)

Version 13 retains unselected read windows separately from accepted evidence,
filters repeated read proposals before dispatch and hands matching successful
checks directly to verification. File/import scope, definitions and environment
are rechecked by the Host; an older pass cannot hide a newer failure. Pure
integration checks cannot require a write just because the planner labelled them
edit. One persisted verifier citation correction handles nonzero state queries,
while failed required checks continue to block.

Offline runner probes now cover nested and flat references, independent budgets,
complete report output, unknown/zero/conflicting/duplicate/missing budget inputs,
and rejection before CLI invocation. The fake CLI has no Host budget ledger, so
the probe requires requested enforcement to remain distinct from confirmed
provider-call enforcement. These local tests do not establish real-model success.

## Lane continuity (controller v14)

Dependency-connected stages and their bounded retries share one living lane;
independent deliveries retain separate carriers. `delivery` v1 indexes are
bounded and source-ref based, with `task.delivery` for omitted references and
`task.evidence` for original detail. Check acceptance still uses original settled
receipts and current freshness checks, never the compact summary. History is
explicitly included without injecting Global/Lane state, and selected bodies are
not duplicated in the current results catalog. See `docs/task-controller.md`.

## Independent acceptance after optimistic self-tests (controller v15)

`accepted` requires the frozen caller-owned checks when supplied. A final model cannot
waive a failed assertion, omit an expected negative case, or substitute an implementation
unit test for a declared actual-entry probe. Missing independent proof for a recognized
CLI invalid-argument requirement is `unverifiable`, not accepted. Full behavior outside
these declared checks still requires semantic review.

`acceptanceChecks` and `acceptanceResults` persist separately from model assessments.
Denial and environment failure retain their reason codes and stop equivalent retries.
Completed stages are preserved; the controller does not automatically open a new run
because an independent gate failed. Trusted extensions must run checks within the
existing task authorization and preserve source freshness, cancellation, and isolation.

The LT01 independent scorer accepts the equivalent `maxModelCallsPerAttempt` and
`maxModelCallsPerTrial` report fields, while checking actual forwarded arguments, report
values, artifact grading, and all negative entry cases. If both fields exist they must
agree. This compatibility does not waive conflicting aliases, duplicate flags, missing
values, false enforcement claims, or contradictory model identity. Historical grades
remain unchanged; the new scorer is for new runs and explicit offline regression.
