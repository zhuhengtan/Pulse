# Pulse Runtime MVP 开发方案（M0 + M1 贯通交付计划）

> 设计版本：2026-09-19 · 更新：2026-09-21 · 状态：MVP 实施基准 + 代码验收记录（Execution Blueprint）
> 
> 上游依据：
> - `pulse-runtime-architecture.md`（内核规范与验收标准）
> - `pulse-application-dsl-spec.md`（应用层 DSL 与开发体验规范 r2）

---

## 1. 方案目标与交付范围

本方案是 Pulse Runtime 首个 M0 + M1 MVP 的实施基线，目标是**从零构建并贯通确定性调度内核、一个真实模型适配器、标准工具链与应用层 DSL**。它不宣称完成可靠崩溃恢复、分布式执行或生产级多 Provider 覆盖。

### 1.1 交付范围界定

```text
┌──────────────────────────────────────────────────────────────────────────┐
│  M0：证明调度内核（确定性仿真闭环）                                       │
│  - 纯函数状态机：validate -> Mutation[] -> apply 两阶段提交             │
│  - 依赖图拓扑、死锁检测、单一 Wait 约束、优先继承与 Aging 机制          │
│  - 调度器 Tick 循环、TimerWheel、Fact/Observation 双 Inbox              │
│  - Effect 队列与 Attempt 隔离、QuarantineScope 资源收容                 │
│  - 虚拟时钟 Harness 跑通主架构第 26 节全部 M0 验收场景                 │
└────────────────────────────────────┬─────────────────────────────────────┘
                                     │ 顺畅递进
┌────────────────────────────────────▼─────────────────────────────────────┐
│  M1：真实模型与应用层 DSL 贯通（受控任务可用）                           │
│  - 三层 Context 隔离（Global/Lane/Request）与稳定前缀构建器              │
│  - 至少一个真实 Provider Adapter；其余 Provider 以 Fixture/可选 Smoke 验证 │
│  - 标准 Tool SDK、Filesystem 与安全 Shell 执行器                        │
│  - Layer 1 StepBuilder 宏步编译器与 Layer 2 预制模板库                  │
│  - Layer 3 Session 双通道流式 API 与端到端排障流水线演示                │
└──────────────────────────────────────────────────────────────────────────┘
```

### 5.1 本次实现与证据记录

本仓库已完成 M0 + M1 主要确定性实现，并遵守“模块测试全绿后提交”。近期按架构补齐的关键模块如下：

| 模块 | 实现 | 测试证据 | 提交 |
| --- | --- | --- | --- |
| ResultRef 可见性 | Lane 默认隔离、`inputResultRefs` 显式授权、ContextBuilder/DSL/快照恢复统一校验 | `tests/result-visibility.test.ts` 等 | `50d21b3` |
| LLM history | 成功 LLMEffect 在结算 journal 中追加 instruction、消费引用和结果；拒绝输出不进 history | `tests/history-llm-settlement.test.ts`、`tests/m4-dsl-e2e.test.ts` | `9199fbd`、`9eda5b1` |
| 结构化输出分层 | JSON Schema、`rejected_output`、`rejectedOutputRefs`、DSL self-correction | `tests/provider-host.test.ts`、`tests/m4-dsl-e2e.test.ts` | `9eda5b1`、`2009eaa` |
| ToolCallCorrelation | `toolCallId → LLM Effect → Tool Effect → ResultRef` 持久化及 ReAct 关联 | `tests/dsl-host-macros.test.ts` | `0d0ea33` |
| 模型并发槽 | Runtime LLM 槽之外增加可取消 provider/model 槽 | `tests/provider-host.test.ts` | `015c959` |
| warm start / DSL | facts/findings 筛选、ResultRef 授权、递归 Draft Proxy、ReAct 完成回调只传 ResultRef | `tests/warm-start.test.ts`、`tests/dsl-context.test.ts`、`tests/m4-dsl-e2e.test.ts` | `79a993f`、`324f1bc`、`e6c228b` |
| Runtime Storage 编排 | Runtime 自动登记 Event/Result/Snapshot/LLM Request，活动 Lane/Wait/未结算 Request/可见 ResultRef 幂等 pin；Step 提交前 clone 预检 hard limit | `tests/storage-policy.test.ts` | `43a9847` |
| LLM Preparation | bounded preparing/prepared 窗口、generation、迟到准备丢弃、explain 展示 | `tests/provider-host.test.ts` | `944c3ad` |
| Provider 请求与 usage | modelId、工具 schema、structured output schema、uncached token、latency/cost 归一化与 metadata | `tests/m3-context-adapters.test.ts`、`tests/provider-host.test.ts` | `fa723c7` |
| 自适应模型路由 | `AdaptiveModelRouter` 基于质量、延迟、价格、缓存和探索项重排合规候选；Provider Executor 自动记录 Attempt 反馈，并支持经过校验的 snapshot/restore | `tests/adaptive-routing.test.ts`、`tests/provider-host.test.ts` | `0d17d7c`、`4c65d38` |
| DSL Draft 数组语义与运行诊断 | `push→append`、数组索引/splice/sort→整数组 set；explain 补充队列、等待、watchdog、preparation、execution metadata | `tests/dsl-context.test.ts`、`tests/runtime-control.test.ts` | `d5c6ef2`、`f57ae27` |
| Mutation 事务预检 | clone 预检失败不写日志、不改变运行时；提交时保留 Lane/Effect 对象身份；日志预备失败不消耗序号，状态 apply 与日志提交分层 | `tests/storage-mutation-log.test.ts` | `70c3534`、`6c89fe2` |
| Tool Schema 与 Provider 上限 | 不支持的 Zod 类型构建时 fail-closed；Anthropic `maxOutputTokens` 不再写死 | `tests/m3-context-adapters.test.ts` | `e21907a` |
| 持久化恢复边界 | `persisted` 驻留状态、backend restore、在途写副作用 quarantine、journal event `txId` 一致 | `tests/storage-policy.test.ts`、`tests/storage-outbox.test.ts` | `00d49f6`、`f7ba385`、`9b22fd3`、`c0e87f6` |
| Result residency 元数据 | ResultRecord 保留 `storageState/pinCount`，并与 StoragePolicy 的 pin/持久化确认同步；residency 元数据不参与正文哈希 | `tests/storage-policy.test.ts` | 本轮 Result residency 提交 |
| Snapshot 外部索引与读穿 | Lane/Global Context Snapshot 正文可写入 SnapshotStore，持久化 envelope 只保留稳定引用；恢复时读穿，缺少 SnapshotStore fail-closed | `tests/storage-outbox.test.ts` | 本轮 SnapshotStore 提交 |
| File body/event store | `FileRuntimeContentStore` 为 ResultStore/SnapshotStore 提供带锁、临时文件 + rename、幂等写与内容冲突检测；`FileRuntimeEventArchive` 提供 checkpoint 事实事件的原子归档与范围读取 | `tests/storage-outbox.test.ts` | 本轮 File body/event store 提交 |
| 异步派发失败边界 | `dispatch_failed` 审计事件无法进入事实日志时使用 fail-closed 旁路，不让异步 Promise 逃逸；Effect 仍进入统一结算路径 | `tests/runtime-control.test.ts` | 本轮异步失败边界提交 |
| Durable outbox dispatch gate | 配置持久化后，Effect Executor 只有在包含 pending outbox 的快照 durable save 完成后才启动；保存失败时保留队列，不进入外部执行 | `tests/storage-outbox.test.ts` | 本轮 Durable outbox 提交 |
| 恢复定时器与 Wait deadline | 恢复后以持久化 `state.now` 立即 flush 过期 retry/wait timer；retry 入队和 Wait/Lane deadline 结算均经过 StoragePolicy 预检 | `tests/storage-outbox.test.ts`、`tests/runtime-control.test.ts` | 本轮恢复定时器提交 |
| Wait 依赖结算事务 | Effect/Lane 终态触发 Wait resolution 时，Wait、Lane、closing Result 与恢复输入统一走 storage admission + MutationLog；准入失败不改变 pending Wait/Lane | `tests/runtime-control.test.ts`、`tests/result-summary-budget.test.ts` | 本轮 Wait 结算事务提交 |
| Lane failure 事务 | 程序异常、异步 Step、控制错误和 Watchdog 失败统一先构造候选 Lane，再经 storage admission + MutationLog；事实事件超限时仍可无事件 fail-closed 进入失败终态 | `tests/runtime-control.test.ts` | 本轮 Lane failure 事务提交 |
| Agent 状态事务 | Child Agent 的 succeeded/failed/cancelled 状态与 parent Agent Effect settlement 作为同一笔 `setAgent + setEffect` Mutation 通过 storage admission 提交 | `tests/agent-effect.test.ts` | 本轮 Agent 状态事务提交 |
| Detached 生命周期事务 | `detachAgent/attachAgent` 的 Agent record 与事实事件通过同一 MutationLog 事务提交 | `tests/agent-effect.test.ts` | 本轮 Detached 生命周期事务提交 |
| Agent 终态事务 | `run()` / `runAgent()` 的根 Lane 终态通过 `setAgent` Mutation 提交，运行入口不再直接改写 Agent 状态 | `tests/m0-acceptance.test.ts` | 本轮 Agent 终态事务提交 |
| Agent 取消状态事务 | `cancelAgent()` 的 `cancelling/cancelled` 状态通过 `setAgent` Mutation 提交，并保留未决副作用的 Quarantine 语义 | `tests/runtime-control.test.ts` | 本轮 Agent 取消状态事务提交 |
| Agent 终态准入失败 | Agent 终态 `setAgent` 的 storage admission 失败不再静默返回，`run()`/`runAgent()` fail-closed 暴露 `SESSION_STORAGE_LIMIT_EXCEEDED` | `tests/runtime-control.test.ts` | `11aa4d4` |
| Lane/Effect 取消事务 | Lane 取消、Effect cancel-requested 与 Quarantine 的状态和事件统一通过 MutationLog 提交，避免取消过程中直接改写 live record | `tests/runtime-control.test.ts` | 本轮 Lane/Effect 取消事务提交 |
| 重试/Remote Unknown 事务 | retry scheduled/ready、Remote Unknown 和 reconciliation abandon 的 Effect/Lane 状态与事件统一通过 MutationLog 提交 | `tests/retry-policy.test.ts`、`tests/runtime-control.test.ts` | 本轮重试与 Remote Unknown 事务提交 |
| Step 存储拒绝收尾 | Step mutation 无法通过 storage admission 时复用 Lane failure 事务，保留失败终态并在事件超限时无事件兜底 | `tests/runtime-control.test.ts` | 本轮 Step 存储拒绝收尾提交 |
| 控制错误恢复事务 | `pendingResumeInput`、连续控制错误计数、Watchdog 干预状态与 `step.rejected`/`fork.affinity_advice` 事件统一通过 Lane 事务提交；存储拒绝时 fail-closed | `tests/runtime-control.test.ts`、`tests/watchdog.test.ts` | `3f70131` |
| Step 恢复输入消费事务 | 成功 Step 在同一 Mutation 中消费 `pendingResumeInput`、清除控制错误计数、保存 Watchdog 状态并记录干预事件，避免崩溃后重复消费 | `tests/runtime-control.test.ts`、`tests/storage-outbox.test.ts` | `ed61be0` |
| 恢复 Effect 状态事务 | 恢复时 running Effect 的 requeue/reconcile_required 修正通过 `setEffect` MutationLog 记录，避免恢复阶段直接改写 live record | `tests/storage-outbox.test.ts` | 本轮恢复 Effect 事务提交 |
| Effect dispatch 状态事务 | Effect 取得 outbox/锁后，`running` 状态与 Attempt 记录先经 storage admission + `setEffect` MutationLog，再启动 Executor | `tests/runtime-control.test.ts` | 本轮 Effect dispatch 事务提交 |
| Remote Unknown 重试准入 | Remote Unknown 的可重试分支先在候选 Effect 上计算 retry，准入失败不修改 running Effect | `tests/runtime-control.test.ts` | 本轮 Remote Unknown 重试准入提交 |
| Effect 正常结算事务 | Effect settled、Result/Artifact、Lane history、Tool correlation 与 metadata 事件统一由一个 MutationLog 事务提交，并保持旧 record 引用兼容 | `tests/late-attempt.test.ts`、`tests/storage-outbox.test.ts` | 本轮 Effect 正常结算事务提交 |
| Effect 结算拒绝事务 | Result/Artifact 超限时以失败 Effect + 可容纳的 settled 事件作为兜底事务，不留下半个 Artifact/Result | `tests/result-summary-budget.test.ts` | 本轮 Effect 结算拒绝事务提交 |
| Effect 控制路径准入 | 取消、超时、立即隔离、Remote Unknown、对账放弃、重试的控制事件与 Effect/Lane 状态变更先做统一 StoragePolicy 预检，失败时不留下半完成状态 | `tests/runtime-control.test.ts`、`tests/retry-policy.test.ts` | 本轮 Effect 控制准入提交、本轮 Remote Unknown 准入提交、本轮对账放弃准入提交、本轮重试准入提交 |
| Runtime 生命周期自动持久化 | 配置 `persistenceBackend` 后，Tick/异步 Effect 结算、取消与对账自动排队保存；`run()`、`shutdown()` 等待 durable save；显式 `flushPersistence()` 支持宿主主动冲刷 | `tests/storage-outbox.test.ts` | `7a2ed52`、`3bb7ac0` |
| 运行观测 | 只读 telemetry 聚合 agent/lane/effect/attempt、route 排除、provider/model、slot wait、usage/cost | `tests/provider-host.test.ts` | `e68cae0` |
| 输出预算与可恢复 Tool | `maxOutputTokens` 参与窗口预留、候选准入和 Provider 请求；structured schema 与最终 `outputSchema` 契约校验；保存 executionRef 并提供 RecoverableTool 对账入口 | `tests/provider-host.test.ts`、`tests/tool-host.test.ts`、`tests/m3-context-adapters.test.ts` | `d451014`、`b4461a8`、`83ebe38` |
| 高级 Wait 与 Tool 准入 | Wait 支持 `any/quorum`、独立 deadline 和恢复重建；Tool Manifest 可在提交前注入可信锁、副作用策略与默认超时 | `tests/advanced-join.test.ts`、`tests/tool-host.test.ts` | `af1ff6f`、`f523c71`、`a95d4f5` |
| Detached/background scope | Child Agent 可显式转入后台 scope；父取消不传播到 detached child，仍受 Runtime shutdown 约束，并支持查询与 attach | `tests/agent-effect.test.ts` | `e3ef1ce` |
| Step 同步边界 | 运行时对未类型化的 Promise Step fail-closed，拒绝跨越同步 Step/异步 Effect 边界，不让 Tick 因非法返回结构崩溃 | `tests/runtime-control.test.ts` | `396499f` |
| Host 调用预算 | Runtime 在派发前执行总 Attempt/LLM/Tool 次数准入，达到上限时原子失败排队 Effect；已结算 Provider cost 按 currency 累计并可从事件恢复 | `tests/runtime-control.test.ts` | `51cf23d` |
| 动态工具检索与 Context 接入 | Tool Registry 支持 tags、文本相关性、side-effect/concurrency 过滤和稳定排序；查询结果编译为带稳定版本的 ToolSet 并写入下一次 LLM Context | `tests/tool-discovery.test.ts`、`tests/tool-host.test.ts` | `88970c4`、`480a81a` |
| Checkpoint 事实事件截断 | Checkpoint 保存状态与日志水位后截断已纳入快照的事实事件；恢复后的 Session 通过 `gap` 要求 Host 重同步，并对事件水位 fail-closed 校验 | `tests/storage-outbox.test.ts`、`tests/m4-dsl-e2e.test.ts` | `2ea2a6b`、`e86093a` |
| Worker 执行边界 | `WorkerCoordinator` 提供 Worker 注册、lease、幂等键、取消、过期回收、snapshot/restore 和 Runtime `EffectExecutor` 适配；adapters 提供带 Bearer 鉴权的 HTTP claim/renew/complete/fail 与 polling Worker | `tests/worker-coordinator.test.ts`、`tests/worker-http.test.ts` | `d221466`、`2250df2`、`685be10`、`47791bd` |
| Worker 鉴权轮换 | HTTP Worker Server 支持每请求解析当前允许 token，恒时比较，并允许新旧 token 重叠后无重启轮换 | `tests/worker-http.test.ts` | 本轮 Worker 鉴权轮换提交 |
| Worker TLS 传输 | HTTP Worker Server 可配置 HTTPS key/cert，返回 `https://` 地址；真实 TLS 握手与 Bearer 鉴权已验证 | `tests/worker-http.test.ts`、`tests/fixtures/worker-http-*.pem` | 本轮 Worker TLS 提交 |
| Worker 网络超时 | HTTP Worker Client 为每个请求设置有界超时；Coordinator/网络分区不会让 register、claim 或 polling 永久悬挂 | `tests/worker-http.test.ts` | 本轮 Worker 网络超时提交 |
| Worker 远程未知对账 | HTTP Worker Effect Executor 在提交/轮询响应丢失时查询任务状态；写副作用查不到确定状态则返回 `remote_unknown + executionRef`，交给 Runtime Quarantine | `tests/worker-http.test.ts`、`tests/storage-outbox.test.ts` | 本轮 Worker 对账提交 |
| 持久化快照完整性 | Runtime Persistence/Checkpoint envelope 带 SHA-256 digest；恢复前校验篡改或损坏，失败时不进入状态恢复 | `tests/storage-outbox.test.ts` | 本轮持久化完整性提交 |
| Worker Snapshot 完整性 | Worker Coordinator snapshot 带 SHA-256 digest；lease 恢复前拒绝被篡改的任务、序号或幂等索引 | `tests/worker-coordinator.test.ts` | 本轮 Worker Snapshot 校验提交 |
| Worker 持久化失败可观测 | Worker Coordinator 自动保存失败不再静默吞掉；`flushPersistence()` 返回明确错误，同时后续保存仍可继续排队 | `tests/worker-coordinator.test.ts` | 本轮 Worker 持久化错误提交 |
| Worker 共享 Lease Store CAS | File Worker persistence 使用跨进程 lock + integrity digest compare-and-swap；陈旧 Coordinator 不得覆盖新 lease 状态 | `tests/worker-coordinator.test.ts` | 本轮 Worker Lease CAS 提交 |
| Host 工具权限 | Tool Registry deny 优先的 allow/deny 策略作用于 list/discover/ToolSet/execute/admission；参数仍由 Zod schema fail-closed 校验 | `tests/tool-context.test.ts`、`tests/tool-host.test.ts` | `a333a98` |
| 叶子级隐私 taint | Result/History/Effect/Complete/LLM 投影传播叶子路径 taint；严格级别提升并阻断云端路由；ContextDelta 同时校验来源和 taint | `tests/privacy-provenance.test.ts` | `0e64cb0`、`8b9e3db` |
| DSL 快照来源追踪 | DSL 自动记录 Global/Lane Snapshot、历史与 Join Outcome 的 `derivedFrom`；Runtime、Effect 结算和持久化校验识别快照来源并继承隐私 | `tests/privacy-provenance.test.ts`、`tests/m4-dsl-e2e.test.ts` | `03a3646` |
| FailAction 隐私审计 | FailAction 的来源与隐私在 validate 阶段重算，原子写入 Lane failure 终态；显式宽松标签被拒绝 | `tests/privacy-provenance.test.ts` | `7ceb9e7` |
| 派生 taint 传播 | Result/Global/Lane 来源的叶子 taint 以带来源路径继续传播到 Effect Result、Complete Result 与 Context metadata | `tests/privacy-provenance.test.ts` | `85be1e9` |
| Result summary 大小门禁 | 按 Runtime 配置限制结构化摘要字节数；超限摘要不进入 ResultStore，并追加 `result.summary_rejected` 审计事件；限制随 Session 恢复 | `tests/result-summary-budget.test.ts`、`tests/storage-session.test.ts` | `4cec053` |
| Artifact 引用与存储 | Runtime 提供带 SHA-256、media type、大小、隐私来源、pin/residency 的 ArtifactRecord；支持内容读取、Session 恢复及 Artifact-derived provenance | `tests/artifacts.test.ts`、`tests/storage-session.test.ts` | `da66f82` |
| Artifact Context 接入 | LLM Context 显式接收 `artifactRefs`，投影记录 Artifact 元数据、隐私与来源；DSL `inputs.artifacts` 自动合并到 Effect provenance | `tests/artifacts.test.ts`、`tests/m3-context-adapters.test.ts`、`tests/dsl-host-macros.test.ts` | `e60f13f` |
| Finding 证据记录 | `FindingRecord` 以 `statement + evidenceRefs: DataRef[]` 进入 ResultStore；发布时校验证据可见性、来源隐私与持久化引用 | `tests/findings.test.ts` | `e43d681` |
| 结构化 DataRef / PrivacyRef | Result/Artifact/Effect/ContextDelta/Action provenance 支持结构化 `DataRef`；LLM 投影对 Result/Artifact 隐私来源保留 `{ kind, ref }` | `tests/artifacts.test.ts`、`tests/privacy-provenance.test.ts` | `616f23e`、`e519ab5` |
| Step 纯度注册门禁 | Runtime 注册普通 `LaneProgram` 时自动检查 `Date.now/Math.random/fetch/await`，并覆盖 error boundary 与 series member，避免绕过主动 `assertProgramPure()` | `tests/runtime-control.test.ts`、`tests/m4-dsl-e2e.test.ts` | `69a20fe` |
| Fork Affinity 组内依赖 | 相同 Program 的亲和折叠支持组内 `dependsOn` 拓扑排序、成功/已结算条件、成员结果注入与失败传播；运行时 `forkAffinity=coalesce` 自动合并可安全折叠的 Fork，并按原始成员 key 恢复 Join Outcome；组外依赖仍保持 fail-closed | `tests/fork-affinity.test.ts` | `c0bb520`、`2ec9f05` |
| Fork Affinity 默认策略 | M1.5 后默认启用 `forkAffinity=advise`，显式 `off` 仍关闭亲和建议；旧快照缺省值按当前架构恢复为 `advise` | `tests/fork-affinity.test.ts` | `ee722a3` |
| Session Agent 隔离 | `runtime.start(agentId)` 只等待指定 Agent；同一 Runtime 中其他 Agent/Detached scope 不会污染该 Session 的 outcome；计时器推进和终态持久化保持一致 | `tests/m4-dsl-e2e.test.ts`、`tests/dsl-host-macros.test.ts`、`tests/storage-outbox.test.ts` | `4c9668c` |
| Agent-scoped Run API | `runtime.run(agentId)` 按指定 Agent 等待终态并返回其 Quarantine Effect；兼容保留无参和数字 tick 上限调用 | `tests/agent-creation.test.ts`、`tests/m4-dsl-e2e.test.ts` | `ced2266` |
| Session 事实流隔离 | Session stream 只发出目标 Agent 的事实事件，但游标跨过共享 Runtime 的其他 Agent 事件；Host snapshot 同时暴露 Global Context privacy metadata | `tests/m4-dsl-e2e.test.ts`、`tests/warm-start.test.ts` | `fe9554a`、`596fecb` |
| Session DSL 契约对齐 | `Session.snapshot()` 按规范返回异步 Promise；流事件提供规范字段 `kind`，同时保留兼容字段 `type` | `tests/m4-dsl-e2e.test.ts` | `89e6641` |
| Session 快照隔离 | Host 读取的 Session snapshot 对 Agent/Lane/Effect/Wait/Result/MergeProposal/Quarantine 均做深拷贝，宿主修改不会污染 Runtime | `tests/m4-dsl-e2e.test.ts` | `c9ef305` |
| Session Host Promise 语义 | `reply()`/`cancel()` 的入队、归属、参数和存储异常统一通过 Promise reject 暴露，不同步逃逸异常或排队非法取消命令 | `tests/m4-dsl-e2e.test.ts` | `02c0162` |
| Worker durable lease | Worker snapshot/restore 增加原子文件后端；HTTP Coordinator 自动回收过期 lease，fresh Worker 可接管在途任务 | `tests/worker-coordinator.test.ts`、`tests/worker-http.test.ts` | `fe1fb95` |
| HTTP telemetry exporter | Runtime telemetry 支持带超时、请求头和非 2xx 失败语义的 HTTP POST 导出 | `tests/observation-shutdown.test.ts` | `a4bf19d` |
| 可复用 ReAct Lane 模板 | `defineReActLane` 保留最终 `resultRef`，支持模板级 `system/toolSet`、`outputSchema` 与 `historyCompaction`，模型请求继续走统一 ContextBuilder | `tests/dsl-host-macros.test.ts` | `6151318` |
| 进程级恢复验收 | 子进程先持久化在途写 Effect 后被 `SIGKILL`，父进程通过真实文件后端恢复 `reconcile_required`、Quarantine 与资源锁隔离 | `tests/storage-outbox.test.ts`、`tests/process-recovery-child.ts` | `29a8e4c` |
| RecoverableTool executionRef | `defineTool` 可声明执行引用，ToolRegistry/Executor 在成功或中断后持久化该引用；真实文件写入中断后可通过引用完成 reconcile | `tests/tool-host.test.ts` | `748c66f` |
| LLM 结算结构化历史 | HistoryRecord 保存 effectId、ResultRef 选择规则/hash、结算结果和 Finding 引用；兼容旧快照字段 | `tests/history-llm-settlement.test.ts` | `8ab7642` |
| Artifact 驻留策略 | Artifact 纳入 SessionStoragePolicy 的大小、pin、compact 和 persisted residency 管理 | `tests/artifacts.test.ts` | `bd64dbe` |
| Artifact 持久化状态一致性 | backend 成功保存后才把 Runtime 与恢复快照中的 Artifact 标记为 `persisted`；保存失败保持 `memory` | `tests/storage-outbox.test.ts` | `4a854e9` |
| Effect 错误可重试性 | RuntimeError/ToolError 传播 retryable 与 details；明确不可重试错误阻止重复 Attempt，Provider/Worker 标记不再丢失 | `tests/tool-host.test.ts`、`tests/retry-policy.test.ts` | `3ea112d` |
| Progress Admission | Watchdog 在 validate/commit 前计算规范化 Action 与 ResumePoint 指纹；重复外部 Action 注入 replan/fail，拒绝事务不派发 | `tests/watchdog.test.ts` | `d0266a1` |
| 非 JSON Tool 输出 | 二进制或不可 JSON 化 Tool 输出转为 Artifact，Result 只保留 `{ artifactRef }` 并验证内容引用 | `tests/tool-host.test.ts` | `3edce15` |
| Finding 事务与可见性 | Finding 发布先预检，再通过 MutationLog 原子提交；重放恢复结果、共享 Result 序号和 owner Lane 可见性 | `tests/findings.test.ts`、`tests/storage-mutation-log.test.ts` | `cfc81d0`、`2394813` |
| Effect 结算存储准入 | Artifact、Result、Lane、Correlation、closing Lane 终态与 Effect 结算先统一执行 storage admission；超限时整笔 Effect/Lane 失败，不产生半个 Artifact/Result，重试仍保持真实 Effect 身份 | `tests/result-summary-budget.test.ts`、`tests/retry-policy.test.ts`、`tests/m2-scheduler.test.ts` | `d267bb6`、本轮终态提交 |
| 事实事件硬上限 fail-closed | Step/结算遇到无法容纳事实事件的 storage limit 时进入结构化失败终态；拒绝事件仅在可安全写入时追加，不抛异常、不重复排队 | `tests/result-summary-budget.test.ts` | 本轮事件压力提交 |
| 统一事件入口准入 | Runtime 直接事件入口先在候选状态上执行 StoragePolicy hard-limit 预检，再追加真实事件；Host Fact 超限时保持队列并允许重试 | `tests/runtime-control.test.ts`、`tests/storage-policy.test.ts` | `b554078` |
| 结算后存储策略同步 | 直接 `completeEffect()` 结算后立即重建 Runtime StoragePolicy，后续准入不读取过期的驻内存占用 | `tests/storage-policy.test.ts` | 本轮存储同步提交 |
| 存储策略重建事务性 | Runtime 重建 live StoragePolicy 时先在候选副本上完成全部写入；任一 hard limit 失败则 live records、pin sources 与 Result residency 保持不变 | `tests/storage-policy.test.ts` | 本轮存储策略事务提交 |
| Storage residency 稳定性 | 同一内容重复进入 StoragePolicy 时保留已确认的 `persisted`/`compacted` 状态，避免同步过程重新物化驻内存正文 | `tests/storage-policy.test.ts` | 本轮 residency 提交 |
| Fact Inbox 持久化与 pin | 未消费 Host Fact 随 Runtime persistence 快照恢复，去重历史与 `host-command-N` 序号保持连续；队列期间 pin，消费后清理索引 | `tests/fact-inbox.test.ts`、`tests/storage-outbox.test.ts`、`tests/storage-policy.test.ts` | 本轮 Fact Inbox 提交 |
| Host Fact Agent 隔离 | Reply Fact 携带 Agent 身份；Session API 与 Runtime apply 双重校验，跨 Agent Human Effect 响应被拒绝并记录 `command.rejected` | `tests/effect-hosts.test.ts` | 本轮 Host 隔离提交 |
| Host Fact 失败保留 | Runtime 逐条消费 Fact；命令事务发生 storage admission 异常时恢复当前 Fact，避免 drain 后丢失事实并允许重试 | `tests/runtime-control.test.ts`、`tests/fact-inbox.test.ts`、`tests/storage-outbox.test.ts` | `e29d501` |
| Host 优先级确认事务 | Lane priority 变更与 `command.applied` 确认事件使用同一 MutationLog 事务，并以 Fact `eventId` 作为幂等身份 | `tests/host-commands.test.ts` | `54502fc` |
| Host 命令拒绝事务 | Host Reply/Cancel/优先级命令的拒绝与 `command.applied` 确认事件作为同一只读事务提交，拒绝路径失败时 Fact 保留 | `tests/effect-hosts.test.ts`、`tests/host-commands.test.ts` | `a65affa` |
| Host Reply 类型边界 | Reply 只允许未结算的 HumanEffect；Tool/Timer/其他 Effect 仍由各自 Executor 结算 | `tests/effect-hosts.test.ts` | 本轮 Reply 类型提交 |
| Host Fact 存储准入原子性 | 排队 Host Fact 先在候选 Inbox/StoragePolicy 上预检；快照 hard limit 失败时不进入真实队列、不消耗命令序号、不留下半个 pin 记录 | `tests/storage-policy.test.ts` | 本轮 Host Fact 准入提交 |
| Host 命令 API | `requestCancel()`、`setLanePriority()`、`inspectLane()` 已接入 FactInbox；优先级修改与审计事件通过同一 MutationLog 事务提交，递增 Lane version，排队期间不重入当前 Step | `tests/host-commands.test.ts` | `5cf3af9`、`d96dd00` |
| EffectHandle 取消边界 | EffectHandle 提供实时 `status()` 与排队式 `requestCancel()`；句柄携带 Agent 归属，取消经 FactInbox 校验后才调用 Effect 取消路径 | `tests/host-commands.test.ts`、`tests/effect-hosts.test.ts` | `a8bb883` |
| Agent 创建事务 | Runtime 创建 Agent 时先生成候选 Agent/Root Lane，再将两条记录与 ID 游标作为一个 MutationLog 事务提交；显式/自动 ID 冲突 fail-closed；Storage hard limit 失败不留下记录、不消耗 ID | `tests/agent-creation.test.ts`、`tests/artifacts.test.ts` | `94c4d69`、`2c778e5` |
| Detached Agent 事件准入 | `detachAgent/attachAgent` 在改变 detached 状态前预检审计事件；事件硬上限失败时不留下半个后台 Scope 状态 | `tests/agent-effect.test.ts` | 本轮 Detached 准入提交 |
| Fact Inbox 快照顺序校验 | 恢复时拒绝重复去重历史和乱序 `receivedSeq`，不把损坏快照静默归一化成另一条事实顺序 | `tests/fact-inbox.test.ts` | 本轮 Fact Inbox 校验提交 |
| Runtime 共享快照 CAS | File Runtime persistence 使用跨进程 lock + integrity digest compare-and-swap；陈旧 Runtime 不得覆盖最新状态、Mutation log 或 outbox | `tests/storage-outbox.test.ts` | 本轮 Runtime Persistence CAS 提交 |
| 恢复程序版本兼容 | Runtime 恢复时要求活动 Lane 的 `programId@version` 已注册；缺失版本在 Tick 前 fail-closed，不把兼容性错误伪装成业务失败 | `tests/runtime-control.test.ts` | 本轮恢复版本提交 |
| 恢复工具版本兼容 | Tool manifest 版本随 Effect 持久化；恢复活动 Tool Effect 时由宿主提供当前版本，缺失或不一致在 Tick 前 fail-closed | `tests/runtime-control.test.ts`、`tests/tool-host.test.ts` | 本轮工具版本提交 |
| Result 外部索引与读穿 | Persistence backend 可把 Result 正文写入独立 ResultStore，快照只保留稳定 ResultRef 索引；恢复时读穿正文并重新校验快照完整性 | `tests/storage-outbox.test.ts` | 本轮 ResultStore 提交 |
| 取消事务存储准入 | Agent/子 Agent/Lane/Effect 取消前预检全部取消事件，存储不足时不留下半取消状态 | `tests/runtime-control.test.ts` | 本轮取消准入提交 |
| 事实事件外部归档 | Checkpoint 截断内存事实事件前写入幂等 EventArchive，并记录 archive watermark；归档失败不保存、不截断 | `tests/storage-outbox.test.ts` | 本轮事件归档提交 |
| 确定性调度基准 | 提供串行、批量 Tool、多 Lane、`forkAffinity: coalesce` 四模式对照；输出样本、均值、p50/p95、终态、Effect/Lane 结构指标 | `benchmarks/deterministic.mjs`、`benchmarks/README.md` | `a4b6672` |

统一验证命令为 `npx tsc -b --pretty false && npm test`；当前结果为 49 个测试文件、284/284 通过，`npm run build` 和 `git diff --check` 也已通过。HTTP Worker 测试需要允许本机回环端口监听。

以下内容没有被无凭证确定性测试伪装成“已完成”：有效凭证下的真实 Provider Live Smoke、真实远程写系统的副作用对账、生产级持久化事务边界，以及真实网络下的 Provider 工具 schema/取消验证。确定性持久化、进程级 SIGKILL 恢复、本地文件副作用对账、pin/retention 和 telemetry 已补齐对应代码与测试，但不替代真实远程系统/网络证据。

> **里程碑边界**：M1 的 Context/模型/DSL 主链已经实现；record 级 Privacy、Progress Watchdog、Fork Affinity、warm start、ResultRef 隔离、结构化拒绝输出、持久化恢复入口和 correlated telemetry 已补入当前代码。真实远程副作用对账、生产级持久化事务边界和真实 Provider 验证仍保持独立 Gate，不用本地测试冒充完成。

---

## 2. Monorepo 工程脚手架与技术选型

### 2.1 技术栈基准

- **运行环境**：Node.js >= 22.0.0（原生 ESM、`node:crypto`、`node:events`）
- **包管理器**：`pnpm` >= 9.0（Strict Workspaces）
- **开发语言**：TypeScript 5.5+（`target: ES2023`, `module: NodeNext`）
- **测试框架**：`vitest`（原生 ESM 支持、毫秒级执行、内置 Fake Timers）
- **构建工具**：`tsup`（基于 esbuild，极速产出 ESM 与 `.d.ts`）
- **核心依赖约束**：
  - `packages/runtime` 坚守极简，仅引入 `zod`（Schema 校验）与 `immer`（Draft 代理），**禁止引入重外部网络/框架依赖**。

### 2.2 仓库目录拓扑

```text
pulse/
├── pnpm-workspace.yaml
├── package.json
├── tsconfig.base.json
├── vitest.config.ts
├── packages/
│   ├── runtime/                    # 核心调度内核与运行时状态转换
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── src/
│   │       ├── index.ts
│   │       ├── core/               # records、actions、events、errors、mutations
│   │       ├── transitions/        # 两阶段提交事务引擎 (validate, apply)
│   │       ├── dependencies/       # 依赖拓扑图、死锁环检测、WaitingIndex
│   │       ├── scheduler/          # 优先级计算、Aging、Tick 循环、TimerWheel
│   │       ├── lifecycle/          # QuarantineScope、CancellationScope
│   │       ├── effects/            # Effect 队列、Attempt 生命周期
│   │       ├── context/            # 三层 Context、稳定前缀、ContextBuilder
│   │       ├── models/             # ModelRegistry、ModelRouter、请求准备与 usage
│   │       ├── storage/            # 内存存储、日志接口、导出
│   │       └── dsl/                # 应用层 StepBuilder、宏步编译器、Session Facade
│   ├── tool-sdk/                   # 工具契约与 Manifest
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── src/
│   │       ├── index.ts
│   │       ├── tool.ts             # defineTool API 与类型
│   │       └── schema.ts           # Zod 到 JSON Schema 构建器
│   └── adapters/                   # 模型与外部系统适配器
│       ├── package.json
│       ├── tsconfig.json
│       └── src/
│           ├── index.ts
│           ├── providers/
│           │   ├── factory.ts      # createProviderAdapter 统一入口
│           │   ├── openai-compat.ts# OpenAI-compatible Adapter（M1 选定 Provider）
│           │   ├── anthropic.ts    # 可选 Anthropic Adapter 与缓存映射
│           │   └── mock.ts         # 测试用受控 MockAdapter
│           └── tools/
│               ├── filesystem.ts   # readFile, writeFile, listFiles
│               └── shell.ts        # 带超时与进程组隔离的 ShellExecutor
├── tests/
│   ├── fixtures/                   # 离线 Provider 响应快照
│   ├── m0-acceptance/              # 主架构第 26 节全部 M0 场景
│   ├── m1-integration/             # Context 投影、模型路由、工具交互测试
│   └── e2e/                        # 端到端真实/Mock 排障流水线测试
└── examples/
    └── login-troubleshooting/      # 第 23 节完整实战示例
```

---

## 3. 多模型生态接入设计（@pulse/adapters）

M1 先实现一个真实 Provider Adapter 和一个受控 MockAdapter；其余 Provider 通过相同接口逐步接入，不作为 M1 核心交付。适配层采用“**通用 OpenAI-Compatible 核心 + 厂商预设 + 可选的 Anthropic 专用层**”的架构。Provider 的缓存能力只作为 Adapter 优化和观测指标，不改变 Pulse 的状态语义。

```text
                     createProviderAdapter(config)
                                  │
         ┌────────────────────────┴────────────────────────┐
         ▼                                                 ▼
OpenAICompatibleAdapter                            AnthropicAdapter (可选)
(标准 Chat Completions + Tool Calls)             (Messages API + 可选缓存映射)
 ├─ Preset: 一个 M1 选定的真实 Provider                └─ 后续接入 Claude
 ├─ Preset: 受控 MockAdapter（M1 必备）
 └─ 后续扩展：DeepSeek / Qwen / GLM / MiniMax / Ollama / OpenAI
         │                                                 │
         └────────────────────────┬────────────────────────┘
                                  ▼
                     统一归一化为 LLMResult
       - Pulse 自有 toolCallId 映射与生成
       - finishReason 归一化 (tool_calls, stop, length, error)
       - Token & 可用缓存指标标准化 (ModelUsage；缺失值保持缺失)
```

### 3.1 统一适配器接口契约

```ts
export interface ProviderAdapter {
  readonly id: string
  readonly name: string
  
  executeAttempt(params: {
    request: LLMRequestProjection     // 由 Runtime ModelEffectExecutor 构建的固定投影
    signal: AbortSignal
    onObservation?: (chunk: string) => void
  }): Promise<LLMResult>
}

export interface ProviderPresetConfig {
  provider: 'deepseek' | 'qwen' | 'glm' | 'minimax' | 'anthropic' | 'openai' | 'ollama' | 'custom'
  apiKey?: string
  baseURL?: string
  defaultModel?: string
  extraHeaders?: Record<string, string>
}
```

Adapter 只负责 Provider 请求和响应归一化：它不生成 `RuntimeAction`、不执行工具、不修改 Context。返回的 `LLMResult.privacy` / `derivedFrom` 只是待验证声明，Runtime 必须根据固定 `LLMContextSpec` 重新计算；Pulse 在归一化阶段生成自己的 `toolCallId`。具体 Provider 的 API key 只存在 Host/Adapter 配置中，不进入 Effect input 或日志。

---

## 4. 四阶段门禁阶梯式推进计划

按照共识，采用严格门禁策略：**上一阶段单测与门禁全绿，方可启动下一阶段**。

```text
┌──────────────┐      ┌──────────────┐      ┌──────────────┐      ┌──────────────┐
│  Milestone 1 │ ───> │  Milestone 2 │ ───> │  Milestone 3 │ ───> │  Milestone 4 │
│ 内核状态图层 │      │ 调度与M0验收 │      │ 上下文与模型 │      │ DSL与E2E实战 │
└──────────────┘      └──────────────┘      └──────────────┘      └──────────────┘
```

---

### 4.1 Milestone 1：内核数据契约、纯函数事务引擎与依赖图（M1-1）

#### 核心目标
建立完全确定性、可序列化的数据层。实现单写者两阶段提交状态转移引擎 `validate(state, input) -> Mutation[]` 与 `apply(state, Mutation[])`，以及无遗漏死锁环检测算法。

#### 具体任务拆解
1. **类型定义 (`packages/runtime/src/core/`)**
   - 编写 `records.ts`：`AgentRecord`, `LaneRecord`, `EffectRecord`, `WaitRecord`, `ResultRecord`
   - 编写 `actions.ts`：M0 包含 `SubmitEffectsAction`, `ForkAction`, `WaitAction`, `CancelLaneAction`, `ProposeCancelAction`, `CompleteAction`, `FailAction`；M1 增加 `AdoptContextAction`；M1.5 增加 `DowngradePrivacyAction`
   - 编写 `mutations.ts`：不可变状态变更原子操作集
   - 编写 `events.ts`：运行时事实事件与观测事件规范
2. **两阶段状态转移引擎 (`packages/runtime/src/transitions/`)**
   - 实现 `validate(state, input): { mutations: Mutation[] } | { rejection: ControlError }`（必须纯函数、禁止任何副作用、全面校验引用完整性与单一 Wait 约束）
   - 实现 `apply(state, mutations: Mutation[]): void`（不可失败、零 I/O、确定性更新内存数据索引）
3. **依赖拓扑与循环检测 (`packages/runtime/src/dependencies/`)**
   - 实现 `DependencyGraph`：维护 Lane 间与 Effect 间有向依赖边
   - 实现 `CycleDetector`：Tarjan 算法检测死锁闭环（按架构规则，仅 `children: 'await'` 形成死锁边，`cancel` 不误判）
   - 实现 `WaitingIndex`：按依赖键索引，保证上游发布不可变结果时，下游不会丢失唤醒（Lost Wakeup）；具体复杂度以基准测试为准，不把 $O(1)$ 作为未验证的契约

#### 验收门禁 Gate 1
- [x] 确定性事务验证：代表性合法 `Mutation[]` 的 `apply` 不抛异常且非法输入在 `validate` 阶段拒绝；完整 property-based 生成器仍待补充。
- [x] 循环检测门禁：通过包含自依赖、兄弟环、跨代祖先依赖等 10 组拓扑测试用例。
- [x] 单一 Wait 门禁：多 Wait 来源组合触发 `MULTIPLE_WAIT_SOURCES` 原子拒绝并生成结构化拒绝结果。

---

### 4.2 Milestone 2：调度引擎、QuarantineScope 与 M0 确定性验收闭环（M1-2）

#### 核心目标
构建核心事件循环驱动、多队列管理、时间轮唤醒以及失联收尾隔离区。使用受控 Virtual Clock 跑通主架构第 26 节全部标记为 M0 的验收场景；场景数量以主架构为准，不在本计划中重复维护固定数字。

#### 具体任务拆解
1. **时间轮与虚拟时钟 (`packages/runtime/src/scheduler/timer-wheel.ts`)**
   - 实现精确时间轮（TimerWheel），统一管理 Effect Attempt 超时、Wait Deadline、重试 Backoff
   - 实现 `VirtualClock`：支持毫秒级步进推进、事件快进、确定性注入
2. **调度队列与优先级计算 (`packages/runtime/src/scheduler/`)**
   - 实现 `ReadyQueue`：按 `effectivePriority` + `aging` 排序；同分按 `enqueueSeq` FIFO 排序
   - 实现 `PriorityInheritance`：消费者提升下游 queued 工作分数，解除等待后精准撤回
   - 实现 `ResourceLockManager`：支持 workspace 的 shared（读）与 exclusive（写）锁排队
3. **收容隔离区与取消控制 (`packages/runtime/src/lifecycle/`)**
   - 实现 `CancellationScope`：树状结构化取消传播，仅允许 owner 剪枝自有后代（`SUPERSEDED`）
   - 实现 `QuarantineScope`：当 Effect 超过 `cancelGraceMs` 无法确认停止时，移交隔离区，允许宿主调用 `run()` 带着 `unresolvedEffectIds` 正常结束
4. **M0 确定性测试套件 (`tests/m0-acceptance/`)**
   - 基于 MockExecutor 与 VirtualClock 逐项编写主架构第 26 节规定的全部 M0 场景用例。

#### 验收门禁 Gate 2（主架构第 26 节全部 M0 验收全绿）
- [x] 单 Lane 串行推进正确性
- [x] 两 Lane 独立等待（A 等长工具不阻塞 B 多轮推进）
- [x] Lane 启动依赖（A 成功前 B 绝不执行任何业务 step）
- [x] all 汇聚等待（所有条件满足后只恢复一次）
- [x] success 上游失败优雅处理
- [x] settled 上游失败/取消汇总
- [x] onCancelled: ignore 不使 Join 失败
- [x] 上游先完成、后注册 Wait 绝不丢失唤醒
- [x] LocalRef 同批提交并等待原子生效
- [x] 多 Wait 来源原子拒绝 (`MULTIPLE_WAIT_SOURCES`)
- [x] StepTransaction 全部拒绝：Context、Lane、Effect、Cancel Intent、ResumePoint 和 Events 均不部分提交
- [x] 多 Action 原子提交：同一 Step 的 ContextDelta、后代 `cancel_lane` 与 `submit_effects` 必须整体成功或整体拒绝
- [x] 迟到完成事件 no-op，终态不被改写
- [x] 依赖闭环动态拒绝
- [x] 隐含收尾边死锁正确性校验
- [x] Fork 参数非法整批回滚，不留下半创建 Lane
- [x] 优先级与 aging 排序严格生效
- [x] 防饥饿测试：老旧低优先级工作获得派发机会
- [x] 依赖优先级继承正确穿透到 queued 工作
- [x] 不可抢占运行：提权不强行中断在途 Attempt
- [x] shared/exclusive 锁隔离与防写饥饿
- [x] 并发槽位满整批背压拒绝
- [x] Human/Timer 确认不占执行槽位
- [x] 自有子任务取消传播，共享依赖不被误取消
- [x] 兄弟 Lane 禁止直接互相 cancel（只能 propose）
- [x] 完成与取消并发竞争一致性
- [x] executionState 与 sideEffectState 分离记录
- [x] QuarantineScope 正常接收超时未确认 Effect，`run()` 正常返回
- [x] 重试 attemptId 自增而 effectId 不变，退避走时间轮
- [x] Host 命令在 drain 期间只入队不重入

以上是代表性门禁条目；完整测试矩阵必须从主架构第 26 节所有标记为 M0 的场景同步生成，新增或变更架构验收项时 CI 必须提示测试矩阵缺项。

---

### 4.3 Milestone 3：三层 Context、多模型路由与真实工具集成（M1-3）

#### 核心目标
打通受控的真实外部 I/O。实现稳定的请求投影构建器、按能力/隐私/窗口过滤的模型路由、受 RetryPolicy 约束的候选 Fallback，以及标准工具 SDK。M1 只要求一个真实 Provider Adapter；其他 Provider 先通过 Fixture 验证归一化契约。

#### 具体任务拆解
1. **三层 Context 引擎 (`packages/runtime/src/context/`)**
   - 实现 GlobalContext 快照版本管理（`v0 -> v1 -> v2`）
   - 实现 LaneContext 的 `history` 与 `state` 物理分段存储
   - 实现 `ContextBuilder`：严格按照 `System -> Policy -> Tools -> Global 快照 -> Lane History` 生成逐字节一致的稳定请求前缀，并计算 `prefixHash`
   - 实现显式 `adopt_context` 与同事务 `adoptCommittedContext`
   - 实现请求级与 ResultRef 级 `local_only` 云端阻断、`derivedFrom` 重算、Lane 可见性和显式隐私降级
2. **模型路由器与候选管理 (`packages/runtime/src/models/`)**
   - 实现 `ModelRegistry` 与 `ModelRouter`：根据任务类型（`plan`, `reason`, `summarize` 等）与隐私标记匹配合规候选
   - 实现 Runtime LLM 槽，以及 Provider/Model 执行边界的可取消静态并发槽；Provider 槽不改变 Effect 身份
   - 实现候选 Fallback：复用 Effect 标识，按 RetryPolicy 顺序尝试后继模型候选；只有错误可重试、本地清理完成、deadline/limits 允许且 `sideEffectState` 为 `none` 或已完成对账时才允许切换
3. **Provider 适配器实现 (`packages/adapters/src/providers/`)**
   - 实现一个 M1 选定的真实 Adapter，以及 `MockAdapter`；其他 Provider 通过 Fixture 验证字段归一化，不作为 M1 必交付
   - Anthropic/Provider cache control 作为后续 Adapter 优化；支持时记录指标，不把缓存命中当成 Runtime 正确性的前提
   - 实现统一 `LLMResult` 归一化与 Pulse 自有 `toolCallId` 强绑定；Adapter 不产生 RuntimeAction、不执行工具
   - 实现三层输出校验：Adapter 字段归一化、`outputSchema`/structured 校验、下一同步 Step 的 Action Decoder；非法输出进入 `rejected_output`，不发布业务 ResultRef，并通过 `rejectedOutputRefs` 供新 Effect 自愈
4. **工具 SDK 与真实执行器 (`packages/tool-sdk/`, `packages/adapters/src/tools/`)**
   - 实现 `defineTool` API，自动由 Zod 生成标准 JSON Schema Manifest
   - Manifest 必须声明输入/输出 schema、`concurrencyClass`、资源锁、AbortSignal 能力与副作用策略；工具不得自行循环重试
   - 实现 `FilesystemTool`：安全路径沙箱校验、读写与列表
   - 实现 `ShellTool`：子进程组管理、POSIX 信号优雅终止、`cancelGraceMs` 超时升级与输出缓冲截断
5. **M1 存储边界 (`packages/runtime/src/storage/`)**
   - 已实现独立的驻内存 hard cap、大小预估、自动 pin/retention、显式 compact、backend 确认后的 `persisted` 驻留状态、`SESSION_STORAGE_LIMIT_EXCEEDED` 和统一恢复入口；进程级 SIGKILL 恢复与本地文件副作用对账已有验收，真实远程副作用与生产事务边界仍属于独立恢复 Gate

#### 验收门禁 Gate 3
- [x] 稳定前缀测试：固定块顺序、Global/Lane 版本、History 追加行为和前缀稳定序列化通过测试。
- [x] Provider Fixture 测试：OpenAI-compatible / Anthropic 响应归一化为统一 `LLMResult`，Pulse `toolCallId` 正确映射；Fixture 不等于真实 Provider 已接入。
- [x] 本地与云端隐私阻断：`local_only` 投影只保留可信本地候选。
- [x] 输出分层校验：非法 Provider 响应、structured schema 失败和 Action/权限失败分别产生对应错误；被拒输出不进入 Lane history，Tool 调用必须在下一同步 Step 提交。
- [x] 模型 Fallback 测试：对可重试且已本地关闭的失败切换第二候选，维持相同的 EffectId；对 `remote_unknown + sideEffectState=unknown` 或 `duplicateExecutionPolicy='forbid'` 的情况不得直接重复派发。
- [x] Shell 进程组清理：对长时间运行的死循环脚本触发取消，验证系统无残留僵尸进程。

---

### 4.4 Milestone 4：应用层 StepBuilder DSL 与端到端真实流水线（M1-4）

#### 核心目标
构建符合人体工学的高层 DSL。实现复合宏步编译器、Immer Draft Proxy、双通道实时会话 API，并用 Mock 模型跑通“排查并修复偶发登录失败”完整业务流水线；真实 Provider 只作为独立 Live Smoke 验证。

#### 具体任务拆解
1. **复合宏步编译器 (`packages/runtime/src/dsl/`)**
   - 实现 `defineLaneProgram` 与 `StepBuilder`
   - 实现 `addStructuredLLMStep`：绑定 Zod 强类型，编译展开为 `submit -> decode -> correct`，内置 1 轮 Schema 自我纠错
   - 实现 `addReActLoopStep`：展开为带轮次上限的纯函数有限状态机
   - 实现 `addParallelStep` 与 `addDynamicForkStep`：支持静态 DAG 与动态 Fork；支持 `FORK_AFFINITY_COLLAPSIBLE` 的 DSL collapse/ack 重提，以及 Runtime `forkAffinity=coalesce` 的安全自动折叠与成员 Outcome 还原
   - 实现 `addMergeStep`：自动读取 Join Outcomes 与 MergeProposal，调用 LLM 综合结论
2. **Context 人体工学与 Draft 代理 (`packages/runtime/src/dsl/context-proxy.ts`)**
   - 基于 Proxy 捕获开发者对 `draft` 的属性写入与数组操作，自动生成标准 `ContextOp[]` 路径操作集
   - 实现 `ctx.proposeGlobal(...)`：自动带上来源 Lane 与隐私元数据
3. **宿主双通道流式 API (`packages/runtime/src/dsl/session.ts`)**
   - 实现 `runtime.start(agentId): PulseSession`
   - 通道 1：`session.stream()` 提供 `AsyncIterable`，以只读镜像异步推送 Token chunk、工具进度与 Lane 状态
   - 通道 2：`session.outcome()` 异步等待 Agent 终态
   - 实现 `gap` + `snapshot()` 观测重同步机制，保证事实事件不丢失
4. **端到端实战验证 (`examples/login-troubleshooting/`, `tests/e2e/`)**
   - 编写完整的登录偶发故障排查示例（涵盖 Main Planner -> Fork 并发 Analyze & Tests -> Fix -> Verify 汇总）
   - 使用 Mock 模型执行阻塞性全流程验证；真实模型（如已接入的 Provider）通过独立 Live Smoke 执行，不把单次模型成功作为内核 Gate。

#### 验收门禁 Gate 4
- [x] DSL 编译不变量：宏步展开、JSON ResumePoint、`Date`/随机数/外部 I/O 源码违规扫描，以及 Step 对 Runtime 状态的隔离测试通过。
- [x] 结构化自愈验证：非规范输出触发一次带错误信息的新 LLM Effect 并成功解析。
- [x] 慢消费者背压保护：在 `session.stream()` 人为阻塞消费的情况下，Runtime 内部调度 Tick 耗时不受任何影响。
- [x] 端到端实战全绿：Mock 环境成功执行登录排障 Main/Fork/Join/Synthesize 流程并汇总证据。
- [ ] Live Smoke：历史尝试曾到达真实 Provider 鉴权层并返回 `PROVIDER_HTTP_401`；本轮当前环境在 DNS 阶段返回 `ENOTFOUND api.openai.com`。需要可联网且具备有效凭证的 Host 后重新验证请求投影、`LLMResult` 归一化、工具调用关联和取消收尾。该失败只记录 Provider 集成阻塞，不否定确定性 Gate。

---

## 5. 测试与持续集成（CI）设计

为了确保工程在真实 I/O 接入前先锁定确定性语义，实行**双层测试体系**：

```text
┌──────────────────────────────────────────────────────────────────────────┐
│  Level 1：CI 自动化无凭证测试（Zero-Credential Deterministic Suite）      │
│  - 触发时机：代码提交、Pull Request                                     │
│  - 运行方式：全量 MockAdapter + 录制好的真实 Provider Fixtures           │
│  - 覆盖范围：主架构第 26 节全部 M0 场景 + Provider Fixture + DSL 编译 + Shell 沙箱 │
│  - 运行耗时：建立基线并持续监控，不设未经测量的固定承诺                     │
└────────────────────────────────────┬─────────────────────────────────────┘
                                     │ 开发者手动触发 / 夜间定时
┌────────────────────────────────────▼─────────────────────────────────────┐
│  Level 2：Live 真实模型冒烟测试（Optional Real-Network Smoke Suite）      │
│  - 触发时机：`pnpm test:live`，自动读取本地 `.env` 环境变量              │
│  - 环境变量检测：自动跳过未提供 API Key 的厂商测试                      │
│  - 覆盖场景：真实网络往返、真实 Token 消耗、真实并发与工具交互          │
└──────────────────────────────────────────────────────────────────────────┘
```

---

### 5.1 当前实现与测试证据（2026-09-20）

- `50d21b3`：Lane ResultRef 可见性隔离、显式 Fork 输入授权、ContextBuilder/DSL/快照恢复统一校验。
- `9199fbd`：成功 LLMEffect history 归档；`9eda5b1` / `2009eaa`：JSON Schema、`rejected_output` 与 DSL 自愈链路。
- `0d0ea33`：ToolCallCorrelation 持久化；`015c959`：Provider/Model 可取消并发槽。
- `79a993f` / `324f1bc` / `e6c228b`：warm start 筛选、递归 Draft Proxy、ReAct 完成回调 ResultRef 契约。
- `a95d4f5` / `8d2d0bb`：Tool admission 默认值、可信 workspace shared/exclusive 锁回退和显式资源声明覆盖。
- `b4461a8` / `1dccd67`：可恢复 Tool 对账、Runtime 对账入口和 quarantine 终态闭环。
- `af1ff6f` / `f523c71` / `32e4487`：any/quorum Join、Wait deadline 和 DSL Join 参数暴露。
- `6ac1183`：DSL 收到 `FORK_AFFINITY_COLLAPSIBLE` 后自动将可安全折叠的同 Program 组重提为 series Lane，并在 Join 恢复原始成员 key；不满足折叠条件时保留 ack 路径。
- `639c6cb`：RuntimeTelemetryExporter、原子追加的 JSONL 文件 exporter 和显式 `runtime.exportTelemetry()` 宿主出口。
- `ad09a2f`：有界 `RuntimeTelemetryAggregator`、峰值统计、阈值告警和冷却窗口。
- `290c559` / `b8f6aec` / `417ecb1`：恢复时重建 quarantine 资源锁、放弃后释放隔离锁、校验快照引用并对 malformed snapshot fail closed。
- `7a2ed52` / `3bb7ac0`：配置 `persistenceBackend` 后由 Runtime Tick、异步 Effect 结算、取消和对账路径自动排队持久化；`run()`/`shutdown()` 等待最终 durable save，`flushPersistence()` 可显式冲刷，并以文件后端恢复成功 Agent。
- `0d17d7c` / `4c65d38`：`AdaptiveModelRouter` 根据质量、延迟、价格、缓存和探索项重排候选；标准 Provider Executor 自动将 Attempt 结果写入路由反馈，并可校验恢复跨进程 snapshot。
- `e3ef1ce`：Child Agent 可转入 detached/background scope；父取消跳过 detached child 的取消传播，后台 Child 结束后仍完成原 Agent Effect，Runtime shutdown 继续统一收尾。
- `396499f`：Runtime 对 JavaScript/强制转换后的异步 Step 返回值做同步边界检查，记录 `ASYNC_STEP_FORBIDDEN` 并 fail-closed。
- `51cf23d`：Runtime 增加 Host 级 Attempt/LLM/Tool 次数预算与 currency cost 累计，排队阶段超限原子失败，恢复时从 `effect.execution_metadata` 重建费用使用量。
- `88970c4`：ToolRegistry 增加显式 `discover()` 目录检索，支持 tags、文本相关性、side-effect/concurrency 过滤和稳定排序；不自动修改当前 Lane 的 tool set。
- `480a81a`：Tool Registry 查询结果可编译为稳定版本的 ToolSet，并由 adapter preparer 注入 LLM Effect 的 `tools` 与 `toolSetId`，最终进入 Context Tools 块。
- `a333a98`：Tool Registry 增加 Host allow/deny 策略，deny 优先；被拒绝工具不会出现在 list/discover/动态 ToolSet，也不能执行或申请 admission。
- `2ea2a6b`：Checkpoint 在持久化状态快照和 Mutation 日志水位后截断事实事件前缀，恢复时保留 `eventsCompactedThrough`，Session 以 `gap` 事件触发 Host 重同步。
- `e86093a`：拒绝非法 checkpoint `eventWatermark` 与 `eventsCompactedThrough`，避免 malformed snapshot 改写恢复后的事件游标。
- `d221466`：`WorkerCoordinator` 增加多 Worker 注册、lease claim、幂等提交、主动取消、过期 lease 回收和 Runtime `EffectExecutor` 适配；确定性测试覆盖重试 attempt、并发 Worker、取消及旧 lease late settlement 丢弃。
- `d267bb6`：Effect 结算统一经过 storage admission，存储超限时原子失败；同时修复副本结算下 retry timer 必须回写真实 Effect 的身份一致性。
- 本轮终态提交：closing Lane 满足 Wait 时，最终 Result 通过同一 storage admission 与 MutationLog 提交；超限则 Lane 失败且不产生 `resultRef`。
- 本轮事件压力提交：事实事件无法容纳时 fail-closed，避免 storage rejection 自身造成未捕获异常。
- 本轮存储同步提交：直接 Effect 结算后立即刷新 StoragePolicy，避免后续准入使用过期占用。
- 本轮 residency 提交：StoragePolicy 对相同内容保留已确认 residency，避免已落盘记录被重复算作 memory。
- 本轮 Fact Inbox 提交：持久化未消费 Host Fact、恢复去重与命令序号，并纳入 StoragePolicy pin/消费后清理。
- 本轮 Host 隔离提交：Reply Fact 增加 Agent 归属，Session 与 Runtime 双重拒绝跨 Agent 响应。
- 本轮 Reply 类型提交：Reply 仅能完成 HumanEffect，避免绕过 Tool/Timer Executor。
- 本轮 Host Fact 准入提交：排队命令先在候选 FactInbox/StoragePolicy 上做快照 hard-limit 预检，失败时不修改真实队列、不消耗命令序号。
- 本轮 Detached 准入提交：后台 Scope 的审计事件先做 storage admission，失败时不修改 Agent detached 状态。
- 本轮 Fact Inbox 校验提交：恢复时拒绝重复 `seen` 和乱序 `receivedSeq`，保持事实去重与 FIFO 语义。
- 本轮 Worker 鉴权轮换提交：HTTP Worker 支持新旧 Bearer token 重叠窗口、每请求更新和恒时比较。
- 本轮 Worker TLS 提交：HTTP Worker Server 支持 HTTPS key/cert 配置，并用真实 TLS 握手验证健康检查与 Bearer 鉴权。
- 本轮 Worker 网络超时提交：HTTP Worker Client 对每次请求设置有界超时，网络分区时返回结构化 `WORKER_HTTP_TIMEOUT`。
- 本轮 Worker 对账提交：远程任务响应不确定时不把写副作用误报为普通失败，保留 task `executionRef` 并进入 Runtime reconcile/quarantine 路径。
- 本轮持久化完整性提交：Persistence/Checkpoint 快照加入 SHA-256 envelope，恢复前拒绝被篡改的状态、日志或 outbox。
- 本轮 Worker Snapshot 校验提交：Worker lease snapshot 加入 SHA-256 envelope，恢复前拒绝被篡改的任务状态、序号或幂等索引。
- 本轮 Worker 持久化错误提交：自动保存失败通过 `flushPersistence()` 暴露，不再静默视为成功。
- 本轮 Worker Lease CAS 提交：共享文件 lease store 增加跨进程锁与 digest CAS，拒绝陈旧 Coordinator 覆盖最新状态。
- 本轮 Runtime Persistence CAS 提交：共享 Runtime 快照增加跨进程锁与 digest CAS，拒绝陈旧 Runtime 覆盖最新状态、日志和 outbox。
- 本轮恢复版本提交：活动 Lane 缺少已注册的 `programId@version` 时在 Tick 前明确阻断恢复，要求宿主注册兼容版本或迁移。
- 本轮工具版本提交：Tool manifest 版本进入 Effect 持久化契约；恢复时若宿主未提供匹配版本，则在 Tick 前明确阻断恢复。
- 本轮 ResultStore 提交：Persistence backend 可把 Result 正文独立存储，快照保留 ResultRef 索引，`PulseRuntime.restore()` 恢复时读穿并重新计算完整性。
- 本轮 Result residency 提交：ResultRecord 保存 `storageState/pinCount`，与 StoragePolicy 的 pin/持久化确认同步，且不把 residency 元数据混入正文哈希。
- 本轮 Effect 控制准入提交：取消、超时和立即隔离路径统一预检控制事件及 Effect/Lane 状态，存储上限拒绝时不会写入部分状态。
- 本轮 Remote Unknown 准入提交：远程未知状态、Quarantine、Lane 未决引用和对应事实事件统一预检，存储上限拒绝时不改变对账状态。
- 本轮对账放弃准入提交：Host 放弃未知副作用前统一预检 Effect 终态、Lane 未决引用和 `resource.abandoned` 事件，失败时保留 Quarantine。
- 本轮重试准入提交：`retry_scheduled`、Effect 重试状态和到期 `retry_ready` 入队统一预检，存储上限拒绝时不提前切换逻辑 Attempt。
- 本轮 SnapshotStore 提交：Lane/Global Context Snapshot 正文通过稳定索引外置，恢复时读穿；缺少外部正文存储直接拒绝恢复。
- 本轮恢复定时器提交：恢复后立即 flush 持久化时间之前已到期的 retry/wait timer；retry_ready 与 Wait deadline 的状态和事件写入均先做存储准入。
- 本轮 File body store 提交：提供可直接用于 ResultStore/SnapshotStore 的原子文件正文存储，重复正文幂等，引用冲突和损坏正文 fail-closed。
- 本轮 File body/event store 提交：提供可直接使用的 FileRuntimeEventArchive，checkpoint 事实事件按 seq 幂等归档、冲突拒绝并支持范围读回。
- 本轮异步失败边界提交：Executor 抛错时 dispatch_failed 事件写入受限不会逃逸 Promise，Effect 仍进入失败结算和后续状态收尾。
- 本轮 Durable outbox 提交：配置持久化后，pending outbox 必须先完成 durable save 才允许 Effect Executor 启动；持久化失败时不派发外部操作。
- 本轮 Wait 结算事务提交：依赖满足/失败与 closing Lane 结果统一经 storage admission 和 MutationLog，失败时不再直接修改 Wait/Lane 内存状态。
- 本轮 Lane failure 事务提交：程序异常、异步 Step、控制错误和 Watchdog 失败不再直接改写 Lane；事实事件无法容纳时保留失败状态并省略不可写审计事件。
- 本轮 Agent 状态事务提交：Child Agent 的结束状态通过 `setAgent` Mutation + storage admission 落盘，避免 Effect 结算后的直接内存突变。
- 本轮 Agent 终态事务提交：`run()` / `runAgent()` 不再直接改写根 Agent 状态，终态统一经过 `setAgent` Mutation + storage admission。
- 本轮 Agent 取消状态事务提交：`cancelAgent()` 不再直接改写 `cancelling/cancelled`，取消状态统一进入 `setAgent` Mutation，并保留 Quarantine 未决副作用。
- 本轮 Lane/Effect 取消事务提交：Lane 取消、Effect cancel-requested 与 Quarantine 统一经过 `setLane/setEffect + appendEvent` MutationLog 事务。
- 本轮重试与 Remote Unknown 事务提交：retry scheduled/ready、Remote Unknown 及 reconciliation abandon 不再在准入后直接改写 live Effect/Lane。
- 本轮 Step 存储拒绝收尾提交：Step mutation 准入失败不再直接改写 Lane，统一通过 `failLane()` 提交失败终态。
- 本轮恢复 Effect 事务提交：恢复阶段对 running Effect 的 requeue/reconcile_required 修正写入 MutationLog，并继续恢复 Quarantine。
- 本轮 Effect dispatch 事务提交：Effect 只有在 `running + Attempt` 通过 storage admission 并写入 MutationLog 后才进入 Executor。
- 本轮 Remote Unknown 重试准入提交：可重试 Remote Unknown 不再先改 live Effect，retry admission 失败时保留原 Attempt 状态。
- 本轮 Effect 正常结算事务提交：正常结算不再分散写入 Effect/Result/Artifact/Lane/Event，统一由 settlement MutationLog 事务提交。
- 本轮 Effect 结算拒绝事务提交：结算产物超限时通过 storage-rejected MutationLog 事务提交失败 Effect，事件无法容纳时保留无事件失败终态。
- 本轮取消准入提交：取消父/子 Agent 前统一预检 Lane、Effect、Agent 事件，存储准入失败时不修改任何取消状态。
- 本轮事件归档提交：Checkpoint 截断前写入 EventArchive 并记录归档水位，归档失败时保留内存事实事件和旧持久化快照。
- `2250df2`：Runtime Worker lease 暴露远程 claim/renew/complete/fail 协议；adapters 增加 HTTP Coordinator Server、Client、polling Worker 和 HTTP EffectExecutor，测试覆盖真实本机 HTTP 往返、heartbeat 与 Runtime Effect 闭环。
- `685be10`：HTTP Worker Server/Client 增加 Bearer token 鉴权，未授权请求在任务访问前拒绝，并有回归测试。
- `47791bd`：WorkerCoordinator 增加 schemaVersion=1 的 snapshot/restore；恢复时将 in-flight lease 重新入队，并让终态/幂等任务在重启后仍可返回结果。
- `2ec9f05`：Runtime 增加 `forkAffinity=coalesce`；对兼容亲和组按内部依赖拓扑合并为 series Lane，并在 Join 阶段按原始成员 key 映射聚合 Outcome；不满足同 Program、同 Context 或组内依赖条件时保持原 Fork。
- `0e64cb0` / `8b9e3db`：补齐 Result/History/Effect/Complete/LLM 投影的叶子级 Privacy Taint，并在 ContextDelta 校验来源、严格隐私级别和 taint 结构。
- `4c9668c`：`runtime.start(agentId)` 改为调用 Agent-scoped 执行入口，修复多 Agent Runtime 下 Session outcome 串线，并覆盖 Timer/持久化收尾。
- `fe1fb95`：Worker 增加原子文件持久化、恢复重排队和 HTTP 服务端自动 lease reaper。
- `a4bf19d`：增加可超时、带鉴权请求头和非 2xx 失败语义的 HTTP telemetry exporter。
- `8bb07e5`：Global/Lane Context 增加不改变业务 JSON 形状的 privacy metadata sidecar；版本、持久化恢复、ContextBuilder、ContextMerger 和 warm start 均保留该元数据。
- `fe9554a` / `596fecb`：Session outcome 和 fact stream 均按 Agent 隔离，Host snapshot 暴露 Global Context privacy metadata。
- `89e6641`：Session 对齐 DSL 规范，`snapshot()` 改为异步重同步接口，流事件增加 `kind` 并保留 `type` 兼容别名。
- `c9ef305`：Session snapshot 对所有嵌套状态做深拷贝，宿主只读检查不会通过共享引用改写 Runtime。
- `3f70131`：控制错误重试输入、连续错误计数和 Watchdog 干预状态与审计事件统一进入 Lane Mutation 事务，避免拒绝路径直接修改 live record。
- `ed61be0`：成功 Step 在同一事务中消费 `pendingResumeInput`、清除控制错误计数并提交 Watchdog 状态与事件，避免崩溃恢复时重复消费控制输入。
- `11aa4d4`：Agent 终态 `setAgent` storage admission 失败时 fail-closed 抛出 `SESSION_STORAGE_LIMIT_EXCEEDED`，不再让 Lane 结果掩盖 Agent 状态未提交。
- `02c0162`：Session `reply()`/`cancel()` 统一为真实 Promise API，非法 reason、跨 Agent Effect 和入队准入异常均以 reject 交付 Host。
- `e29d501`：FactInbox 改为逐条处理，命令事务失败时恢复当前 Fact；重复重试不会再次写入同一 `command.enqueued` 镜像事件。
- `6e1d295`：补充 Host Fact 存储拒绝后的恢复重试回归，验证命令最终应用且 `command.enqueued` 镜像保持幂等。
- `6c89fe2`：MutationLog 增加 prepare/commit 分层；不可克隆 Mutation 的失败不会消耗日志序号，Runtime 状态 apply 使用独立副本，避免状态记录与日志共享可变引用。
- `b554078`：Runtime 统一 `emit()` 入口先执行候选状态 StoragePolicy 预检，直接事实事件不再绕过 hard limit；Host Fact 超限时不会提前消费或写入事件。
- `54502fc`：Host 优先级命令把 Lane 变更与 `command.applied` 放入同一 MutationLog 事务，并以 Fact `eventId` 固定事务身份，避免状态已改但确认未落盘。
- `a65affa`：Host 命令的 Reply/Cancel/优先级拒绝结果与 `command.applied` 确认改为同一只读 MutationLog 事务，避免重试重复生成拒绝事件。
- `5cf3af9`：补齐 `requestCancel()`、`setLanePriority()`、`inspectLane()` Host API；优先级变更经过 FactInbox、存储准入和 MutationLog 事务，不重入当前 Step。
- `94c4d69`：Runtime Agent 创建改为 Agent、Root Lane 与 ID 游标一同提交；创建准入失败不会留下半个 Agent 或消耗 ID。
- `ced2266`：补齐架构示例使用的 `runtime.run(agentId)`，并保留旧的无参/数字 tick 上限调用。
- `a8bb883`：补齐架构定义的 `EffectHandle`，句柄状态可读，取消请求经 FactInbox 和 Agent 归属校验后执行。
- `d96dd00`：Host 优先级变更递增 Lane version，保持 OCC 与恢复点语义一致。
- `2c778e5`：创建阶段拒绝重复显式 Agent ID，并让自动 Agent ID 跳过已占用序号。
- `5dc799a`：外置 Result/Snapshot 正文索引缺失时 fail-closed，并支持 checkpoint 同时外置两类正文后完整恢复。
- `4a854e9` / `2394813`：backend 确认后的 Artifact residency 与 Finding 发布事务/owner Lane 可见性保持一致。
- `ee722a3`：M1.5 亲和检查已经交付，Runtime 默认 `forkAffinity` 从 `off` 切换为架构规定的 `advise`；显式 `off` 仍可关闭检查，旧快照缺省值也按当前规范恢复为 `advise`。
- 当前确定性门禁：`npm test`，49 个测试文件、286 个测试通过；`npm run build` 与 `git diff --check` 通过。此前一次 Live Smoke 到达真实 HTTP 鉴权层并收到 `PROVIDER_HTTP_401`；本轮按当前环境重新尝试时在 DNS 阶段收到 `ENOTFOUND api.openai.com`，因此仍未把真实 Provider 证明写成通过。

### 5.2 当前仍未达到“完全可用”的验收项

| 验收项 | 当前状态 | 缺口 |
| --- | --- | --- |
| 真实 Provider Live Smoke | 已执行但被鉴权阻塞 | 请求已到真实 HTTP endpoint，当前返回 `PROVIDER_HTTP_401`；需要有效凭证验证 token、取消、structured output 和 tool-call 往返 |
| Runtime Storage pin/retention | 确定性代码与后端快照已覆盖，生命周期自动落盘、完整性和共享快照 CAS、ResultStore/SnapshotStore 读穿已接入 | 自动 pin、hard-limit 预检、compact、backend 确认后的 `persisted` 标记、restore、完整性校验、共享文件快照 CAS、Result/Context Snapshot 正文外部化、外置索引 fail-closed，以及 Runtime `run()`/`shutdown()`/异步 Effect 结算自动持久化已有测试；真正数据库事务仍需实现 |
| 崩溃恢复与副作用对账 | 进程级重启和本地真实写入对账已验证，远程副作用仍待验证 | 已补子进程 `SIGKILL` 后恢复、启动 quarantine、资源锁隔离，以及 `executionRef` 从 Tool 到 Runtime 的持久化链；仍缺真实远程写系统 reconcile 和生产环境的持久化事务边界证明 |
| Provider 请求完整能力 | 确定性映射已覆盖，真实厂商仍待验证 | OpenAI-compatible/Anthropic 请求带 model、tool schema、structured schema，usage 已归一化；真实 endpoint 的字段兼容、计费口径、取消和 tool-call 往返仍需有效凭证 |
| 动态模型路由 | 确定性反馈路由与 snapshot/restore 已实现 | `AdaptiveModelRouter` 已按质量、延迟、费用、缓存和探索项调整未来候选顺序，Executor 已自动采集反馈；仍需真实生产样本校准权重和跨进程快照宿主接入 |
| Detached/background scope | 单进程后台 scope 已实现 | detached Child Agent 的取消传播、查询、attach 和 Runtime shutdown 边界已有测试；跨进程/分布式 Worker 迁移仍未实现 |
| Host 调用与费用限制 | 确定性调用预算已实现 | `maxTotalAttempts`、`maxLLMAttempts`、`maxToolAttempts` 和按 currency 的 cost 累计已接入 Runtime；真实账单口径、跨 Runtime 聚合和宿主策略配置仍需生产接入 |
| 动态工具检索 | 确定性目录检索和 Context ToolSet 编译已实现 | 已按查询生成稳定版本的工具集合并写入 LLM Context；仍需按宿主权限/隐私策略做生产级准入，验证真实远程模型看到的 schema 与 tool-call 往返 |
| Host 工具权限 | 单进程 allow/deny 和 Zod 参数约束已实现 | deny 优先策略已经覆盖 Registry 目录、动态 ToolSet、执行和 admission；更细 workspace/网络权限、审计系统和生产策略配置仍需宿主接入 |
| Checkpoint / 事实事件保留 | 单进程 checkpoint 截断、EventArchive 归档与恢复 gap 已实现 | 事实状态、Mutation 水位、事件截断水位、外部归档水位和 Session gap 已有测试；跨进程故障注入和生产存储仍需验证 |
| Fork Affinity | DSL 在收到建议后可安全折叠同 Program 组；Runtime 提供可选自动 coalesce | 已验证组内依赖拓扑、成员结果注入、失败传播、原始 Join key 恢复，以及 `forkAffinity=coalesce` 的通用运行时路径；复杂跨组/外部依赖保持不折叠，生产负载校准仍需验证 |
| Worker 执行与迁移 | 本地 HTTP/HTTPS lease transport、Bearer 鉴权、polling Worker、请求超时、远程未知对账、snapshot/restore、Runtime 适配、无重启 token 轮换和文件 lease CAS 已实现 | 已验证真实 HTTP/HTTPS claim/renew/complete/fail、未授权拒绝、短 lease heartbeat、token 重叠轮换、请求超时、写副作用响应丢失后的 `remote_unknown`/`executionRef`、in-flight lease 恢复、多 Worker 语义、陈旧 Coordinator 冲突和 Runtime Effect 闭环；跨主机故障注入、真正外部共享数据库和 Worker 迁移仍需验证 |
| 运行观测 | Runtime 侧已有只读出口、JSONL/HTTP exporter、聚合和告警规则 | `inspect/explain`、`telemetry()`、JSONL/HTTP exporter 和有界聚合器已覆盖 route 排除原因、provider/model slot、Attempt usage/cost、峰值与阈值告警；外部生产指标系统接入仍需宿主配置 |

## 6. 实施时间线与任务清单（Checklist）

| 阶段 | 周期估算 | 核心交付成果 | 验收标准 |
| --- | --- | --- | --- |
| **Milestone 1** | Week 1~2 | Monorepo 基建、状态机两阶段提交引擎、依赖拓扑图 | Gate 1 门禁通过（类型完备、环检测 100% 覆盖） |
| **Milestone 2** | Week 3~4 | 调度器 Tick、时间轮、Quarantine、VirtualClock | Gate 2：主架构第 26 节全部 M0 场景全绿 |
| **Milestone 3** | Week 5~6 | 三层 Context、稳定前缀、一个真实 Adapter、Provider Fixture、工具 SDK | Gate 3：路由/隐私/归一化/前缀一致性通过 |
| **Milestone 4** | Week 7~8 | StepBuilder DSL、Session 双通道流式 API、Mock 端到端示例 | Gate 4：DSL 不变量与 Mock 端到端通过；Live Smoke 独立记录 |

---

## 7. 方案结论

本方案继承并落地《Pulse Runtime 架构设计》与《Pulse Application DSL 规范》：
1. 以主架构第 26 节的 M0/M1 标注为唯一验收来源，不重复维护场景数量。
2. M1 的真实 Adapter、受控 Mock、三层 Context、工具 SDK、StepBuilder、Session 和确定性端到端示例已贯通；其他 Provider 与真实网络任务属于独立集成验证。
3. ResultRef 隔离、record/leaf Privacy、ContextDelta provenance、Watchdog、Fork Affinity（含 DSL series collapse 与 Runtime 可选自动 coalesce）、warm start、history 归档、结构化拒绝输出、ToolCallCorrelation、Runtime 自动 Storage pin、bounded preparation、Provider 请求映射、backend restore、进程级 SIGKILL 恢复、本地 RecoverableTool 对账、Runtime 生命周期自动持久化、自适应模型路由及快照恢复、按 Agent 隔离的 Session、单进程 Detached/background scope、Step 同步边界、恢复锁重建、快照引用校验、Tool admission 默认锁、恢复程序/工具版本 fail-closed、ResultStore 外部正文读穿、事实 EventArchive 归档、取消事务存储准入、correlated telemetry、JSONL/HTTP exporter、聚合和告警规则、Bearer-authenticated HTTP lease-based Worker transport、Worker snapshot/restore、HTTP lease reaper、动态 ToolSet Context 编译、Host allow/deny 工具权限已实现并有确定性测试；真实 Provider smoke、远程副作用对账、Snapshot 外部归档索引、生产级持久化事务边界、生产级 Worker TLS/密钥轮换与共享 durable lease store、细粒度宿主权限/隐私策略生产接入、生产样本校准和外部生产指标系统接入仍未勾选。
4. 所有外部模型与工具行为都必须经统一 Effect/Attempt、隐私、取消、重试和 ResultRef 契约进入 Runtime。

已勾选条目对应的实现和测试证据已经落库；未勾选条目仍是明确的后续验收任务。本方案不把当前确定性参考实现等同于生产级可靠恢复或完整多模型产品交付。
