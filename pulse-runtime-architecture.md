# Pulse Runtime 架构设计

> 整合设计稿：2026-09-19 · 统一架构与验收依据；仓库内可实现部分已落地，外部 Provider/生产系统仍需独立验证
>
> 修订：同日架构审查结论已全部并入本文；核心仍是类 Node.js event loop
> （同步 Step = Macrotask，Scheduler Tick = Event Loop Turn，Effect = Async I/O）。
>
> 基于 Node.js + TypeScript 的单 Agent 多 Lane 事件驱动运行时。
> Lane 依赖决定执行资格，优先级决定调度顺序，Effect 承载外部操作。
> Pulse 拥有 Session 与 Context；Scheduler 决定何时计算，ModelRouter 决定由谁计算。

本文作为统一实现与验收依据。

## 1. 项目定位与边界

Pulse 让一个 Agent 的多条执行线独立推进：某条 Lane 等待工具或模型时，其他 Lane 可以继续推理、调用工具、产生结果。

```text
Agent
├─ Lane A → LLM → Tool ─────────→ LLM → Result
├─ Lane B → Tool → LLM → Result
└─ Lane C ──等待 A、B 的结果───────────→ LLM → Result
```

Agent 共享目标、身份、策略、权限、会话和全局上下文；Lane 拥有独立目标、上下文快照、执行位置、依赖和优先级。Lane 是同一个 Agent 内的执行单元，不创建独立 Agent 身份或长期记忆。

核心目标：

1. 等待局部化：等待一个 Effect 或上游 Lane 不阻塞整个 Agent。
2. 执行可控：依赖、优先级、并发额度、资源锁、取消和 Runtime Limits 统一受 Runtime 管理。
3. 结果可追踪：每次唤醒能说明原因，每个结果能追溯生产者与输入。
4. 状态可序列化：为恢复预留契约，但不把事件日志等同于已经具备可靠恢复能力。
5. 模型可替换：每次 LLMEffect 显式投影上下文、按能力路由，不把 Agent 或 Lane 固定绑定到某个模型或 Provider Conversation。

第一版以单进程、单会话内的单 Agent 调度内核为基础。Human-in-loop 与 Child Agent 使用同一 Effect/Event 模型扩展；MVP 可限制 `maxAgentDepth = 1`，即主 Agent 可创建 Child Agent，但 Child Agent 不再创建更深层 Agent。分布式执行、Memory/MCP/Skill 平台和完整 Coding Agent 产品能力不属于第一阶段核心。

多 Lane 可能减少独立工作的等待时间，也可能增加模型请求、重复调查和合并成本；实际收益由第 27 节基准验证。

## 2. 核心概念与不变量

| 概念 | 职责 |
| --- | --- |
| Agent | 目标、权限、运行限制和生命周期边界 |
| Lane | 一条可挂起、恢复、Fork、Join 的执行线 |
| Action | Lane 提交给 Runtime 的控制意图 |
| Effect | 一次逻辑外部操作，可能包含多个重试 Attempt |
| Event | 已发生事实的记录，由 Runtime 验证后影响状态 |
| Dependency | 当前继续执行必须满足的条件 |
| Scheduler | 在有执行资格的工作中分配运行机会与资源 |
| ResultStore | 保存不可变结果、错误和产物引用 |
| Pulse Session | Runtime 拥有的会话状态与记录容器，不等于 Provider Conversation |
| ContextStore / ContextBuilder | 保存 Global/Lane Context，并为单次请求生成临时投影 |
| ModelRegistry / ModelRouter | 登记模型能力与接入配置，为每次 LLMEffect 选择合规候选 |
| ModelEffectExecutor / Provider Adapter | 准备请求并执行单次模型 Attempt，回报结果与 usage |
| QuarantineScope | Runtime 内部收容无法确认停止的 Effect，使 Lane/Agent 可以进入终态 |
| TimerWheel | 统一到期唤醒：TimerEffect、Wait deadline、retry backoff、attemptTimeout |

必须保持以下不变量：

- 一条 Lane 同时最多执行一个同步 Step；不能重复入队或重入执行。
- Lane 只有在当前等待条件满足、未取消且策略允许时才成为 `ready`。
- Lane Step 不等待网络、磁盘、工具或模型；这些操作全部通过 Effect 提交。
- `LaneProgram.step()` 是 `(lane, context, resumeInput, now)` 的纯函数：禁止读取 `Date.now()` / `Math.random()` / 全局可变状态；时钟与随机性由 Runtime 注入。否则日志重放无法只应用已记录事实。
- 上游成功时，先发布不可变结果，再使依赖者可执行。
- Lane/Effect 的终态不可被迟到事件改写；逻辑结果至多发布一次。
- 依赖图不决定所有权；取消树不决定执行先后；资源锁不表达业务依赖。
- 高优先级不能绕过依赖、权限、Runtime Limits、并发上限或资源锁。
- 模型输出是待校验的 `LaneStepOutput`（ContextDelta、RuntimeAction[]、ResumePoint），不直接修改 Runtime 内部状态。
- Global Context、Lane Context 与单次 LLM Request Context 分离；模型输出和原始结果都不自动写入共享上下文。
- Result、Finding、ContextDelta、Artifact 和请求投影都携带 Privacy Label；派生数据按来源取最严格标签，`local_only` 不能被摘要或 fallback 降级。MVP 先做 record 级标签，不为每个 JSON 叶子强制包装 `PrivacyDataBlock`。
- 模型选择以 LLMEffect 为单位；切换模型不改变 Effect 身份、输入快照、权限或取消语义。
- Provider 会话和 Prompt Cache 只能优化执行，不能成为状态真源或绕过 Lane 隔离。
- Context Affinity（Lane 历史 append-only 前缀、Fork 亲和建议、跨 Session 显式 warm start）只改变请求组织、Lane 数量和初始快照的选择，不改变快照固定规则、Privacy Label 传播和 StepTransaction 语义；缓存冷热不得影响状态转换。
- SessionStoragePolicy 区分逻辑保留与驻内存占用。`maxEventLogBytes` / `maxResultBytes` / `maxSnapshotBytes` 是驻内存上限，不是逻辑删除上限。活动引用必须 pin；存储压力只能持久化/compact unpinned 数据；硬上限必须显式失败。事实事件在逻辑上不设上限；M2 用 checkpoint 截断。
- Progress Watchdog 根据 Goal、Context/Finding、Action、Result、ResumePoint 的稳定指纹判断是否推进；新 Event 本身不算进展，重复无进展达到阈值必须分级干预或失败。被拒绝的 StepTransaction 不进入 Watchdog 窗口。
- 外部副作用不承诺 exactly-once；事件去重不能防止一次 Shell 命令被外部执行两次。
- StepTransaction 必须两阶段提交：`validate` 纯函数产出 `Mutation[]` 或 Rejection；`apply(Mutation[])` 不可失败、无 IO、无校验。校验失败或 Runtime 内部异常都不留下半状态。
- `reconcile_required` 不能阻止 Lane/Agent 进入终态。超过 `cancelGraceMs` 仍无法确认停止的自有 Effect 移交 QuarantineScope，Outcome 携带 `unresolvedEffectIds`。
- `control_error` 必须携带被拒绝前的 `original` ResumeInput；连续控制错误达到上限则结构化失败，不能无限 reject。
- Host 命令与 Executor 完成事件走同一事实 Inbox；观察者、UI、telemetry 不能通过同步回调重入状态转换。
- 一个 StepTransaction 内最多一个 Wait 来源（`submit_effects.wait`、`wait`、`fork.join` 三者互斥）。

## 3. 总体架构

```text
Host / CLI
    │ commands（入事实 Inbox，不直接改状态）
    ▼
PulseRuntime ─── Agent / Lane / ContextStore / ResultStore
    │
    ├─ Command validation + Policy
    ├─ Transition engine ─── EventLog
    │     validate(state, input) → Mutation[]     # 纯函数，只读
    │     apply(state, Mutation[])                # 不可失败
    ├─ DependencyGraph ─── WaitingIndex
    ├─ CancellationScope ─── QuarantineScope
    ├─ TimerWheel
    ├─ ContextBuilder ─── 不可变请求投影 / 显式 ResultRef / 工具集合
    ├─ ModelRegistry / ModelRouter ─── 能力、策略与候选模型
    │
    ▼
Scheduler Tick（有界，对应一次 event loop turn）
    ├─ FactInbox（完成 / 取消 / deadline / Host 命令）
    ├─ ObservationInbox（progress / chunk / trace；有界、可合并、可丢）
    ├─ TimerWheel due callbacks
    ├─ ReadyQueue → LaneProgram.step() → LaneStepOutput
    └─ EffectQueue → admission / locks / concurrency / limits
                         │
                         ▼
                  EffectExecutor
                  LLM / Tool / Human / ChildAgent / Timer
                  LLM → ModelEffectExecutor → Provider Adapter
                         │ completion / progress
                         ▼
                      EventInbox
                         │
                  Transition engine
                         │
                  Dependency resolve
                         └────────→ ReadyQueue
```

Runtime 是调度状态的唯一写入者。Executor 只提交事件，不直接唤醒 Lane 或修改上下文。`requestCancel()`、`setLanePriority()` 等 Host 命令不直接 mutate：它们投递到 FactInbox 再 `wake()`，对应 libuv 的 `uv_async_send`。drain 期间到达的命令一律入队。日志订阅者、UI 和 telemetry 只观察事件。

持久化、模型供应商和工具加载均通过接口隔离。MVP 使用内存实现，不先拆成大量独立服务或包。

LLM 派发采用“固定输入 → 准备请求与候选 → 原子取得并发额度 → 执行 Attempt”。ContextBuilder 与 ModelRouter 不直接发起模型网络请求，也不自行占用 provider 槽；详细边界见第 22 节。

## 4. 标识、数据与结果约定

所有跨 Step 状态必须可序列化；`Map`、`Set` 可作为内存索引，但快照需要编码为普通记录或数组。闭包、Promise、AbortController、Socket 不进入快照。

```ts
type JsonValue =
  | null | boolean | number | string
  | JsonValue[]
  | { [key: string]: JsonValue }

type AgentId = string
type LaneId = string
type EffectId = string
type WaitId = string
type ResultRef = string
type ArtifactRef = string // 身份引用；隐私元数据由 ArtifactRecord 绑定并随引用校验
type ContextVersion = number
type TxId = string
type SessionId = string
type LLMResultRef = ResultRef   // 指向 ResultStore 中已校验的 LLMResult
type FindingRef = ResultRef     // 指向 ResultStore 中已校验的 Finding

type PrivacyLabel = 'public' | 'cloud_allowed' | 'local_only'
type DataRef =
  | { kind: 'result'; ref: ResultRef }
  | { kind: 'artifact'; ref: ArtifactRef }

interface PrivacyMetadata {
  privacy: PrivacyLabel
  derivedFrom?: DataRef[]
  approvalRef?: string
  sanitizerId?: string
}

interface PrivacyDataBlock extends PrivacyMetadata {
  value: JsonValue
}

type StorageState = 'memory' | 'persisted'

interface StorageResidency {
  storageState: StorageState
  pinCount: number
}

interface ResultRecord extends PrivacyMetadata, StorageResidency {
  ref: ResultRef
  producer: TargetRef
  value: JsonValue
  summary?: JsonValue     // Tool.summarize 产出的有界结构化摘要；同步 Step 可读，正文不可读
  kind?: 'result' | 'rejected_output'   // 默认 result；rejected_output 见第 22.7 节
}

interface ArtifactRecord extends PrivacyMetadata, StorageResidency {
  ref: ArtifactRef
  mediaType: string
  sizeBytes: number
}

interface Finding extends PrivacyMetadata {
  id: string
  statement: string
  evidenceRefs: DataRef[]
}

// 受 Runtime 支持子集验证的 JSON Schema 文档；不是任意可执行代码。
type JsonSchema = JsonValue

type TargetRef =
  | { kind: 'lane'; id: LaneId }
  | { kind: 'effect'; id: EffectId }

type LocalRef =
  | { kind: 'local_effect'; key: string }
  | { kind: 'local_lane'; key: string }

interface RuntimeError {
  code: string
  message: string
  retryable: boolean
  details?: JsonValue
}

type Outcome =
  | {
      status: 'succeeded'
      resultRef: ResultRef
      unresolvedEffectIds?: EffectId[]
    }
  | {
      status: 'failed'
      error: RuntimeError
      rejectedOutputRefs?: ResultRef[]   // 仅 LLMEffect 因 OUTPUT_SCHEMA_VIOLATION 失败时，见第 22.7 节
      unresolvedEffectIds?: EffectId[]
    }
  | {
      status: 'cancelled'
      reason: string
      unresolvedEffectIds?: EffectId[]
    }
```

`ResultRef` 指向已存在、不可变、带 producer 和 `PrivacyMetadata` 的数据。大文本、文件、二进制产物通过带同样隐私元数据的 `ArtifactRef` 传递；不能把所有工具输出重复塞进事件日志和模型上下文。Result 完成只产生可调度事实，不直接写入 GlobalContext。

成功使用 `succeeded`，终结使用 `settled`，二者不混用。失败与取消都属于 settled，但不属于 succeeded。`unresolvedEffectIds` 表示该终态发生时已移交 QuarantineScope、尚未对账完成的 Effect；它不阻止 Lane/Agent 进入终态，但必须可被 `inspect()` 观察到。

三级 Privacy Label 的行为差异：

| 标签 | 允许的去向 |
| --- | --- |
| `public` | 可进入日志导出、Child Agent Outcome、跨 Session 引用 |
| `cloud_allowed` | 可发给 Host 已批准的云端 Provider；默认不进入无脱敏的完整导出 |
| `local_only` | 仅可信本地模型与本地 Tool；阻断云端路由，不能被摘要或 fallback 降级 |

`public < cloud_allowed < local_only`。未标注的数据不能默认为 `public`，Runtime 以 `PRIVACY_LABEL_REQUIRED` 拒绝。

## 5. Agent 与生命周期

```ts
interface AgentRecord {
  id: AgentId
  goal: string
  rootLaneId: LaneId
  state: 'created' | 'running' | 'cancelling'
    | 'succeeded' | 'failed' | 'cancelled'
  policyId: string
  limitsId: string
}
```

Global Context 的当前版本由 ContextStore 持有，不在 `AgentRecord` 上重复存储。Agent 的最终业务结果来自 root Lane。root Lane 成功不代表可以遗留未受管理的工作：所属子 Lane 和非 quarantine Effect 必须收尾后，Agent 才进入终态。仍处于 `reconcile_required` 且已超过宽限的 Effect 必须移交 QuarantineScope，不能把 `run()` 挂死。

Lane 申请完成时对自有子任务的处置必须显式声明，见第 6、7 节 `CompleteAction.children`。默认 `reject_if_active`：仍有活子任务则整个 StepTransaction 拒绝。需要子任务结果时必须显式 Wait/Join。`failed`、`cancelled` 也必须经过资源收尾；收尾超时的自有 Effect 同样移交 quarantine。

子 Lane 失败不会自动取消整个 Agent；父 Lane 的依赖失败策略决定是处理错误、继续汇总还是失败。取消 Agent 则向所属 Lane 和 Effect 传播。

用户取消最终归类为 cancelled；如 Host 配置绝对 deadline 或其他安全限制，触发后最终归类为 failed，并保留 `TIMEOUT` / `LIMIT_EXCEEDED` 等原始原因，即使收尾过程使用取消信号。内部清理不能覆盖最初的业务终结原因：`closing` 期间若收到 cancel，状态转为 `cancelling`，最终 Outcome 仍使用已记录的 `pendingOutcome`。Pulse 不要求为一次 Agent 任务预先分配总 token、总费用或各 Lane 预算；只要 Agent 未进入终态且仍有可推进事件，Runtime 就持续循环调度。

### 5.1 Pulse Session 的状态所有权

Pulse Session 是 Runtime 的状态与审计容器，包含 EventLog、ResultStore、Artifact 引用及其存储、Agent/Lane 状态、Global/Lane Context 和模型 usage/cache 指标。MVP 中这些记录保存在内存并可导出；Session 不等于已实现持久化恢复。

逻辑保留与驻内存保留是两个维度。Result、Event、Snapshot 即使已经落盘，仍可通过稳定引用继续参与恢复、重放或审计；`storageState` 只表示当前是否驻内存，`pinCount` 表示活动执行对它的保护。只有存储后端确认写入成功才能标记为 `persisted`，导出缓冲或待写 outbox 不算已持久化。

```ts
interface SessionStoragePolicy {
  maxResultBytes: number          // 驻内存 Result 上限
  maxEventLogBytes: number        // 驻内存 Event 上限（含索引）
  maxSnapshotBytes: number        // 驻内存 Snapshot 上限
  maxTotalMemoryBytes: number     // 当前驻内存编码数据、索引和 metadata
}
```

`maxResultBytes`、`maxEventLogBytes`、`maxSnapshotBytes`、`maxTotalMemoryBytes` 都约束**当前驻内存**占用。它们不能通过删除活动 pin 来绕过。它们**不是**逻辑保留上限：事实事件在逻辑上永久保留，不能因为落盘或 checkpoint 就当作“没发生过”。没有持久化后端时，unpinned 观测流可以 compact，unpinned Result/Snapshot 可以丢弃正文只留索引；事实事件超内存上限则拒绝本次写入，而不是伪造 `persisted`。

M2 用 checkpoint（状态快照 + 日志水位）截断已纳入快照的事实前缀；截断后的逻辑事件仍可通过归档引用审计，但不要求永远驻内存。MVP 不做 checkpoint，因此长任务的内存上限仍然生效，Host 必须把 `maxEventLogBytes` 配到可接受的会话长度。

SessionStoragePolicy 不替代 Lane/Effect 并发上限。Runtime 为活动 Lane 的固定 Snapshot、LLM Request 投影、WaitResolution、未消费输入和仍被引用的 ResultRef 建立 pin；引用增加/释放必须可追踪并幂等。未被活动引用的数据可以持久化或 compact，但逻辑引用仍有效时不能删除。

达到内存水位时，Runtime 优先把 unpinned Result、观测事件和旧 Snapshot 持久化或 compact；内存只保留索引、引用关系、版本和必要 metadata。`progress`、LLM chunk 和 scheduler trace 属于可 compact 的观测流。Snapshot 至少保留最新版本和所有 Lane/活动 Request 引用的旧版本，其余旧版本落盘并保留可恢复索引。

如果持久化不可用、可 compact 的 unpinned 数据已处理、所有剩余数据仍被 pin 且继续写入会超过 hard limit，Runtime 必须拒绝本次写入并返回 `SESSION_STORAGE_LIMIT_EXCEEDED`；不能淘汰活动引用、无限增长内存或静默丢失事实。存储准入属于 `validate` 阶段用预估字节数检查，拒绝时不 `apply`，因此不提交半个 Result、Event、Snapshot 或 ResumePoint。

`messages[]` 是 ContextBuilder 为某次 LLMEffect 生成的投影，不是 Session 本体。`conversation_id`、`thread_id`、`previous_response_id` 不得成为恢复 Agent 状态的必要依据。

同一 Agent 的 Lane 共享 Session 身份，但各自读取固定快照与显式授权输入。Child Agent 保持自己的 Context/Session 逻辑边界，通过 AgentEffect 的 Outcome 向父 Agent 返回结果；复用 Runtime 或存储不意味着共享全部历史。

## 6. Lane：配置与运行状态分离

```ts
type LanePriority = 'background' | 'normal' | 'high' | 'urgent'

type LaneState =
  | 'created' | 'ready' | 'running' | 'waiting'
  | 'closing' | 'cancelling'
  | 'succeeded' | 'failed' | 'cancelled'

interface ResumePoint {
  programId: string
  programVersion: string
  step: string
  locals: JsonValue
}

interface LaneRecord {
  id: LaneId
  agentId: AgentId
  parentId?: LaneId
  goal: string
  state: LaneState
  basePriority: LanePriority
  contextSnapshotVersion: ContextVersion   // 本 Lane 读取的 Global 版本
  laneContextVersion: ContextVersion       // 本 Lane 局部 Context 版本
  historyPressure?: {                      // Runtime 在 history 超过 softTokens 后维护，见第 15.9 节
    historyTokens: number
    softTokens: number
    hardTokens: number
  }
  resumePoint: ResumePoint
  pendingResumeInput?: ResumeInput
  activeWaitId?: WaitId
  readySince?: number
  enqueueSeq?: number
  laneVersion: number                      // 每次已提交的 Lane 状态转换 +1
  consecutiveControlErrors: number         // 提交成功时清零
  progressWatchdog?: ProgressWatchdogState
  pendingOutcome?: Outcome
  outcome?: Outcome
}
```

`basePriority` 是声明值；实际调度分数根据等待时间和依赖继承计算，不让模型直接写入。`activeWaitId` 只表示当前执行位置的等待，历史依赖保存在日志中，不能每次恢复重新等待所有历史目标。`laneVersion` 是 OCC 与“同一次等待只恢复一次”的统一版本：所有针对该 Lane 的事务都带 `expectedLaneVersion`。不再使用含义过载的 `queueVersion`。

```text
created ──无启动依赖──────────────→ ready
   └─────有启动依赖──→ waiting ───→ ready
                                    │
                                    ▼
                                  running
                         ┌──────────┼──────────┐
                    actions: []    wait     complete / fail
                         │          │          │
                       ready     waiting     closing（仅 children: await|cancel）
                         │                       │
                         │                     succeeded / failed
                         │                       └─ 超时未确认 Effect → quarantine 后仍进入终态

任一非终态 ── cancel request → cancelling → cancelled
closing + cancel request → cancelling，保留 pendingOutcome
```

Join 是一种 Wait 原因，不再增加独立 `joining` 状态。状态回答“现在能否推进”，`wait.reason` 回答“在等什么”。已无资源需要收尾、或剩余 Effect 已移交 quarantine 时，`closing`/`cancelling` 可在同一事务内直接进入终态。

`actions: []` 的 Lane 回到 ReadyQueue **队尾**（分配新的 `enqueueSeq`，重置本次 ready 等待时间），避免单条纯逻辑 Lane 在一个 tick 内连跑 `maxLaneStepsPerTick` 步。

## 7. Lane Program 与推进边界

Lane 是可恢复的状态机。MVP 使用显式 Program + ResumePoint，不声称能够保存任意 async 函数或 generator 的栈。

```ts
interface LaneProgram {
  id: string
  version: string
  step(input: LaneStepInput): LaneStepOutput
}

interface LaneContextView {
  global: JsonValue
  globalVersion: ContextVersion
  lane: JsonValue
  laneVersion: ContextVersion
}

interface LaneStepInput {
  lane: Readonly<LaneRecord>
  context: LaneContextView
  resumeInput?: ResumeInput
  now: number                  // RuntimeClock 注入的单调/逻辑时间
}

interface LaneStepOutput {
  next: ResumePoint
  contextDelta?: ContextDelta
  adoptCommittedContext?: boolean
  actions: RuntimeAction[]
}

type ContextPath = string[]

type ContextOp =
  | { op: 'set'; path: ContextPath; value: JsonValue }
  | { op: 'append'; path: ContextPath; value: JsonValue }
  | { op: 'remove'; path: ContextPath }
  | { op: 'compact_history'; upToSeq: number; summaryRef: ResultRef }  // 仅 target: 'lane'，见第 15.9 节

interface ContextDelta {
  target: 'global' | 'lane'
  baseVersion: ContextVersion          // 对应 target 的版本
  sourceLaneId: LaneId
  ops: ContextOp[]
  privacy: PrivacyLabel
  derivedFrom?: DataRef[]
  resultRefs?: ResultRef[]
  proposal?: boolean                   // true：只登记 MergeProposal，不改任何版本
}

type RuntimeAction =
  | SubmitEffectsAction
  | ForkAction
  | WaitAction
  | CancelLaneAction
  | ProposeCancelAction
  | AdoptContextAction
  | DowngradePrivacyAction
  | CompleteAction
  | FailAction

interface SubmitEffectsAction {
  type: 'submit_effects'
  effects: EffectSubmission[]
  wait?: Omit<WaitSpec, 'dependencies' | 'reason'>
  // 省略 wait：提交后继续，下一 Step 收到 submitted 输入
  // 存在 wait：对本批 effects 登记 Wait；condition 默认 settled
}

interface WaitAction {
  type: 'wait'
  spec: WaitSpec
}

interface CancelLaneAction {
  type: 'cancel_lane'
  laneId: LaneId
  reason: 'SUPERSEDED' | 'USER_REQUESTED' | 'POLICY'
}

interface ProposeCancelAction {
  type: 'propose_cancel'
  laneId: LaneId
  reason: 'SUPERSEDED' | 'POLICY'
}

interface AdoptContextAction {
  type: 'adopt_context'
  version: ContextVersion | 'latest'
}

interface DowngradePrivacyAction {
  type: 'downgrade_privacy'
  sourceRefs: DataRef[]
  outputRef: DataRef
  targetPrivacy: 'cloud_allowed'
  method: 'human_approval' | 'sanitizer'
  approvalRef?: string
  sanitizerId?: string
}

interface CompleteAction {
  type: 'complete'
  result: PrivacyDataBlock
  children?: 'reject_if_active' | 'cancel' | 'await'  // 默认 reject_if_active
}

interface FailAction {
  type: 'fail'
  error: RuntimeError
  privacy: PrivacyLabel
  derivedFrom?: DataRef[]
}

type Mutation =
  | { op: 'setLaneState'; laneId: LaneId; state: LaneState; expectedLaneVersion: number }
  | { op: 'setLaneSnapshot'; laneId: LaneId; contextSnapshotVersion: ContextVersion }
  | { op: 'setLaneContext'; laneId: LaneId; version: ContextVersion; value: JsonValue }
  | { op: 'setGlobalContext'; version: ContextVersion; value: JsonValue }
  | { op: 'insertEffect'; record: EffectRecord }
  | { op: 'insertWait'; record: WaitRecord }
  | { op: 'insertLane'; record: LaneRecord }
  | { op: 'publishResult'; record: ResultRecord }
  | { op: 'enqueueReady'; laneId: LaneId; enqueueSeq: number }
  | { op: 'pin'; ref: DataRef | string; delta: 1 | -1 }
  | { op: 'appendEvent'; event: Omit<RuntimeEvent, 'seq'> }
  | { op: 'quarantineEffect'; effectId: EffectId }
  | { op: 'insertMergeProposal'; proposal: MergeProposal }

interface StepTransaction {
  txId: TxId
  laneId: LaneId
  expectedLaneVersion: number
  output: LaneStepOutput
  contextDelta?: ContextDelta
  adoptCommittedContext?: boolean
  adoptedContextVersion?: ContextVersion
  actions: RuntimeAction[]
  next: ResumePoint
  progressFingerprint: ProgressFingerprint
  mutations: Mutation[]
  eventIds: string[]
}
```

每次 Step 同步返回一个 `LaneStepOutput`。Runtime 将它规范化为一个 `StepTransaction`，统一验证 `contextDelta`（路径冲突、Privacy Label、target/proposal）、隐私降级证明、`adoptCommittedContext`、全部 `actions`、`next`、当前 `laneVersion`、权限、依赖、资源/并发准入和 Policy，并拒绝重复 effect key、重复 CancelLane 目标、未知局部引用、多个终结动作、多个 Wait 来源以及冲突的 Adopt 声明。`ContextDelta` 只能描述认知状态更新，不能隐含或执行 `cancel_lane`；取消必须是显式的 `CancelLaneAction` 或经 owner 接受的 `ProposeCancelAction`。`adopt_context` 与 `adoptCommittedContext` 是唯一能切换 Lane `contextSnapshotVersion` 的控制动作。

两个 `ContextOp` 冲突，当且仅当它们的 `path` 相等，或一个是另一个的前缀。`compact_history` 没有 `path`，只对 `target: 'lane'` 合法，且 `upToSeq` 不得超过本 Lane 当前 `history` 长度；`set` / `append` / `remove` 的 `path` 不得以 `['history']` 开头。`target: 'global'` 且 `proposal !== true` 的直接提交需要 policy 授权（通常仅 root）；`proposal: true` 写入 `MergeProposal` 表，由 root 的 `merge` LLMEffect 消化后再以 `target: 'global'` 提交。`adoptCommittedContext: true` 只对 `target: 'global' && proposal !== true` 合法。

`CompleteAction.children`：

- `reject_if_active`（默认）：仍有活子 Lane 或非 quarantine 的自有 Effect → `control_error CHILDREN_STILL_ACTIVE`，逼 Program 显式 Join 或 cancel。
- `cancel`：显式承认会取消自有子任务；环检测不把“owner → 子任务”当作死锁边。
- `await`：进入 `closing`，等待子任务终态；环检测把“未结束 owner → 自有子任务”当作死锁边。

`cancel_lane` 只能作用于**当前 Lane 的自有后代**。对 sibling 或非后代只能提交 `propose_cancel`：提案写入目标 owner 的下一 Step `control_proposal` 输入，由 owner 决定是否发出真正的 `cancel_lane`。policy 可另开 Host 级授权，但不作为默认路径。

### 7.1 两阶段提交：validate 与 apply

StepTransaction 的提交边界是：

```text
LaneProgram.step()                         # 同步纯函数，禁止外部 await
→ Decode / 生成 LaneStepOutput
→ validate(state, output) → Mutation[] | Rejection
     一次性只读校验：ContextDelta、Adopt、Actions、next、
     权限、依赖、环、资源/并发预估、Storage 预估字节、Policy、Watchdog
→ 全部通过
→ apply(state, Mutation[])                 # 不可失败：无校验、无 IO、无抛错
→ emit(events) → 派发意图入 outbox
→ commit 后才启动 Tool / LLM / Human / ChildAgent / Timer
```

`validate` 是纯函数，只读当前 state。`Mutation` 是普通数据。`apply` 只做记账；若 `apply` 抛错，视为 Runtime bug：丢弃本次事务，记 `step.rejected { code: 'INTERNAL_ERROR' }`，Lane 按控制错误规则处理，不留下半状态。Storage 准入在 validate 用预估字节数检查，apply 只更新计数。M2 持久化时 `Mutation[]` 就是事务日志。

提交事务只写 Runtime 状态和派发意图，不在事务内执行外部 Effect。资源锁、并发额度和队列容量在 validate 阶段必须可准入；可以由事务创建受版本保护的 reservation，但真正取得执行资源和启动 Executor 只能发生在 apply 之后。这样不会出现“Context 已更新但 Lane 未取消”“Effect 已启动但 ResumePoint 未保存”或“批量 Action 只提交一部分”。

任一校验失败，整个 StepTransaction 拒绝：Context 不更新、任何 Lane 的 snapshot 不改变、目标 Lane 不取消、不创建或启动任何 Effect、ResumePoint 不改变，所有临时 reservation 一并丢弃（因为从未 apply）。Runtime 将

```ts
{ type: 'control_error'; error: RuntimeError; original?: ResumeInput }
```

作为下一次 Step 的 `resumeInput`，`original` 保留被拒绝前的 WaitResolution / submitted 映射，避免结果丢失。`consecutiveControlErrors += 1`；达到 `maxConsecutiveControlErrors`（建议 2）则结构化 Lane 失败 `CONTROL_ERROR_LOOP`。被拒绝的事务**不**进入 Progress Watchdog 窗口：Watchdog 管“输出合法但无进展”，控制错误计数管“输出非法”。如果当前 Lane 已无法安全恢复（非法 next/program 或 `step()` 抛错），直接转为结构化 Lane 失败。

`next` 是 StepTransaction 成功提交后恢复的位置；若 actions 包含 `complete` 或 `fail`，它按终结动作规则处理。一个 Step 内的终结动作与其他动作组合时，MVP 拒绝歧义组合（例如 `complete + submit_effects`、`fail + fork`），避免猜测顺序。`adoptCommittedContext: true` 只能与本 Step 成功提交并生成 Global Context 新版本的 `contextDelta` 一起使用；同时再提交显式 `adopt_context` Action 时拒绝，避免两个版本来源无法解释。可处理的 Transaction 校验失败不消耗 `next`，而是以 `control_error` 重新运行当前 ResumePoint；Program 必须区分正常输入和错误输入。

不持久化 JS 闭包，仍可在 Executor、事件适配器、进程内 Handle 中使用普通 Promise 和回调；限制的是可恢复的业务控制流。

### 7.2 Step 是同步执行切片，不新增 `sync Lane`

Lane 是长期存在的逻辑执行线，不区分 `sync Lane` / `async Lane`。同一条 Lane 会反复经历：同步 Step → 提交异步 Effect → waiting → Event 唤醒 → 下一次同步 Step。

```text
Node.js                    Pulse
------------------------------------------------
Macrotask                  Lane Step
Event Loop Turn            Scheduler Tick
Async I/O                  Effect
I/O Completion             Effect Event
Callback Ready             Lane READY
Task Queue                 ReadyQueue
uv_async_send              Host 命令 / Executor 完成 → FactInbox + wake()
timers phase               TimerWheel
```

因此 `LaneProgram.step()` 必须保持同步接口，禁止改成 `async step()`，也禁止在 Step 内隐藏 `await llm()`、`await tool()`、`fetch()` 等外部等待。Step 只负责短小、原子的状态计算并返回 `LaneStepOutput`；`actions: []` 表示没有外部动作的继续推进，真正耗时工作一律转为 Effect。CPU 密集计算也不能留在 Step 中，应交给 Worker/子进程 Effect。

## 8. 依赖模型：先定义执行资格

```ts
interface DependencySpec {
  key: string
  target: TargetRef | LocalRef
  condition: 'success' | 'settled'
}

interface WaitSpec {
  dependencies: DependencySpec[]
  mode: 'all'  // MVP；其他组合以后扩展
  onUnsatisfied: 'fail_lane' | 'resume_with_error'
  onCancelled?: 'unsatisfied' | 'ignore'   // 默认 unsatisfied
  reason: 'startup' | 'effect' | 'dependency' | 'join'
  deadlineAt?: number
}

interface WaitRecord {
  id: WaitId
  laneId: LaneId
  spec: WaitSpec
  state: 'pending' | 'satisfied' | 'unsatisfied'
  resolution?: WaitResolution
}

type DependencyObservation =
  | { state: 'pending'; target: TargetRef }
  | { state: 'settled'; target: TargetRef; outcome: Outcome }
  | { state: 'ignored'; target: TargetRef; outcome: Outcome }

interface WaitResolution {
  waitId: WaitId
  status: 'satisfied' | 'unsatisfied'
  dependencies: Record<string, DependencyObservation>
  error?: RuntimeError
}

type ResumeInput =
  | { type: 'wait'; resolution: WaitResolution }
  | { type: 'submitted'; targets: Record<string, TargetRef> }
  | { type: 'control_error'; error: RuntimeError; original?: ResumeInput }
  | {
      type: 'control_proposal'
      proposals: Array<{
        type: 'cancel_lane'
        laneId: LaneId
        reason: string
        fromLaneId: LaneId
      }>
    }
```

同一 Step 内刚提交的 Effect / 刚 Fork 的 Lane 用 `LocalRef` 引用，validate 阶段先分配全部 ID 再解析。重复 `key`、同一目标的重复条件、未知目标、自依赖和跨 Agent 目标在提交时拒绝。MVP 不允许隐含创建未来目标。

一个 StepTransaction 内 `submit_effects.wait`、`wait`、`fork.join` 三者最多出现一个，否则 `MULTIPLE_WAIT_SOURCES`。`activeWaitId` 同时最多一个。

所有依赖在 MVP 中都是硬依赖。仅表示“最好先做”的偏好通过优先级或规划表达，不混入 readiness 判断。

| 上游状态 | `success` | `settled` | `onCancelled: ignore` |
| --- | --- | --- | --- |
| 未结束 | 等待 | 等待 | 等待 |
| succeeded | 满足并提供结果引用 | 满足并提供成功 Outcome | 满足 |
| failed | 不可满足 | 满足并提供失败 Outcome | 不适用 |
| cancelled | 不可满足（默认） | 满足并提供取消 Outcome | 该依赖标为 ignored，不使 Wait unsatisfied |

`all` 中任何条件不可满足，Wait 立即失败，不等待其余目标；`fail_lane` 发起 Lane 失败收尾，`resume_with_error` 把失败快照送到错误处理 Step。此时尚未结束的目标只标为 pending，不能伪造为失败或取消。`SUPERSEDED` 剪枝产生 `cancelled`；流水线若用 `all + success` 且未设 `onCancelled: 'ignore'`，Join 会失败。因此 Fork 的 `join` 默认 `settled`。

“恢复处理依赖错误”不表示继续执行成功路径。Program 必须检查 `resumeInput` 的结果类型。常规工具等待推荐 `settled`，让 Lane 能处理工具错误；工作流水线默认 `success + fail_lane`。

空依赖集立即满足。

## 9. 依赖图、循环检测与防丢失唤醒

依赖图表示当前有效的等待关系，方向为“等待者 → 被等待者”。与 `parentId` 构成的所有权树分别存储。

```text
所有权树：Main → A、B、C
等待关系：C → A、B；Main → C
```

支持 sibling Lane 依赖；父子关系不自动添加执行依赖。Main 等子任务时，子任务再等 Main 的最终结果必须被拒绝。

运行规则：

1. 依赖只能在创建时或 Step 的原子边界注册；不能外部修改正在运行 Step 的前提。
2. 新等待关系先完成目标校验和环检测，再整体提交。
3. Fork 同批 Lane 可通过局部 key 互相引用；先分配全部 ID，再校验整批，失败则整批回滚。
4. Join 展开为 Lane 等待边。仅当某条 owner Lane 的未提交/已提交终结动作使用 `children: 'await'`（或等价的关闭等待）时，才加入“未结束 owner → 自有子任务”的隐含收尾边。`children: 'cancel'` 或 `reject_if_active` 不把这条边当作死锁边。这些边只用于死锁校验，不自动阻止父 Lane 推进，也不自动继承优先级。MVP 拒绝 Lane 等待任意所有权祖先终态；跨分支的隐含收尾环同样拒绝。
5. 等待完成/失败/取消时移除活动边和索引；历史边保留在日志中。

WaitingIndex 使用带类型的目标键，避免 Lane ID 和 Effect ID 混淆：

```ts
type TargetKey = `lane:${string}` | `effect:${string}`
type WaitingIndex = Map<TargetKey, Set<WaitId>>
```

注册 Wait 与检查目标当前 Outcome 必须在同一 Runtime 状态事务内完成，解决“目标先完成、随后才开始等待”的丢失唤醒问题。终态事件触发重检，`waitId + laneVersion` 保证同一次等待只恢复一次。

无 ready Lane 不等于死锁：可能仍有运行中的 Effect、TimerWheel 上的到期项、quarantine 中的对账或外部输入。诊断需列出阻塞目标、deadline、锁持有者、quarantine 清单及可推进来源；仅发现闭环或无任何推进来源时报告不可推进。

### 9.1 Progress Watchdog / Loop Detector

依赖图循环检测只能发现结构上的等待闭环，不能发现 Lane 已经反复执行同一调查。Runtime 对每轮可恢复且**校验通过**的 Step 生成一个稳定的进展指纹，并在 Lane 上维护有界滑动窗口：

```ts
interface ProgressFingerprint {
  goalStateHash: string
  contextVersion: string
  actionSignature: string
  resultSignature?: string
  resumeStep: string
  localsHash: string
}

interface ProgressPolicy {
  windowSize: number
  maxNoProgressRounds: number
  repeatedActionThreshold: number
}

interface ProgressWatchdogState {
  recent: ProgressFingerprint[]
  noProgressCount: number
  interventionLevel: 0 | 1 | 2 | 3
  // 0 正常；1 已注入 control_error；2 要求 replan；3 将 fail Lane
}
```

Host 可以从 `windowSize: 8`、`maxNoProgressRounds: 3`、`repeatedActionThreshold: 3` 起步，再按任务样本调整；这些是策略默认值，不是把所有 Lane 固定成同一阈值。

`goalStateHash`、`actionSignature`、`resultSignature`、`localsHash` 必须使用规范化输入计算，排除随机 ID、timestamp、telemetry 和 Provider 原生 ID。`resultSignature` 定义为 Tool/Adapter 可选提供的 `normalize(output)` 之后的稳定内容哈希，默认剔除 timestamp/ID 字段；没有 normalize 函数时退化为规范化 JSON 哈希。它不是另一次 LLM 语义判断。`contextVersion` 记录本轮可见的 Context/Finding 语义版本。`resumeStep` 与 `localsHash` 使合法的多步纯逻辑 Lane（`actions: []`、只改 `locals`）不会被判无进展。`localsHash` 只对 `locals` 中排除 `$sdk` 命名空间之后的内容计算：应用层 SDK 的簿记（循环轮次计数、待回填的 `toolCallId` 映射、self-correct 标记、series 游标）必须放在 `locals.$sdk` 下，否则每轮变化的计数器会让 `localsHash` 永远"在推进"，把 Watchdog 在最容易死循环的 LLM ↔ Tool 循环里致盲。业务 locals 不得放入 `$sdk`；Runtime 对 `$sdk` 只做序列化与大小限制，不解释其内容。`repeatedActionThreshold` 表示窗口内相同或等价 `actionSignature` 的计数阈值。这样 Result A 与 Result A' 即使引用不同，只要规范化内容相同，仍能被识别为重复。

例如以下序列即使每次都有新 Event 和新的 ResultRef，也会因语义指纹不变而累计无进展：

```text
LLM → search("AuthStore") → Result A
LLM → search("AuthStore") → Result A'
LLM → search("AuthStore") → Result A''
```

Watchdog 在 validate 阶段评估候选指纹，而不是等重复外部 Effect 已经无限派发后才报警。被拒绝的事务不写入窗口、不累计 `noProgressCount`。只有同时满足以下条件才累计 `noProgressCount`：窗口内 `actionSignature` 达到 `repeatedActionThreshold`，Context/Finding 没有实质变化，`goalStateHash` 没有推进，且 `resumeStep + localsHash` 也没有推进；单纯产生一个新 Event、换了 ResultRef 或递增 seq 不算进展。检测到实质 Context、Finding、Goal 或执行路径变化时清零计数、恢复 `interventionLevel = 0`，并保留新的指纹。

`noProgressCount >= maxNoProgressRounds` 时返回 `NO_PROGRESS_DETECTED`。当前候选 Step 的重复 Effect/Action 不提交、不派发，Lane 收到结构化 `control_error`；已有事实和结果仍保留。升级路径：

1. 第一次达到阈值：`interventionLevel = 1`，计数清零但保留窗口，注入 `control_error`，要求 Program 改变策略。
2. 再次达到阈值：`interventionLevel = 2`。Runtime **不改写**已提交 Effect 的语义输入。Program 读取 `lane.progressWatchdog` 后应提交 replan；随后新的 LLMEffect 由 ModelRouter 应用 `minReasoningFloor = f(interventionLevel)`（属于策略收紧，仍受 Privacy / Limits / retry 约束）。
3. 仍再次达到阈值：`interventionLevel = 3`，Lane 进入 `failed`，保留窗口、指纹和干预事件。

所有升级都不能用换模型掩盖无进展，也不能绕过原有 Model Policy。

等待外部输入、等待资源释放或有明确轮询语义的 Step 不应伪装成进展；Program 应提交 Wait 或声明受策略约束的轮询路径。Watchdog 只限制没有实质状态变化的重复推进，不把正常的等待、合法重试或一次性的相同 Action 误判为死循环。

## 10. 优先级、等待补偿与依赖继承

声明优先级建议映射为有界基础分：

| 优先级 | 基础分 | 用途 |
| --- | ---: | --- |
| background | 0 | 非关键索引、辅助整理 |
| normal | 10 | 默认调查和执行 |
| high | 20 | 主任务关键路径 |
| urgent | 30 | 用户明确插入的紧急工作 |

默认值为 normal；Fork 未指定时继承父 Lane 的声明优先级。模型只可提出调整请求，Runtime 根据策略限制提权范围；用户/Host 调整也必须通过命令记录事件。

MVP 采用可解释的分数规则：

```text
ownScore = baseScore + floor(eligibleWaitMs / agingIntervalMs)
effectiveScore = max(ownScore, 所有等待本目标的消费者所传递的分数)
若配置 agingCap：ownScore = min(ownScore, baseScore + agingCap)
```

- `eligibleWaitMs` 只累计 ready Lane 或已具备执行条件的 queued Effect 等待时间；waiting Lane 不因外部慢请求自动攒分。
- 因此 urgent 的 waiting 消费者向 ready 上游传递的是其 **baseScore（加自身尚未重置的 ready 加分，通常为 0）**，即定值 30，而不是随等待时间增长的分数。其它 ready 的 normal Lane 在 aging 足够久之后可以反超这条关键路径。这是明确取舍：aging 保证有资格的低优先级工作最终获得机会；urgent 是优先偏好，不是硬实时。Host 可设 `agingCap`（默认不封顶）限制反超速度。
- Lane 被执行后重置本次 ready 等待时间；Effect 队列年龄从本次排队开始，重试重新计算。
- 同分按单调递增 `enqueueSeq` FIFO，不能只依赖毫秒时间戳。
- 分数沿当前依赖链传递到上游 Lane 及其正在等待的 **queued** Effect；依赖移除后撤销继承，保留声明优先级。已 running 的 Step/Effect 不可抢占，传分不影响本次执行。
- 锁持有者必然已经 running，**不**向持锁 Effect 传分。资源等待队列按 `effectiveScore + enqueueSeq` 排序，见第 16.1 节。
- Child Agent 的 root Lane 在父 Lane 等待对应 AgentEffect 期间获得 `inheritedFloor = 父 Lane 当时 effectiveScore`；等待解除后撤销。这不是跨 Agent 依赖边，只是调度分数地板。

例如 urgent 的修复 Lane 等 normal 的分析 Lane，分析应被临时提升；分析的 **queued** LLM Effect 同样获得继承。否则 Lane 优先级无法解决真正的请求排队问题。

Runtime 级 `maxTotalLanes`（建议 64，含所有 Agent 的活动 Lane）与 Agent 级 `maxActiveLanes` 分开命名。MVP 可先在调度时重算分数、线性选取，不急于引入难以处理 aging 的静态优先堆。只有依赖解除、优先级变化或 aging 时间跨档时才需要重新评估队列。

公平性成立的前提是资源最终释放、Step/Effect 有界、没有无限到达的不可释放工作；资源锁与长期外部调用仍可能造成延迟，不承诺实时 SLA。quarantine 中的写锁会一直占用，直到对账完成或 Host 放弃。

## 11. Scheduler：Lane 推进与 Effect 派发分层

Scheduler 管理两类工作队列，外加统一 TimerWheel：

- ReadyQueue：当前可以运行同步 Step 的 Lane。
- EffectQueue：已提交但尚未取得资源和并发额度的外部操作（仅 `concurrencyClass !== 'none'` 计入 `maxQueuedEffects`）。
- TimerWheel：TimerEffect、Wait deadline、retry backoff、attemptTimeout。HumanEffect 与 TimerEffect 不占执行槽。

Lane 因等待已排队的 Effect 而处于 `waiting`，不能为了等 LLM 并发槽而反复回到 ReadyQueue。

一次调度轮次对应一次 event loop turn：

```text
处理有界数量的事实事件（完成 / 取消 / deadline / Host 命令）
→ 合并或丢弃有界观测事件（progress / chunk / trace）
→ 弹出 TimerWheel 中已到期的项
→ validate/apply 状态与结果、解析依赖
→ 为已有 queued Effect 派发有界数量的工作
→ 推进有界数量的 ready Lane Step
→ 派发本轮新增 Effect
→ 若 hasRunnableWork()，通过 setImmediate 安排下一轮
```

```ts
function hasRunnableWork(): boolean {
  return readyQueue.size > 0
    || factInbox.size > 0
    || timerWheel.hasDue()
    || hasDispatchableQueuedEffect() // 额度与锁当前可满足
}
```

若只剩资源阻塞或 future deadline，等待资源释放事件或 TimerWheel 最近到期项，禁止空转 tick。观测 Inbox 单独有界，**不**单独构成 `hasRunnableWork()`，避免 progress 洪峰空转。所有阶段共享操作次数和软时间片限制，避免输入洪峰或 Lane 洪峰独占事件循环。

建议初始配置（需测量后调整）：

```ts
interface SchedulerConfig {
  maxLaneStepsPerTick: number          // 32
  maxTickMs: number                    // 5，软时间片限制
  agingIntervalMs: number              // 1000
  agingCap?: number                    // 可选；默认不封顶
  maxTotalLanes: number                // 64，Runtime 级，含所有 Agent
  maxActiveLanesPerAgent: number       // 64
  maxQueuedEffects: number             // 256，不含 concurrencyClass 'none'
  maxRunningTools: number              // 16
  maxRunningLLMs: number               // 4
  maxPreparingLLMs: number             // 4，异步请求准备的独立上限
  maxPreparedLLMs: number              // 建议 maxRunningLLMs * 2
  maxRunningAgents: number             // 1 或按 Host 配置
  writerPreferenceBound: number        // exclusive 等待者到达后最多再放行的前方 shared 数
  maxConsecutiveControlErrors: number  // 2
  providerConcurrency?: Record<string, number>
  modelConcurrency?: Record<string, number>
}
```

`wake()` 合并重复唤醒；同一 Runtime 只允许一个 drain 执行。drain 期间 `inDrain` 为真，新命令与完成事件只入 Inbox。`setImmediate` 用于批次间让出事件循环，不依赖持续递归的 microtask 链。[Node.js 定时器文档](https://nodejs.org/api/timers.html#setimmediatecallback-args)

`maxTickMs` 不能打断一个已经开始的同步 Step。CPU 密集工作必须进入 Worker/子进程 Executor；工具的 async 函数在第一次 await 前同样不能执行长时间同步计算。

### 11.1 SchedulerDecisionModel：可选的注意力分配建议

ReadyQueue 的资格判断和资源安全始终由确定性的 SchedulerKernel 负责。Kernel 先完成依赖、生命周期、取消、资源锁、并发槽和 Effect 状态检查，只把当前合法的 Ready Lane 快照交给可选的 `SchedulerDecisionModel`。该模型可以是规则排序器、专用 ranker、本地小模型或云端模型，但它只能返回候选 Lane 的顺序建议，不能修改 Lane、跳过准入、取消工作或直接派发 Effect。

建议调用属于异步控制面：请求带有 `candidateEpoch`、候选投影和超时；结果必须重新进入 FactInbox，由 Kernel 在下一个 Tick 中校验。候选集发生变化、模型超时/失败、返回未知 Lane、超过最大重排距离或触发确定性公平保底时，直接使用原有 `effective priority + aging + FIFO` 顺序。模型请求不占业务 Effect 的执行槽，也不改变 `LaneProgram.step()` 的同步、纯函数、IO-free 契约。

Runtime 配置保持 Agent 执行模型与调度建议模型分离：

```ts
interface SchedulerDecisionModel {
  readonly id: string
  decide(request: SchedulerDecisionRequest, signal: AbortSignal): Promise<SchedulerDecision>
}

new PulseRuntime({
  schedulerDecision: {
    model,
    minCandidates: 3,
    maxReorderDistance: 1,
    deterministicReserveEvery: 4,
  },
})
```

默认不把 Lane Goal 发送给模型；只有 Host 显式设置 `includeGoals: true` 才会加入候选投影。该能力是优化调度顺序，不是 Runtime 正确性依赖，因此没有模型时 Pulse 的行为与原确定性 Scheduler 完全一致。

## 12. Effect 与 Attempt

所有需要离开同步 Lane Step 的外部等待统一为 Effect。第一类 Effect 包括 `LLMEffect`、`ToolEffect`、`HumanEffect`、`AgentEffect` 和 `TimerEffect`；HTTP、文件等通常通过 ToolEffect 封装，也可以由专用 Executor 扩展。

```text
Effect
├─ LLMEffect      # 一次模型推理          concurrencyClass: 'llm'
├─ ToolEffect     # 工具执行              concurrencyClass: 'tool'
├─ HumanEffect    # 等待用户输入 / 审批     concurrencyClass: 'none'
├─ AgentEffect    # 启动并等待 Child Agent  concurrencyClass: 'agent'
└─ TimerEffect    # deadline / delay      concurrencyClass: 'none'
```

`HumanEffect` 与 TimerEffect 提交后所属 Lane waiting，但不占 Tool/LLM 槽，不计入 `maxQueuedEffects`。Host/UI 在用户响应时向 FactInbox 提交完成事件；TimerEffect、Wait deadline、retry backoff、attemptTimeout 全部复用 TimerWheel。

`AgentEffect` 启动一个拥有独立 AgentRecord、root Lane、局部 Session/Context 边界的 Child Agent。Child Agent 使用与主 Agent 相同的 Pulse 执行模型；第一版建议 `maxAgentDepth = 1`，即 Child Agent 不能继续创建 Child Agent，避免无界递归。父 Lane 是否等待它，由普通 Effect/Wait 语义决定。Child Agent 的活动 Lane 计入 Runtime `maxTotalLanes`，同时受自身 `maxActiveLanes` 约束。

```ts
type EffectState =
  | 'queued' | 'running' | 'retry_wait'
  | 'reconcile_required'
  | 'succeeded' | 'failed' | 'cancelled'

type ConcurrencyClass = 'llm' | 'tool' | 'agent' | 'none'

type ExecutionState =
  | 'running'
  | 'locally_closed'
  | 'remote_unknown'
  | 'settled'

type SideEffectState =
  | 'none'     // 本次操作没有需要确认的外部副作用
  | 'known'    // 是否发生以及结果已知（可能是发生，也可能是确认未发生）
  | 'unknown'  // 是否发生无法确认

interface AttemptRecord {
  id: string
  effectId: EffectId
  executionState: ExecutionState
  sideEffectState: SideEffectState
  localClosedAt?: number
  remoteStatusRef?: JsonValue
  sideEffectRef?: JsonValue
  error?: RuntimeError
}

interface EffectRecord {
  id: EffectId
  agentId: AgentId
  ownerLaneId: LaneId                  // 移交 quarantine 后仍保留原 owner，另记 scopeId
  scopeId: string
  type: string
  concurrencyClass: ConcurrencyClass
  input: JsonValue
  state: EffectState
  cancelRequested?: { reason: string; at: number }
  preparation?: {
    state: 'idle' | 'preparing' | 'prepared' | 'stale'
    generation: number
    projectionRef?: ArtifactRef
  }
  attempt: number
  activeAttemptId?: string
  attempts?: AttemptRecord[]
  schedulePriority: LanePriority
  inheritedFloor?: number
  retryPolicyId: string
  toolCallId?: string
  idempotencyKey?: string
  attemptTimeoutMs: number
  cancelGraceMs: number
  deadlineAt?: number
  outcome?: Outcome
}

interface EffectSubmission {
  key: string
  type: string
  input: JsonValue
  priority?: LanePriority
  retryPolicyId?: string
  deadlineAt?: number
  toolCallId?: string
}

interface ToolEffectInput {
  toolCallId: string
  toolName: string
  arguments: JsonValue
  privacy: PrivacyLabel
  derivedFrom?: DataRef[]
}

interface HumanEffectInput {
  prompt: string
  responseSchema?: JsonSchema
  privacy: PrivacyLabel            // 缺省时由 Host 默认策略填入，提交时必须已有标签
}

interface ToolCallCorrelation {
  toolCallId: string
  llmEffectId: EffectId
  toolEffectId?: EffectId
  resultRef?: ResultRef
}
```

`cancel_requested` 不是独立 EffectState：它是可与 `queued` / `running` / `retry_wait` / `reconcile_required` 并存的 flag。LLM 准备阶段仍为 `queued`，细节放在 `preparation`，explain 必须同时展示二者。

Effect 表示一次逻辑操作；Attempt 表示一次实际派发。重试保留 effectId，但生成新 attemptId，单次 Attempt 的失败不会提前让逻辑 Effect 的消费者恢复。由 LLM 提出的工具调用必须转换成带 `toolCallId` 的 `ToolEffectInput`；Runtime 保存 `ToolCallCorrelation`，工具完成后把同一个 `toolCallId` 与新生成的 `ResultRef` 关联。

`schedulePriority` 默认继承提交 Lane，可被策略降低；有效调度分还需要叠加消费者依赖继承。Effect 成功/失败/取消的逻辑 Outcome 一旦发布不可改变。

`EffectState` 表示逻辑 Effect 的生命周期；`AttemptRecord.executionState` 与 `AttemptRecord.sideEffectState` 分别表示某次实际派发的执行和副作用事实。`in_doubt` 不再是所有远端未知的统一状态，而是一个派生诊断：当 `sideEffectState === 'unknown'` 时，Effect 进入 `reconcile_required`，对外可标记为 `in_doubt`；只有 `executionState === 'remote_unknown'` 且副作用为 `none` 的纯计算，不应因此阻塞或隔离资源。

commit 之后若 Executor 同步抛错（模块加载失败、参数运行期非法），产生 `effect.dispatch_failed`，等同于 Attempt 失败且 `sideEffectState: 'none'`，走重试策略。

```ts
interface EffectHandle {
  id: EffectId
  status(): EffectState
  requestCancel(reason: string): void
}
```

Handle 是进程内 SDK 便利对象；ResumePoint 只保存 ID。工具实现内部可以 `await`，Runtime 只订阅完成事件，不在 Scheduler 中等待工具结果。

### 12.1 Lane 与 Child Agent 的边界

探索、搜索、并行调查默认使用 Lane，而不是为了并行而创建 Explore SubAgent。Lane 共享同一个 Agent 的目标、策略、权限、会话和 Global Context，只隔离执行位置与 Lane Context，成本更低。

只有当任务确实需要独立的 Agent 身份/系统提示、模型策略、工具权限、Context/Session 生命周期或结果边界时，才使用 `AgentEffect` 创建 Child Agent。换言之：**并行探索优先 Lane，语义隔离才使用 Child Agent。**

Child Agent 与父 Agent 共享 Runtime 级 LLM/Tool 槽和 `maxTotalLanes`。父 Lane 等待 AgentEffect 时，把当时 `effectiveScore` 写入 child root Lane 的 `inheritedFloor`，等待解除后撤销，避免父被自己的子 Agent 饿死。跨 Agent 的 Wait 边仍然禁止。

## 13. 提交、等待与批量操作

Effect 提交和等待是两个动作，可以分别执行；它们在一次 StepTransaction 中仍可与 ContextDelta、Fork、CancelLane 和 ResumePoint 原子提交，避免“提交成功但未记录等待”的半状态：

```text
LaneStepOutput {
  contextDelta?: ContextDelta
  actions: [
    {
      type: 'submit_effects',
      effects: [...],
      wait: { onUnsatisfied: 'resume_with_error', onCancelled: 'unsatisfied' }
      // 省略 wait 等价于旧的 wait: 'none'
    }
  ]
  next: ResumePoint
}
```

存在 `wait` 时一次创建多个 Effect、登记 Wait（对本批 effects，condition 默认 `settled`）、挂起 Lane。省略 `wait` 时提交后继续，返回的 ID 按唯一 key 写入下一 Step 的 `submitted` 输入，稍后可用 `WaitAction` + `LocalRef` 解析后的 `TargetRef` 显式等待。若必须在同一 Step 里等待刚提交的 Effect，使用 `submit_effects.wait` 或 `wait` + `LocalRef`，二者仍受“单一 Wait 来源”约束。

Runtime 在 validate 中完成参数、权限、数量、运行限制、依赖和资源/并发准入校验，apply 时原子提交 Effect 记录、Lane 执行位置和等待关系；随后才允许 Executor 派发。任一校验失败不得启动或保留部分 Effect，也不得只提交 ContextDelta 或其他 Action。

提交 Effect 不等于立刻开始运行。Step commit、提交后的排队、资源取得、执行和完成是独立阶段，事件和指标分别记录；commit 失败不会产生对外副作用。

## 14. Fork、Join 与声明式依赖

Fork 创建 Lane 的所有权关系；Lane 间依赖可形成有向无环图，不局限于“同批全部同时启动”。

```ts
type ForkTarget =
  | TargetRef
  | { kind: 'sibling'; key: string }

interface ForkLaneSpec {
  key: string
  goal: string
  program: ResumePoint
  priority?: LanePriority
  contextVersion?: 'parent' | 'latest' | ContextVersion  // 默认 'parent'
  affinityKey?: string                 // 调用方声明的亲和组；同组成员被视为“同系列”
  dependsOn?: Array<{
    key: string
    target: ForkTarget
    condition: 'success' | 'settled'
  }>
}

interface ForkAction {
  type: 'fork'
  lanes: ForkLaneSpec[]
  affinityAck?: boolean                // true：调用方已审阅亲和建议，Admission 不再因亲和拒绝
  join?: {
    mode: 'all'
    condition: 'success' | 'settled'          // 默认 settled
    onUnsatisfied: 'fail_lane' | 'resume_with_error'
    onCancelled?: 'unsatisfied' | 'ignore'
  }
}
```

新 Lane 的 `contextSnapshotVersion` 按 `contextVersion` 解析：`parent` 使用父 Lane 当前快照，`latest` 在提交时解析为当时最新 Global 版本并固定。Fork 是原子操作：模型只提出 Fork Proposal，Runtime 的 Admission Controller 检查 Runtime/Agent Lane 上限、局部 key、程序版本、引用、权限、并发/队列限制、资源约束与依赖环，全部通过后才转换为可执行 ForkAction 并创建 Lane。拒绝时返回结构化控制错误，交由父 Lane 的错误处理 Step。Pulse 不做各 Lane 的预先总预算切分。

### 14.1 Fork Proposal、Admission 与 Lane Pruning

模型输出不能直接创建 Lane。默认路径为：

```text
LLM
→ ForkProposal
→ Action Decoder / Schema Validation
→ Admission Controller
→ Policy / Limits / Dependency Check
→ ForkAction
→ 原子创建 Lane
```

模型负责提出“哪些方向值得并行”；Runtime 负责决定是否允许创建。Admission 只处理并发、队列、权限、依赖、资源准入和亲和检查，不给 A/B/C 预分配任务预算。Lane 的实际执行机会继续由全局 Scheduler 的 effective priority + aging 决定。

**Fork 亲和检查（`forkAffinity: 'advise'`，见第 15.9 节）。** 并行只对不相关方向有价值；同系列方向拆成多条 Lane 会各自冷启动、各自分叉认知、最后还要付合并成本。Admission 在依赖环检查之后，按确定性信号把 proposal 中的 Lane 分成亲和组：

- 调用方显式声明的 `affinityKey` 相同；
- `resolveResources` 结果存在 `exclusive` 重叠，或 `shared` 声明集合的 Jaccard 重叠超过策略阈值；
- 第一次 Step 的输入 ResultRef 集合重叠超过阈值；
- 使用相同 `toolSetId` 且 goal 引用的 workspace 路径（由 Program 在 `locals` 中声明，Runtime 不解析自然语言）落在同一模块前缀。

若存在成员数大于 1 的亲和组且 `affinityAck !== true`，Admission 拒绝本次 Fork，返回 `control_error { code: 'FORK_AFFINITY_COLLAPSIBLE', details: { groups: Array<{ keys: string[]; signals: string[] }> } }`。这次拒绝不计入 `consecutiveControlErrors`，因为它是一次预期内的建议回合。父 Lane 的错误处理 Step 有两种合法选择：按建议把同组成员改成一条 Lane（goal 携带有序子任务列表，Lane 内串行执行，共享一条 append-only 历史）后重新提交；或保留原拆分并设置 `affinityAck: true`，Admission 随后不再因亲和拒绝同一 proposal。Runtime 在 MVP 中不自动改写 Fork 形状：自动折叠会让 Join 的成员 key 和单个 Lane 的 Outcome 对不上，属于 M2 之后再评估的能力。`forkAffinity: 'off'` 时跳过该检查。

如果新的结果证明某条 Lane 已经没有继续价值：

- owner 使用 `pulse.cancel_lane(laneId, reason = 'SUPERSEDED')`；
- 非 owner 使用 `pulse.propose_cancel`，由 owner 的下一 Step 决定是否取消。

`SUPERSEDED` 表示工作方向被新证据淘汰，不表示 Lane 自身执行错误。Runtime 仍走标准结构化取消：停止该 Lane 后续派发、Abort 自有运行中 Effect、等待资源确认释放或移交 quarantine，再进入 cancelled 终态。被剪枝 Lane 的局部上下文不会自动进入其他 Lane 或 GlobalContext。Join 默认 `settled`，因此剪枝不会自动让父 Lane 失败；若 Join 使用 `success` 且未设 `onCancelled: 'ignore'`，则按第 8 节失败。

`dependsOn` 是启动 Wait，默认失败策略为 `fail_lane`。需要自定义失败恢复时，使用显式 WaitSpec；依赖满足后，结果按 key 注入新 Lane 的第一次 Step。

Join 是对一组 Lane 终态条件的 Wait，复用 DependencyGraph 和结果传递，不再另建一套唤醒机制。LaneGroup 仅保存成员、父 Lane 和 join 配置作为句柄/视图，状态由成员和 Wait 推导。

- 不设置 join：Fork 后父 Lane 继续，可稍后等待任意成员。
- `all + success`：所有成员成功才进入成功路径。
- `all + settled`（默认）：所有成员终结后统一汇总成功、失败和取消结果。

Join 失败本身不取消被依赖者。父 Lane 若因此进入失败收尾，才按所有权树取消自己的未完成子任务。以后加入 `any`、`first_success`、`n_of_m` 时必须同时定义剩余成员的处置策略。

不设置 join 时，Fork 的局部 key 到 Lane TargetRef 映射通过 `submitted` 输入返回；设置 join 时映射保存在 WaitRecord，其最终输入使用 `wait` 类型。Control Tool `pulse.join` 先解析 Group，再归一化为 `wait` Action，不增加第二套状态机。

## 15. 结果传递、三层 Context 与请求投影

### 15.1 控制依赖必须伴随显式输入

A 成功后 B 才能执行，仅解决了顺序，还必须让 B 获得 A 的输出。Pulse 不把原始结果直接塞进 B 或 GlobalContext，而是先把“结果已就绪”作为可调度事实交回 Runtime。

```text
A / Effect 完成
→ ResultStore 发布不可变 ResultRef
→ Outcome + 结果完成事件进入 FactInbox（接受后记录 result.published）
→ Transition Engine / DependencyGraph 更新等待状态
→ B 获得 pending ResumeInput / ResultRef
→ B 进入 ReadyQueue
→ Scheduler 按 effective priority + aging 选择 B
→ B 的同步 Step 提交 LLMEffect（默认 Agent LaneProgram）
→ LLM 读取必要 ResultRef，理解 / 总结 / 决策
→ 产出 Finding / Observation / ContextDelta / 新 Action
→ Runtime 校验后提交 ContextDelta 或后续 Effect
```

因此“结果完成”和“把结果写入上下文”是两回事。ResultStore 保存原始事实，Scheduler 决定何时让消费 Lane 获得模型执行机会，LLM 负责把原始结果消化成更稳定的认知状态。原始 Tool/LLM/Human/ChildAgent 输出默认不自动污染 GlobalContext。TimerEffect 的结果固定为 `public`。Human 响应按 `HumanEffectInput.privacy`（缺省 Host 策略）打标签后写入 ResultStore。

Wait 的失败恢复输入还包含失败原因和未完成目标清单。消费者不能直接读取生产者正在变化的局部上下文。依赖结果不隐式写入 GlobalContext。

WaitResolution 与 Lane.pendingResumeInput 在同一事务中保存，下一 Step 成功提交后才消费该输入；重放或未来恢复不能只保存 ready 状态却丢失唤醒数据。若该 Step 被拒绝，`control_error.original` 必须仍能找到这份 WaitResolution。MVP 在会话结束前保留结果；后续 ResultStore 回收必须考虑活动 Wait、未消费输入和快照的引用，不能在生产者结束时直接删除。

### 15.2 Snapshot + 局部 Delta

每条 Lane 持有一个明确的 Global Context `contextSnapshotVersion`，以及自己的 `laneContextVersion`（相关历史、observations、findings、artifactRefs 和已提交的 lane-target ops）。后创建的 Lane 可以使用较新的快照（`ForkLaneSpec.contextVersion`），但已创建 Lane 的基础快照不会暗中变化；构建 LLM 请求时也不能偷换成最新 Global Context。历史属于 Pulse 的结构化记录，不要求照搬某家 Provider 的 messages 格式。

Lane 结果包含业务数据引用和可选 ContextDelta。ContextDelta 带 `target`、`baseVersion`、`ops` 与来源；`proposal: true` 只是合并建议，不直接授权修改全局状态或执行文件写入。

### 15.3 Snapshot Adopt / Rebase

Global Context 版本发布与 Lane 读取哪个版本是两个独立动作：

```text
Lane 当前 contextSnapshotVersion = Global v1
→ 某个 target: 'global' 且非 proposal 的 ContextDelta 通过 ContextMerger 提交
→ 生成 Global v2
→ 其他 Lane 的 contextSnapshotVersion 保持 v1
→ Lane 显式提交 adopt_context(v2)
→ Runtime 原子更新该 Lane 的 contextSnapshotVersion
→ 下一次 Step / LLM Request 才读取 v2
```

`AdoptContextAction.version` 可以是已存在且属于当前 Agent 的具体 `ContextVersion`，也可以是 `'latest'`。`'latest'` 在 StepTransaction 提交时解析为当时的最新版本并固定下来，不是一个会随之后发布自动漂移的订阅。目标版本必须存在、可见、未被删除，且不能绕过 Lane 的数据外发与权限限制。

显式 Adopt 的请求形态为：

```ts
{
  actions: [
    { type: 'adopt_context', version: 2 },
    { type: 'submit_effects', effects: [...] },
  ],
  next: { programId: 'coding.main', programVersion: '1', step: 'await-results', locals: {} },
}
```

如果当前 Lane 自己的 Step 同时提交了会生成 Global 新版本的 `contextDelta`，可以设置 `adoptCommittedContext: true`：Runtime 先在同一事务中提交 Global v2，再把当前 Lane 的 `contextSnapshotVersion` 指向 v2，然后提交该事务中的其他 Action。这个选项不能用于 `target: 'lane'` 或 `proposal: true` 的 Delta，也不能与显式 `adopt_context` Action 同时出现。

其他 Lane 的 Context 更新绝不会自动刷新本 Lane 的 snapshot。即使 Global v2 来自 root Lane、Join 或外部 Host，Lane 也继续读取原快照，直到自己的 Step 显式返回 `adopt_context`。Adopt 只影响后续 Step，不改写已经提交的 LLM Request Context、等待中的 Effect 或历史结果；如需基于新快照重算，必须显式提交新的 Effect。

Adopt/Rebase 只切换读取基线，不等于把 Lane 的未合并局部 ops 自动写入新版本。若本地未提交 ops 与目标版本冲突（路径相等或互为前缀），Runtime 在 Adopt 校验时返回 `CONTEXT_REBASE_CONFLICT`，Lane 进入 `control_error`；Program 必须选择丢弃、重新应用或提交显式 Merge，不能静默 last-write-wins。

### 15.4 显式合并与外部副作用

root Lane 在 Join/Wait 后综合结果，消化 `MergeProposal`，由 ContextMerger 校验并串行提交新 GlobalContext 版本；同路径冲突返回冲突信息，不采用静默的 last-write-wins。

MVP 可以用 LLM 生成综合结论，由 Runtime 提交受限的上下文更新。LLM 总结不等于解决文件或数据库写冲突。文件补丁应包含目标基线 hash，并通过受锁保护的写入 Tool 验证、应用；工具写入是 Effect，必须受权限与取消规则约束。

### 15.5 Result Event 与模型消费边界

完成事件先更新对应依赖；只有当前 Wait 条件满足或按错误策略恢复，Lane 才进入 ReadyQueue。事件处理器不调用模型、不修改 Context，也不绕过 all Wait 提前恢复 Lane。

Result Coalescing 在提交 LLMEffect 之前完成：同一个 all Wait 的多个结果通过一个 WaitResolution 交付；LaneProgram 也可以把已显式取得且尚未消费的 ResultRef 合并进一次请求。`pendingResumeInput` 仍然只有当前恢复输入，不是可任意覆盖的全局事件邮箱。后续若增加独立 pendingEvents 队列，必须定义订阅范围、eventId 去重与消费水位。

一旦 Step 原子提交 LLMEffect，就固定本次请求的快照版本、结果引用、事件集合和指令。排队等待 LLM 槽或重试期间到达的新结果留给下一轮显式消费，不能偷偷改写已提交请求。提交失败时通过 `control_error.original` 保留原恢复输入，不丢失结果。这样既允许批量消费，也保留输入可追溯性。

Context 中优先保存经过模型消化的 Finding、Observation、Decision、摘要和 ArtifactRef；原始大结果保留在 ResultStore，需要细节时按引用再次读取。

### 15.6 三层 Context 的职责

| 层级 | 内容与生命周期 | 写入与共享规则 |
| --- | --- | --- |
| Global Context | Agent 目标、已确认事实、约束、重要发现、决策、当前计划与 ArtifactRefs；按版本保存 | 仅通过校验与显式合并发布；不保存所有原始输出 |
| Lane Context | 分两段：`history` 是 append-only 回合日志（每轮的 instruction、消费的 ResultRef 选择、校验后的 `LLMResult`、Finding/Decision），只能追加或显式 compact；`state` 是路径化的工作假设、局部计划与 locals 摘要，可被 `lane` ops 覆写。两段共用 `laneContextVersion`，基于固定 Global 快照 | 不同 Lane 默认隔离，通过依赖、Join、获授权的 ResultRef 或显式 Merge 共享；`history` 进入请求的稳定前缀，`state` 进入动态后缀（见第 15.8、15.9 节） |
| LLM Request Context | 单次请求的系统提示、策略、工具定义、相关 Global/Lane 内容、事件、结果片段与本轮指令 | ContextBuilder 临时生成；请求结束后释放投影，不整体写回任何 Context |

### 15.6.1 Privacy Label：MVP record 级，M1.5 可细化

Privacy 是数据属性，不是某一次 LLM 请求结束时才检查的开关。任何进入 Context、ResultStore 或 ArtifactStore 的可解释记录都必须带 `PrivacyMetadata`。

MVP 使用 **record 级标签**：`ResultRecord` / `Finding` / `ContextDelta` / `ArtifactRecord` / `CompleteAction.result` / `FailAction` 各有一个 `privacy`。业务 JSON 保持原形状，不强制把每个叶子包成 `PrivacyDataBlock`。子树可通过可选的 `@privacy` 覆盖，且只能更严格。派生规则按参与记录的最严格标签计算；`derivedFrom` 挂在 record 上。更细的叶子级 taint 留到 M1.5。

隐私级别按严格程度排序：`public < cloud_allowed < local_only`。对多个输入做派生、摘要、拼接或合并时，输出使用所有输入中最严格的标签。不能通过复制、重命名、截断或换成模型摘要来降低标签。

原始采集对象可以没有 `derivedFrom`；任何由其他 Result、Finding、Context 或 Artifact 产生的新对象都必须列出完整来源集合，不能只引用其中一部分来伪造较宽松的标签。

```text
local_only 输入
→ 本地模型摘要
→ 摘要仍为 local_only
→ 写入 Finding / ContextDelta / ResultRecord
→ 派生对象继续携带 local_only 与 derivedFrom
```

模型输出的 `privacy` 只是待验证的声明，不能覆盖来源标签。Runtime 在 Result 发布和 StepTransaction 校验时重新计算严格标签；输入含 `local_only` 时，任何 Result、Finding、ContextDelta 或 Artifact 的标签低于 `local_only` 都是隐私违规。

从 `local_only` 降到 `cloud_allowed` 必须产生新的派生对象并由 `outputRef` 指向，不能原地改写来源。唯一允许的路径是带可审计证明的 `downgrade_privacy`：`method: 'human_approval'` 必须引用批准记录，`method: 'sanitizer'` 必须引用可信脱敏器及其版本；StepTransaction 还要验证 `outputRef` 的 `derivedFrom` 覆盖所有 `sourceRefs`，且 `approvalRef`/`sanitizerId` 与 method 匹配。新对象保留 `derivedFrom`、批准/脱敏元数据，原始对象仍保持 `local_only`。LLM、普通 Tool 和 Provider Adapter 不能自行发起降级。M1 可以先实现请求级阻断（投影含 `local_only` 则云端候选不可用），完整 `downgrade_privacy` 在 M1.5 交付。

Shared Policy 由 Host/Runtime 管理。Context 中可包含供模型理解的策略投影，但模型提出的 Finding 或 ContextDelta 不能改写权限、系统提示或数据外发规则。结果正文、工具输出和检索内容始终作为数据块标明来源，不能提升为 System/Policy 指令。

例如搜索工具返回 500 条匹配，ResultStore 保存完整结果；模型消费相关片段后可提出“AuthStore.ts:83 可能在 token 初始化前发出请求”的 Finding，并附 ResultRef 与位置证据。Runtime 校验后写入 Lane Context，后续再显式合并到 Global Context；“可能”不能在合并中被无依据地改成已确认事实。

### 15.7 ContextBuilder 与不可变输入契约

```ts
interface LLMContextSpec {
  globalSnapshotVersion: ContextVersion
  laneSnapshotVersion: ContextVersion  // 固定局部上下文版本，不读取正在变化的对象
  resultRefs: ResultRef[]              // 本轮显式选择、已授权的不可变结果
  eventIds: string[]                   // 本轮相关事件的固定集合
  toolSetId: string                    // Host 批准且带版本的工具集合
  instruction: string
  privacy: PrivacyLabel                // Runtime 从所有选中数据重算的严格标签
  privacyRefs: DataRef[]               // 标签计算与审计所依据的来源
}

interface LLMRequestProjection {
  contextSpec: LLMContextSpec
  blocks: Array<{
    kind: 'system' | 'policy' | 'tools' | 'global'
      | 'history' | 'lane' | 'events' | 'results' | 'instruction'
    content: JsonValue
  }>
  prefixHash: string                   // system..history 的 hash，用于观测连续请求的前缀是否稳定
  projectionHash: string
  builderVersion: string
  policyVersion: string
  toolSetVersion: string
  privacy: PrivacyLabel
  privacyRefs: DataRef[]
}
```

Step 只提交可序列化的 LLMContextSpec；Runtime 在提交事务中验证引用归属、可见性、版本、保留期限和 Privacy Label。ContextBuilder 从所有选中的 Global/Lane/Result/Artifact 记录重新计算严格 `privacy`，不得信任调用方较宽松的声明；不一致时拒绝提交。它随后从这些固定输入读取必要内容并生成投影，不扫描其他 Lane 的历史，也不自动注入整个 Tool Registry。LLMEffect 是普通 `type: 'llm'` Effect，其 input 契约见第 22.1 节。

当投影包含 `local_only` 数据时，ContextBuilder 必须把请求标记为 `local_only`；ModelRouter 只能保留可信本地候选，云端候选直接返回 `PRIVACY_CLOUD_BLOCKED` 并且不得派发。`cloud_allowed` 允许云端候选，但仍受 Host 外发策略约束。`public` 另外允许进入导出与 Child Agent Outcome。策略收紧、fallback、重试或换模型都必须重新检查同一个投影的标签和 `privacyRefs`，不能借由旧请求或 Provider 会话绕过。

大输出按确定性的范围/片段选择规则提取，保留 ResultRef 和位置；投影记录所选内容及其 hash，缺失引用应显式失败。构建需要磁盘或 Artifact 读取时，放在异步 Executor 准备阶段，不能阻塞同步 Step 或 Scheduler tick。准备并发、已准备投影数量（`maxPreparedLLMs`）与投影大小均应有上限，并响应 Effect 的取消和 deadline。准备任务只在“预计接下来会派发”的 lookahead 窗口内启动，避免 256 个 queued LLMEffect 准备出 200 份 pinned 投影。

ContextBuilder 不隐式调用模型做摘要。需要语义压缩时，LaneProgram 显式提交 `task: 'summarize'` 的 LLMEffect，再以其经过校验的结果构建后续请求。超出候选模型窗口时重新选择合规候选，或返回 `CONTEXT_TOO_LARGE`；不能静默丢弃策略、任务约束或必要证据。这里的单次上下文容量约束不等于给 Lane 分配总 token 预算。

完整请求正文可在 Attempt 结束后释放；同一逻辑 Effect 后续重试仍须能从固定引用重建相同语义输入。保留 builder/policy/toolSet 版本、projectionHash、来源引用及选择规则；需要精确审计时可按脱敏与保留策略保存请求 Artifact。释放临时投影不等于删除 ResultStore 原始结果。

### 15.8 稳定前缀与 Prompt Cache

无状态请求由 Pulse 显式传入上下文；缓存是否命中由 Provider Adapter 对接的实际能力决定。Core 提供确定性的请求组织，不承诺跨模型、跨供应商或任意两条 Lane 必然共享缓存。

```text
稳定前缀：System → Shared Policy → Tool Definitions → Stable Global Snapshot → Lane History（append-only）
动态后缀：Lane State → Pending Events → New Result Data → Current Instruction
```

- 相同输入、版本和工具集合生成相同块顺序、工具排序与确定性序列化；来源有顺序语义的事件按 seq 排列。
- 将高稳定内容放前面。timestamp、随机请求 ID、progress 和无关 telemetry 留在请求元数据/观测记录，不进入稳定前缀。
- Lane History 是前缀的一部分：同一 Lane 连续两次 LLMEffect，后一次的 `history` 块必须等于前一次的 `history` 块加上前一轮归档的记录（instruction、消费的 Result 选择、校验后的 `LLMResult`），逐字节一致。前缀只增长不重排，除非发生显式 compact。
- 仅在必要内容发生变化时发布新的 Global Context 版本；已有 Lane 仍使用自己的快照，不能为缓存命中隐瞒真实变更。
- 工具集合不同、策略变化或快照不同会改变前缀。不能为共享缓存把其他 Lane 无权读取的工具或数据塞进请求。
- 缓存边界、cache key、TTL 和供应商消息格式由 Adapter 映射；逻辑块的稳定顺序不假定 Provider 支持任意显式缓存断点。

缓存是性能优化。命中、未命中或缓存过期都必须保持同样的状态转换与输入语义，实际收益按第 27 节测量。

### 15.9 Context Affinity：同系列任务复用上下文

主流 harness 的单对话循环天然拥有两个优点：每次请求的前缀就是上一轮的整个对话，缓存全热；模型始终沿着一条连续的思路推进，不会每次面对一份重新挑选、重新排序的证据集。Pulse 把等待局部化到 Lane 之后，不能丢掉这两个优点。Context Affinity 的目标是：**同系列的工作尽量落在同一条上下文线上，只有真正不相关的方向才拆开并行**。类比 OS 调度中的 CPU cache affinity：调度器可以自由迁移线程，但默认不迁移，因为迁移的代价是冷缓存。

亲和分三层，各自有明确的边界。

**第一层：Lane 内连续请求（M1）。** Lane Context 的 `history` 段是 append-only 回合日志。每次 LLMEffect 结束、`LLMResult` 通过校验后，Runtime 在同一 StepTransaction 中把本轮的 instruction、Result 选择（ResultRef + 选择规则 + hash，不复制正文）、`LLMResult` 和产生的 Finding/Decision 归档为一条 `HistoryRecord` 追加到 `history`。下一次投影从 `history` 渲染前缀时，对每条记录使用与当初相同的确定性序列化，因此前缀恰好增长一轮。Result 正文按 ResultRef 重新读取：结果不可变，字节一致。这就是把 Claude Code 的“对话越来越长、前缀始终不变”装进一条 Lane，同时保持 Pulse 是真源、Provider 只是缓存。

```ts
interface HistoryRecord {
  seq: number                          // Lane 内单调递增
  effectId: EffectId
  instruction: string
  resultSelection: Array<{ ref: ResultRef; rule: string; hash: string }>
  result: LLMResultRef                 // 校验后的 LLMResult，不含被拒绝的输出
  findings?: FindingRef[]
  privacy: PrivacyLabel
}
```

`history` 段对应的 `ContextOp` 只有第 7 节定义的 `compact_history`；`history` 不能被 `set` / `remove` 改写，只接受 Runtime 追加和显式 `compact_history`。compact 由 LaneProgram 决定：当 `history` 的估算 token 超过 `AffinityPolicy.historyCompaction.softTokens` 时，Runtime 在 `LaneRecord.historyPressure` 上维护当前水位（`step()` 通过 `lane` 参数读到，不是新的 ResumeInput，也不会唤醒正在等待的 Lane）；Program 提交 `task: 'summarize'` 的 LLMEffect（输入为 `history[..upToSeq]`），再以校验后的摘要 ResultRef 提交 `compact_history`。compact 后 `history` 变为 `[summary] + history[upToSeq+1..]`，前缀冷一次，之后重新热。超过 `hardTokens` 且 Program 仍未 compact 时，ContextBuilder 返回 `CONTEXT_TOO_LARGE`，不自动裁剪。摘要继承被压缩记录的最严格 Privacy Label 与完整 `derivedFrom`。

`history` 段服务于连续性，不豁免第 15.7 节的显式引用契约：`LLMContextSpec.laneSnapshotVersion` 仍固定本次读取的 `history` 长度；重试同一 Effect 用相同版本重建相同前缀。

**第二层：Fork 亲和（M1.5）。** 见第 14.1 节。Admission 对 ForkProposal 计算亲和组，同组成员被建议折叠成一条 Lane 串行执行，共享同一段 `history`。三个同系列子任务在一条 Lane 上是三次热请求加一份连续认知；拆成三条 Lane 是三次冷启动加一次合并。Runtime 只建议、不改写：`FORK_AFFINITY_COLLAPSIBLE` 拒绝一次，Program 重提或 `affinityAck`。Lane 内串行的代价是延迟：三个子任务排队一定比三条 Lane 慢。这是第 27 节要测量的取舍，不在此处拍定默认值以外的东西。默认值是“相关方向亲和、不相关方向并行”，与第 28 节“并行探索优先 Lane”不冲突，后者说的是“并行时用 Lane 而不是 Child Agent”。

**第三层：跨 Session warm start（M1.5）。** 同系列的后续任务（同一 bug 的第二轮、同一模块的相邻需求）可以显式复用上一个 Session 的最终 Global Context 作为初始快照。

```ts
interface WarmStartSpec {
  sessionId: SessionId
  globalVersion: ContextVersion | 'final'
  include: 'facts' | 'facts_and_findings'    // 默认 facts：只带已确认事实、约束、决策
  relevanceRefs?: ResultRef[]                 // 可选：Program 已筛选的相关 Finding
}

runtime.createAgent({ goal, program, warmStart?: WarmStartSpec, ... })
```

规则：

- warm start 是 `createAgent` 时的一次显式 adopt。新 Agent 的 Global Context v0 等于所选版本的内容副本，随后独立演进，不与旧 Session 共享可变状态。不指定 `warmStart` 时不继承任何东西，Runtime 不做隐式“上次做过类似的事”匹配。
- 复制过来的每条记录保留原 Privacy Label 与 `derivedFrom`；新 Agent 的 Host Policy 若比旧 Session 严格，Runtime 在创建时按新策略重算可用性，`local_only` 记录仍阻断云端路由。
- 缓存收益只在 Provider 前缀缓存 TTL 内成立（主流为分钟到一小时量级）。超过 TTL，warm start 的价值只剩减少重复调查和保持认知连续，Runtime 观测要把这两种收益分开记。
- `include: 'facts'` 是默认值，因为陈旧的 Finding 是双刃剑：相关时聚焦注意力，不相关时是塞进窗口的噪音。要带 Finding 必须显式 `facts_and_findings` 或用 `relevanceRefs` 点名。

**AffinityPolicy。**

```ts
interface AffinityPolicy {
  laneHistory: 'append_only' | 'rebuild'      // 默认 append_only；rebuild 只用于对照实验
  forkAffinity: 'off' | 'advise'              // 默认 advise；自动 coalesce 留待 M2 评估
  affinitySignals: {
    exclusiveOverlap: boolean                 // 默认 true
    sharedJaccardThreshold: number            // 默认 0.5
    resultRefJaccardThreshold: number         // 默认 0.5
    pathPrefixDepth: number                   // 默认 2；0 关闭路径信号
  }
  historyCompaction: { softTokens: number; hardTokens: number }
}
```

三个必须一起写清的代价：

1. `history` 只增不减，撞窗口时必须 compact，compact 让前缀冷一次。所以压缩做成显式 checkpoint（压一次、冷一次、再热），不做每轮动态裁剪；每轮裁剪会让每一次请求都是冷的。
2. 复用上下文对注意力是双刃剑。第一层的连续性几乎总是正收益；第三层的 warm start 需要相关性筛选，默认只带事实。
3. 亲和折叠用延迟换缓存与一致性。这是可测的取舍，不是不变量；第 27 节要同时报告“折叠后关键路径延迟”和“折叠前后请求数、缓存命中、合并冲突”。

亲和的任何一层都不改变第 15.3 节的快照规则、第 15.6.1 节的隐私传播和第 7.1 节的两阶段提交。缓存命中与否不能出现在任何状态转换条件里。

## 16. 资源锁、并发额度与背压

Effect 派发需要同时满足：输入有效、权限通过、依赖允许、未取消、未超 deadline、Runtime Limits 允许、并发额度可用、资源锁可取得。

并发限制按 Runtime 总量和 `concurrencyClass` 组合生效；LLM 可进一步按 provider/model 限流。并发额度、队列上限、deadline 与优先级是不同约束；它们用于保护 Runtime 和资源，不构成一次 Agent 任务的预分配总预算。`concurrencyClass: 'none'` 的 Human/Timer 不走这套执行槽。

### 16.1 资源级并发

单个 `concurrency: exclusive` 无法说明锁谁，因此改成明确的资源需求：

```ts
interface ResourceClaim {
  key: string
  mode: 'shared' | 'exclusive'
}
```

MVP 使用 workspace 粒度：读文件、搜索源码持有 workspace shared 锁，修改文件、git checkout、安装依赖持有 workspace exclusive 锁。与 workspace 无关的网络工具不占 workspace 锁。粒度较粗，但先保证一致性；以后按文件、仓库、浏览器会话细化。

资源 key 由可信 Tool adapter 的 `resolveResources(input)` 根据规范化输入和 Runtime 上下文解析，模型不能自行声明“无锁”。未实现该方法时按 `ToolMeta.sideEffect` 默认：`write` / `external` → workspace exclusive，`read` → workspace shared，`none` → 无 workspace 锁。未知行为的 Shell 默认 workspace exclusive；读写工作区外路径还需单独授权与资源声明。

这些锁只协调本 Runtime 管理的工作，不能阻止编辑器或其他进程修改文件；写入前的基线验证仍然必要。多个 Runtime 共享同一 workspace 的跨进程锁不属于 MVP 保证。

一次派发原子取得所有资源锁和并发额度，任一不可用就全部不占用。工具执行过程中禁止临时再申请 Runtime 锁；需要新的锁集合时结束本次 Effect，重新提交。这样避免持有部分锁等待其他锁。

重试退避期间不持锁、不占并发槽。运行或取消收尾期间，具有未确认副作用的 Attempt 一直保留相关锁和额度，直到确认执行停止并完成对账，或移交 quarantine 后由 QuarantineScope 继续持有；不能只收到 cancel request 就提前释放。纯 LLM 或明确 `sideEffectState: 'none'` 的计算在本地连接关闭后可以释放本地 LLM/provider/model 槽，即使 Attempt 的远端执行仍为 `remote_unknown`。

锁等待队列按 `effectiveScore + enqueueSeq` 排序。已有 exclusive 等待者时，最多再放行 `writerPreferenceBound` 个已经排在前面的 shared，之后阻止后到的 shared 插队；允许调度其他不冲突的资源工作。高优先级不能缩短已经运行的外部操作，也不向持锁的 running Effect 传分。

### 16.2 有界队列

- 超过 `maxTotalLanes` 或 Agent `maxActiveLanes` 的 Fork 整批拒绝，返回可处理的 `LANE_LIMIT_EXCEEDED`。
- Effect 并发不足时进入有界队列；超过 `maxQueuedEffects` 的提交整批拒绝。Human/Timer 不计入该容量。
- 控制面 FactInbox 为完成、取消、deadline 和 Host 命令预留处理能力，不能被 ObservationInbox 的 progress/chunk 淹没。
- Progress/chunk 可合并、采样或丢弃；终态事件不得静默丢失。
- MVP 不运行跨资源嵌套调用：Tool 不能持锁调用并等待同一 Runtime 的另一 Effect。

## 17. 取消、超时与未确认结果

### 17.1 请求与确认分开

```text
cancel command → FactInbox
→ 标记 scope 正在取消，禁止新工作
→ Lane: cancelling（若原为 closing，保留 pendingOutcome）
→ 无准备工作在途的 queued Effect: 直接 cancelled
→ queued LLMEffect 若正在准备请求: Abort 准备工作，确认清理后 cancelled
→ running Effect: cancelRequested = true，发出 AbortSignal
→ Executor 停止执行并完成清理
→ 确认 Outcome，释放锁和并发额度
→ 超过 cancelGraceMs 仍 reconcile_required：移交 QuarantineScope
→ Lane / Agent 完成收尾（可带 unresolvedEffectIds）
```

AbortController 通过 signal 通知协作方取消；Runtime 仍必须等待 Executor 的实际停止确认。[Node.js AbortController 文档](https://nodejs.org/api/globals.html#class-abortcontroller)

取消通过所有权树传播，不通过依赖图传播。B 等待 A 时取消 B，只撤销 B 的等待；如果 A 属于其他 scope 或被多个消费者使用，不因此取消 A。sibling 不能直接 `cancel_lane` 对方。

Runtime 单写者以事件接受顺序处理完成/取消竞争：已提交的终态保持不变；若先接受取消请求但 Executor 随后确认已产生成功结果，Effect 可记录成功与 `cancelTooLate`，取消中的 Lane 仍不恢复业务执行。不能声称成功副作用已经被撤销。

### 17.2 Timeout 分三层

- `deadlineAt`：绝对期限，覆盖排队、执行和重试。
- `attemptTimeoutMs`：单次执行超时，从派发开始计算。
- `cancelGraceMs`：请求取消后等待 Executor 清理的时限。到期后仍无法确认停止的自有 Effect 必须移交 quarantine，不能无限阻塞 Lane 终态。

Wait 可以有独立 deadline；Wait 超时只结束本次等待，不直接取消共享目标。是否进入 Lane 收尾由 `onUnsatisfied` 决定。

Effect 超时先取消当前 Attempt。若本地清理完成且 `sideEffectState = none`，纯计算可按执行策略在远端状态未知时重试或 fallback；若副作用可能存在，则必须确认停止/完成对账后才可重试或以 `TIMEOUT` 失败。显式用户取消不自动重试。Shell Executor 可采用终止进程组、宽限等待、强制终止的升级流程，退出后再确认资源释放。

清理超时且不能确认停止时，先记录 Attempt 的 `executionState = remote_unknown`。若 `sideEffectState = unknown`，Effect 进入 `reconcile_required`，对外报告 `in_doubt`，隔离资源并发额度和锁；若 `sideEffectState = none`，可按纯计算规则释放本地模型槽并进入受限 retry/fallback。不得在副作用未知时释放冲突写入所需的资源，也不得把远端未知伪装成已停止。

依赖者的处理：

- 业务 Wait 仍可继续等待，或由自己的 deadline / `onUnsatisfied` 进入失败处理；
- Lane `closing` / `cancelling` 在 `cancelGraceMs` 后不再等待该 Effect：记 `effect.quarantined`，把锁与额度的持有者改为 QuarantineScope，Lane 带 `unresolvedEffectIds` 进入终态。

这是 Runtime 内部 scope，不是对外 detached API。

### 17.3 执行状态与副作用状态分离

`executionState` 描述“这次 Attempt 的计算/连接走到哪里”，`sideEffectState` 描述“是否需要确认外部副作用，以及该事实是否已知”。两者不能互相推断：远端推理仍可能未知，但不代表发生了业务写入；本地连接已经关闭，也不代表远端一定停止。

典型执行状态转换为：

```text
running
  → locally_closed                 本地连接、进程和清理已完成
  → settled                        远端完成/未执行已被确认
  → remote_unknown                 本地已关闭，但远端结果无法确认
```

`locally_closed` 是短暂的确认阶段；不能把它当成远端已停止。进入 `remote_unknown` 后，是否释放槽、是否允许新 Attempt，只由 `sideEffectState` 与该 Effect 的执行策略共同决定。

纯 LLM 推理的默认规则是：

```text
本地连接清理完成
→ 记录 localClosedAt
→ 远端状态无法确认：executionState = remote_unknown
→ sideEffectState = none
→ 释放本地 LLM/provider/model 槽
→ 按 executionPolicy 允许有界 retry / fallback
→ 接受重复计算，最终只发布一个逻辑 Effect Outcome
```

`duplicateExecutionPolicy: 'allow'` 时，`maxUnknownAttempts` 限制仍处于 `remote_unknown` 的未知 Attempt 数；每次重试复用逻辑 `effectId`，生成新的 `attemptId`。超过上限后，逻辑 Effect 可以以 `REMOTE_EXECUTION_UNKNOWN` 失败并保留未知 Attempt 记录，不得把它误报为已取消或已确认失败。`duplicateExecutionPolicy: 'forbid'` 时不再启动可能重复的 Attempt，等待 Provider 对账或 Host 决策；这不是副作用 `in_doubt`，但应进入 explain 的 `reconcile_required`/策略阻塞视图。

有外部副作用的 Tool 在本地清理后无法确认远端状态时，记录 `executionState = remote_unknown` 与 `sideEffectState = unknown`，逻辑 Effect 进入 `reconcile_required`（对外诊断为 `in_doubt`）：

```text
不得直接 retry 或 fallback
保留写资源隔离与必要并发额度
等待 RecoverableTool.reconcile()、外部查询或人工处理
确认 sideEffectState 后，才允许 settled、补偿或有幂等协议的后续动作
Lane/Agent 收尾到期则移交 QuarantineScope，不挂死 run()
```

只读 Tool 或明确没有外部副作用的 Executor 可采用纯计算规则；Tool 的 `sideEffect`、`retrySafety` 和可信 Adapter 行为声明决定初始策略，模型不能自行声称 `sideEffectState = none`。

### 17.4 Detached 与 Quarantine

Detached 表示转移到 Runtime 的 background scope，不表示无人管理。脱离父 Lane 的取消传播，但仍受 Runtime shutdown、权限、运行限制和错误记录约束。

MVP **不暴露** detached API。QuarantineScope 是内部实现：只收容 `reconcile_required` 且收尾到期的 Effect，继续持有冲突资源直到对账或 Host 放弃。`inspect()` 必须列出 quarantine 清单；Host 可触发 `reconcile` 或 `abandon`（放弃时记录 `RESOURCE_ABANDONED`，不假装副作用未发生）。后续若增加公开 detached API，必须同时实现 background scope 的观测、取消和退出策略。

### 17.5 Runtime 退出

Host 调用 shutdown 后停止接收新 Agent，向活动 scope 发起取消，并等待 Executor 停止。达到退出期限仍未收尾时返回未完成清单、quarantine 清单及隔离资源；不把 shutdown 超时伪装成 Agent cancelled。`run()` 的终态等待与 `inspect()` 的阻塞报告分开：Agent 可以带着 `unresolvedEffectIds` 返回，quarantine 继续在 Runtime 内可见。`reconcile_required` 与由副作用未知派生的 `in_doubt` 必须可观测；纯 LLM 的 `remote_unknown` 不应被误报为副作用未知。

## 18. 重试、幂等性与 Runtime Limits

```ts
interface RetryPolicy {
  maxAttempts: number      // 包含第一次
  initialBackoffMs: number
  maxBackoffMs: number
  jitter: boolean
}
```

默认值：普通 Tool `maxAttempts = 1`；LLMEffect 的默认 `maxAttempts = max(1, 该 task 当前合规候选数)`，否则注册两个候选也永远走不到 fallback。Host 可以显式覆盖，但不能用“每个候选一套无限重试”绕过上限。

重试前必须同时满足：错误可重试、策略允许、前次 Attempt 已本地关闭；如果 `sideEffectState = unknown`，还必须完成对账；deadline 未过、Runtime Limits 允许且未收到取消请求。纯 LLM 的 `remote_unknown + none` 只有在 `duplicateExecutionPolicy = 'allow'` 且未超过 `maxUnknownAttempts` 时例外允许。

- 只读工具可以显式配置重试，但输出仍可能随外部状态改变。
- 写入或外部提交工具默认不自动重试；只有 Executor 声明并实现幂等键/对账协议后才开启。
- 幂等键在同一个逻辑 Effect 的重试中保持稳定；Attempt ID 每次变化。
- 上次是否成功未知时，先分别记录 `executionState` 和 `sideEffectState`；只有副作用状态未知才进入 `reconcile_required`/`in_doubt`，不能把所有网络异常都当成写入未知，也不能把远端未知简单解释为“操作没有发生”。
- 退避通过 TimerWheel / RuntimeClock 安排唤醒；随机 jitter 的实际 delay 记录在事件中。不另建一套与 TimerEffect 无关的定时器。
- 工具不私自循环重试。供应商 SDK 如自带重试，Adapter 必须禁用或显式纳入 Attempt 计数、限流和观测。
- LLM fallback 是同一 Effect 的新 Attempt，沿用本节限制和 `maxUnknownAttempts`；不能在 ModelEffectExecutor 内另开重试循环。纯 LLM 的远端未知可以释放本地槽并按 `duplicateExecutionPolicy` 有界重试，副作用未知的 Tool 仍必须等待对账。候选切换与固定上下文要求见第 22.5 节。

Pulse 的核心调度不要求 Agent 预先声明总 token、总费用或把资源额度切分给各 Lane。Runtime 持续执行直到 Agent 成功、失败、取消，或命中 Host 明确配置的 deadline / 安全限制。

Runtime Limits 主要保护进程和外部资源，包括 Runtime/Agent Lane 上限、排队 Effect 上限、LLM/Tool/Agent 并发槽、准备与已准备投影上限、单次 Attempt timeout、重试次数、连续控制错误上限、Progress Watchdog 窗口/无进展阈值和可选的 Host 策略限制。LLM token、费用、调用次数等默认作为 usage 指标记录；如果宿主产品需要硬上限，可以作为 Policy Guardrail 插件实现，但不进入 Pulse 核心的 Lane 预算分配模型。

## 19. Event、日志与状态事务

```ts
interface RuntimeEvent extends StorageResidency {
  id: string
  schemaVersion: number
  sessionId: string
  txId?: TxId
  seq: number
  type: string
  timestamp: number
  agentId?: AgentId
  laneId?: LaneId
  effectId?: EffectId
  attemptId?: string
  causationId?: string
  payload: JsonValue
}
```

Executor 上报 EventEnvelope，不自行分配全局 seq。Runtime 接受后生成单调序号；timestamp 用于观测，seq 用于状态顺序。同一 StepTransaction 的事实事件共享 `txId`，重放时按事务分组。外部请求本来可能以不同顺序完成，重放复现的是已记录的顺序，不保证重新运行得到同样结果。

主要事件族：

```text
agent.created / started / cancelling / succeeded / failed / cancelled
lane.created / ready / started / waiting / closing / cancelling
lane.succeeded / failed / cancelled / priority_changed
lane.forked
wait.registered / satisfied / unsatisfied
step.committed / step.rejected
progress.fingerprinted / no_progress_detected / intervention_applied

effect.queued / attempt_started / attempt_failed / retry_scheduled
effect.dispatch_failed / cancel_requested / reconcile_required
effect.quarantined / succeeded / failed / cancelled
attempt.locally_closed / attempt.remote_unknown / attempt.settled
attempt.late_emit
result.published
context.committed / adopted / rebase_conflict
merge.proposal_recorded
privacy.label_propagated / cloud_blocked / downgrade_committed / violation
llm.request_prepared / route_selected / route_rejected / fallback_scheduled
llm.usage_recorded
command.enqueued / command.applied
cancel.intent
limit.rejected / deadline.exceeded
resource.acquired / released / quarantined
storage.persisted / compacted / pin_changed / limit_exceeded
```

ObservationInbox 中的 tool progress、LLM chunk 与 scheduler trace 是观测流，可配置保存和 compact，不要求全部进入决定业务恢复的事实日志。事实事件逻辑上保留；驻内存受 `maxEventLogBytes` 约束，M2 用 checkpoint 截断前缀。

LLM 完成统一使用 effect.succeeded / failed / cancelled，不再引入独立的 llm.completed 唤醒协议。llm.* 事件记录请求准备、模型选择、fallback 与 usage，不代替 Effect 生命周期。`request_prepared` 对应派发所需事实；route/fallback 决策记录与 Attempt/重试状态一起提交，投影正文通过受控 Artifact 引用保存，避免在事件中重复存储大段输入。

一次状态事务就是第 7.1 节的 `validate → Mutation[] → apply`：输入校验、状态版本检查、结果发布、依赖转换、`laneVersion` 更新和事实事件都在同一组 Mutation 里。StepTransaction 还必须把 ContextDelta、生成的 ContextVersion、Lane snapshot、Lane 状态、Effect/Wait 记录、Cancel Intent 和 ResumePoint 作为同一提交单元；apply 之后才通知观察者、派发外部操作。MVP 在内存中执行该协议；持久化版必须实现存储事务与 outbox，不以“先写日志再调用工具”替代可靠派发协议。

使用 `eventId` 去重，使用 `effectId + attemptId` 防止过期 Attempt 唤醒消费者；同一业务终态只能提交一次。过期 Attempt 的迟到成功应记录为异常事实并按需触发对账，不能覆盖当前 Outcome。Attempt 终结后 `emit()` 必须成为 no-op，并记 `attempt.late_emit`。

对每条 Lane 提供 explain 信息：状态、当前等待目标、基础/有效优先级及来源、队列等待时间、锁/额度阻塞原因、最近事件序号、Progress Watchdog 窗口、`noProgressCount`、`interventionLevel`、`consecutiveControlErrors` 和最近干预原因。LLMEffect 还需说明 `preparation`、投影版本、候选及排除原因、实际模型、provider 槽等待和 fallback 记录。quarantine 清单进入 Runtime explain。诊断能力进入 M0，无需先做 Web UI。

## 20. 持久化、重放与恢复边界

### 20.1 MVP：可序列化与观测

MVP 提供内存 EventLog、可导出的会话记录、不可变结果与纯状态转换测试，同时按 `SessionStoragePolicy` 执行驻内存 hard limit、pin 和显式超限失败。导出记录可用于分析和测试重放，不保证进程崩溃后继续执行，也不承诺记录在崩溃时完整落盘；没有持久化后端时，unpinned 数据只能 compact，不能伪称为 `persisted`。

重放只 apply 已记录的 Mutation / 事实事件。因此 `step()` 必须是纯函数；测试用 RuntimeClock 与注入的随机源。重放**不**重新调用 `step()` 去“算出同样的下一步”，而是直接应用当时提交的 Mutation。若要用 Program 做回归，必须用同一 `now` 与同一 ResumeInput 再跑一遍纯函数并比对 Mutation。

### 20.2 后续：可靠恢复

要声明支持恢复，至少需要：

1. 持久化事务保存 Lane、Wait、Effect、ResultRef、`laneVersion`、Mutation 日志和事件序号。
2. 持久化 Result、Event、Snapshot 的 `storageState`、大小和 pin 来源；恢复后重建 pinCount，不能把落盘对象误当成可淘汰对象。
3. 快照带 schemaVersion、程序版本、日志水位与完整引用校验；包括固定的 Global/Lane Context、ResultRefs、ProgressWatchdogState、ContextBuilder/工具/策略/路由配置版本，以及已选模型和 Attempt 信息，不依赖 Provider Thread 恢复。
4. outbox 保存待派发意图；Executor 通过幂等键、查询或人工处理解决重复派发。
5. 为在途 Attempt 提供 reconnect/reconcile；执行状态和副作用状态分别恢复，只有副作用未知的外部操作进入 `reconcile_required`/`in_doubt`。QuarantineScope 必须一并恢复。
6. 重建 WaitingIndex、ReadyQueue、TimerWheel、锁与并发占用；不恢复失效的进程内 Handle。
7. 保存绝对 deadline；本进程耗时使用单调时钟，重启后重新评估 deadline。ready 等待补偿保存累计值，不能持久化进程内单调时间戳直接复用。
8. 程序/工具版本不兼容时停止恢复并要求迁移，不能用新代码默默解释旧 ResumePoint。
9. checkpoint 之后才能截断事实日志前缀；截断不改变已纳入快照的逻辑历史。

**重放只应用已记录事实，不重新调用 LLM 或工具。** 从暂停点继续执行属于恢复；恢复后的外部结果仍可能不同。

快照、日志和工具输出可能包含敏感数据，应支持输出裁剪、脱敏和 artifact 保留策略；不把凭证写入 ResumePoint 或完整事件 payload。`public` 才允许无脱敏导出；`cloud_allowed` / `local_only` 必须按策略裁剪。

## 21. Tool SDK 与类型契约

保留 TypeScript-first 方向，同时区分三层契约：

| 层 | 用途 |
| --- | --- |
| TypeScript 导出类型 / `.d.ts` | 开发接口与模型可读说明 |
| JSON Schema | Runtime 输入验证，必要时输出验证 |
| Manifest + Executor contract | 加载入口、版本、权限、资源与执行行为 |

`.d.ts` 描述代码的类型接口，本身不是可执行实现。[TypeScript 声明文件文档](https://www.typescriptlang.org/docs/handbook/declaration-files/introduction.html) Runtime 不能只靠 `.d.ts` 验证模型传入值或判定副作用安全性。

```ts
interface ToolMeta {
  name: string
  version: string
  sideEffect: 'none' | 'read' | 'write' | 'external'
  cancellation: 'cooperative' | 'best_effort'
  retrySafety: 'read_only' | 'idempotent' | 'unsafe'
  defaultTimeoutMs: number
}

interface ToolContext {
  toolCallId: string
  effectId: EffectId
  attemptId: string
  idempotencyKey?: string
  agentId: AgentId
  laneId: LaneId
  signal: AbortSignal
  emit(event: { type: 'progress' | 'warning' | 'diagnostic'; data: JsonValue }): void
}

interface Tool<TInput, TOutput> {
  readonly meta: ToolMeta
  resolveResources?(input: TInput): ResourceClaim[]
  execute(input: TInput, context: ToolContext): Promise<TOutput>
  normalize?(output: TOutput): JsonValue   // 供 resultSignature；默认剔除 timestamp/ID
  summarize?(output: TOutput): JsonValue   // 可选：≤ maxResultSummaryBytes 的结构化摘要，随 ResultRecord.summary 发布
}
```

`summarize` 是给同步 Step 做分支判断用的有界出口（例如 `{ passed: false, failures: 3 }`），不是给模型看的内容。`ResultRecord.summary` 与正文共用同一 Privacy Label；超过 `maxResultSummaryBytes`（Host 配置，建议 4 KB）则发布失败并回退为无 summary。Step 只能读 `summary` 和 metadata，正文仍只能通过 ResultRef 交给 LLMEffect 或 Tool 消费。

```ts
class ToolError extends Error {
  code: string
  retryable: boolean
  details?: JsonValue
}

interface RecoverableTool<TInput, TOutput> extends Tool<TInput, TOutput> {
  reconcile(
    executionRef: JsonValue,
    context: ReconcileContext
  ): Promise<ReconcileResult<TOutput>>
}
```

Tool 的最小终态协议固定为：

```text
return TOutput     → Attempt success
throw ToolError    → Attempt failure
emit(...)          → progress / warning / diagnostic（非终态）
AbortSignal        ← Runtime 发给 Tool 的取消控制
```

Attempt 进入终态后，`emit` 必须 no-op 并记 `attempt.late_emit`。Tool 不能直接修改 Lane/Effect 状态、触发 retry 或 resume，也不要求实现 `getStatus()` / `getResult()`。执行状态属于 Effect/Attempt，结果属于 ResultStore：

```ts
runtime.effects.inspect(effectId)
runtime.results.get(resultRef)
```

普通 Tool 只需要 `execute()`；对于远程 Job、Browser Session、云任务等可能脱离当前 Node 进程继续运行的能力，可以选择实现 `RecoverableTool.reconcile()`，用于重启/断联后的状态对账与 `reconcile_required`/`in_doubt` 处理。

Manifest 的行为声明用于校验和路由，不自动授予权限。资源解析、权限约束和输出大小上限由可信 Adapter 绑定；工具传入错误 metadata 不能绕过 Host Policy。

工具要求：

- 参数命名表达业务含义；单位、范围、路径基准、正则语义用简短 JSDoc 补充。
- 所有 Tool 都必须接收并响应 `AbortSignal`。能真正中止底层操作的声明为 `cooperative`；外部系统无法保证立即撤销时声明为 `best_effort`。清理文件、连接、子进程后记录 `executionState`；若副作用无法确认则进入 `reconcile_required`/`in_doubt`，纯计算且 `sideEffectState = none` 的任务可按其执行策略释放本地槽。
- 成功通过 `return TOutput` 回报；失败抛结构化 ToolError；Runtime/Executor 转为 Attempt/Effect 事件，不依赖模糊的 `{ success: false }`。
- `progress` / `warning` / `diagnostic` 只做中间回报，不改变终态、不恢复 Lane、不用于推断操作成功。
- Tool 不拥有执行状态；查询状态/结果统一通过 Runtime 的 Effect/ResultStore API。
- 输出符合声明且有大小限制；无法 JSON 序列化的输出转成 ArtifactRef。
- Tool 输出写入 ResultStore/ArtifactStore 前必须带 record 级 Privacy Label；来源输入中有 `local_only` 时，输出不能声明更宽松标签。Tool 不能借由自报 metadata 降级隐私，缺失或冲突标签应在发布前拒绝。
- `execute()` 内允许 await，但不能直接访问和修改调度器状态。
- `resolveResources` 缺失时按 `ToolMeta.sideEffect` 默认，见第 16.1 节。

Tool Package：

```text
dist/
├── index.js
├── index.d.ts
├── tool.schema.json
└── tool.manifest.json
```

Manifest 包含 name、version、entry、types、schema、行为信息和所需权限。Node package 的 `exports` 提供 ESM 入口和类型入口。MVP 从显式配置加载包，未授权目录不自动扫描执行。

### 21.1 Schema 构建范围

从导出 input 类型生成 JSON Schema；MVP 明确支持 JSON primitives、对象、数组、字面量 enum 和带判别字段的 union。复杂泛型、函数、循环类型等无法映射时构建失败，不能生成空 schema 假装验证成功。

Schema、`.d.ts` 和 manifest 由同一构建产物关联并附版本/hash，避免工具升级后模型看到的类型与实际验证器不一致。

先实现受限类型生成器；`.d.ts` AST 压缩和动态工具检索以后再做。不以极限压缩牺牲模型理解所需的约束与示例。

## 22. LLM 执行、ModelRouter 与 Runtime Control Action

LLM 是普通 Effect 类型。真实模型 API 统一由 ModelEffectExecutor 通过 Provider Adapter 调用，Lane、ContextBuilder、ModelRouter 和事件回调都不能直接调用模型。供应商差异留在 Adapter，不渗透 Lane 状态机。Adapter **只**产出 `LLMResult`，不产出 RuntimeAction。

多个 Lane 同时产生 LLMEffect 时，它们进入同一个 EffectQueue，并复用 Lane/Effect 的 effective priority、aging、依赖优先级继承和 provider 并发限制。不存在独立的“LLM Lane 调度规则”；谁先获得 LLM 槽由统一 Scheduler 决定。

模型上下文包含：共享策略、Lane 目标、快照摘要、显式依赖结果、相关历史和当前允许的 Tool/Control Action。MVP 由 Host 显式选择工具集合；不一次注入整个注册表。

### 22.1 每次 LLMEffect 描述任务与能力

```ts
type LLMTaskType =
  | 'plan' | 'reason' | 'summarize' | 'extract' | 'classify'
  | 'merge' | 'verify' | 'tool_select' | 'format'

interface LLMRequirements {
  reasoning?: 'low' | 'medium' | 'high'
  contextSize?: number         // 所需最小上下文窗口，单位 token
  maxOutputTokens?: number     // 单次响应上限，同时用于窗口预留
  toolCalling?: boolean        // true 表示必须支持原生 tool calling
  structuredOutput?: {
    schema: JsonSchema         // 候选模型必须能返回并满足该结构
  }
  latency?: 'low' | 'normal'    // 软偏好，不是 SLA
  cost?: 'low' | 'normal'       // 软偏好，不是任务总费用预算
  privacy?: 'local_only' | 'cloud_allowed'
}

interface LLMExecutionPolicy {
  duplicateExecutionPolicy: 'allow' | 'forbid'
  maxUnknownAttempts: number
}

interface LLMEffectInput {
  task: LLMTaskType
  requirements?: LLMRequirements
  context: LLMContextSpec
  outputSchema?: JsonSchema
  executionPolicy?: LLMExecutionPolicy
}
```

`JsonSchema` 是受 Runtime 支持子集约束的 JSON Schema 文档；无法构建或验证的 schema 在提交前拒绝。`requirements.structuredOutput.schema` 描述路由所需能力，`outputSchema` 是本次 Effect 的最终输出契约；两者同时存在时必须等价（以规范化 schema hash 判断），不能让 Router 选择了满足一个 schema 的模型，却用另一个 schema 验证结果。

实际所需容量由投影、候选 Adapter 的 token 计数/保守估计及输出预留共同校验，不能只信任模型填写的 `contextSize`。没有声明输出上限时使用 Host 默认值；Provider 的额外窗口约束由 Adapter 校验。

有效要求由 Host Policy、Agent/Lane 默认 Model Policy、本次 Effect 要求以及 `minReasoningFloor(interventionLevel)` 组合，不能放宽上层限制。`requirements.privacy` 只是调用方的上界/偏好，ContextBuilder 计算出的数据级 `context.privacy` 才是外发判定的事实来源；数据标签更严格时必须优先。`cloud_allowed` 是在 Host 已允许外发前提下的选择范围，不能覆盖 `local_only`；未声明 privacy 时继承 Host 默认策略。能力、隐私和窗口是硬筛选条件，成本、延迟与缓存只是合规候选之间的排序偏好。

Agent/Lane 可以声明默认模型策略，但不保存 `lane.model = 'xxx'` 作为固定绑定。同一 Lane 的 summarize、reason、format 可以分别使用本地小模型、强推理模型和低成本模型。改变模型不创建新 Lane 或新 Agent。

### 22.2 ModelRegistry 与任务路由

ModelRegistry 统一登记本地与云端模型：modelId、providerId、Adapter、执行位置、上下文窗口、能力声明和配置版本。凭证保留在 Host/Adapter 安全配置中，不写入 Effect input 或日志。`local:` / `cloud:` 只是示例命名，实际执行位置与能力必须由可信注册配置确定。

ModelRouter 按任务与要求返回有序候选及原因，不占资源、不改变 Lane 优先级、不发起网络请求。默认策略建议如下，实际质量必须用任务样本验证：

| 任务 | 候选偏好 |
| --- | --- |
| plan / reason / verify | 能力满足要求的推理模型 |
| merge 且 reasoning=high | 能处理关键综合判断的模型 |
| summarize / extract / classify / format | 能力足够的本地或低成本模型 |
| tool_select | 满足工具选择与输出契约的模型 |
| 任意任务且 local_only | 仅可信注册为本地执行的合规候选 |

配置草案中的 ID 是占位符，不表示已有模型接入或性能结论：

```ts
router.register({
  task: 'summarize',
  candidates: ['local:small', 'cloud:standard'],
})
router.register({
  task: 'reason',
  candidates: ['cloud:reasoning-primary', 'cloud:reasoning-backup'],
})
router.register({
  task: 'verify',
  candidates: ['cloud:reasoning-primary'],
})
```

MVP 使用显式候选顺序、能力/隐私/窗口过滤和受控 fallback。以后可加入任务质量、输入 token、有效优先级、队列压力、可用性、延迟、价格、缓存统计与历史成功率等排序信号。队列压力和 provider 槽占用来自 Scheduler 的只读视图；Router 不能自行修改额度或建立另一套公平性规则。无法匹配时返回 `NO_ELIGIBLE_MODEL`，不能通过降低隐私要求自动兜底。

### 22.3 Scheduler、准备阶段与执行边界

Scheduler 决定何时派发、原子取得资源并创建 Attempt；ModelRouter 决定合规候选及其顺序；ModelEffectExecutor 执行已选定的单次 Attempt。为避免“先占 provider 槽却尚未选 provider”的歧义，固定以下流程：

```text
Lane 同步 Step → submit LLMEffect + Wait → Lane waiting
→ EffectQueue（固定 ContextSpec）
→ 仅当 lookahead 窗口内（已准备数 < maxPreparedLLMs）才启动准备
→ 有界异步准备：ContextBuilder → 候选过滤 → Adapter 请求容量校验
→ 准备完成事件交回 Runtime（仍为 queued，preparation.state = prepared）
→ Scheduler 按 effective priority + aging 选择具备派发条件的 Effect
→ ModelRouter 按当前策略确认候选（含 minReasoningFloor）
→ 原子取得 Runtime LLM 槽 + provider/model 槽 + 必要资源
→ 创建 Attempt，绑定 modelId/providerId/输入 hash
→ ModelEffectExecutor → Provider Adapter → 真实模型 API
→ Provider 原始响应由 Adapter 归一化为 LLMResult（生成 Pulse toolCallId）
→ ModelEffectExecutor 按 outputSchema 校验 structured
→ Attempt 结果进入 FactInbox
→ Transition Engine 发布逻辑 Outcome / ResultRef、解析依赖
→ Lane ready → Scheduler → 下一同步 Step 由 Action Decoder 处理模型输出
```

准备阶段属于该 LLMEffect 的内部工作，不新增 Lane 状态，也不算已发出模型请求的 Attempt。它有独立的有界工作额度（`maxPreparingLLMs`）、已准备上限（`maxPreparedLLMs`）、取消与 deadline 控制；完成后只提交准备结果，不能直接唤醒业务 Lane。大文件读取不能在 Scheduler tick 中同步执行。准备失败按结构化 Effect 错误处理，取消后的迟到准备结果不得派发。`preparation.generation` 防止重建前的迟到结果覆盖新投影。

取消在途准备时设置 `cancelRequested`，确认停止后才释放准备额度并终结；未占用的模型执行槽无需释放。

派发前重新检查权限、取消、deadline 和候选配置版本；策略收紧后必须重新过滤，不能继续发送旧的越权请求。如果当前策略要求改变请求中的指令、工具集合或证据内容，原 Effect 以 `POLICY_CHANGED` 失败，由 Lane 在新策略下显式提交新 Effect，不在原 Effect 内改写语义输入。仅因排队或 Global Context 更新，不重建业务输入。已准备的候选若配置失效且需要异步处理，可基于固定输入重新准备 Adapter 格式与容量校验，不占模型执行槽等待。

没有空闲槽时继续 queued，且不持有部分资源；释放/可用性事件再触发调度。策略允许时可选择另一个合规且有槽的候选，这是派发前选择，不是失败重试；尚未发出的候选不计 Attempt。实际 fallback 请求必须重新进入统一 EffectQueue，不能由 Executor 私自串行调用备用模型。

### 22.4 无状态请求与 Provider 会话

MVP 完全依赖 Pulse 保存的 ContextSpec、`LLMResult` 和工具调用关联，使用无状态请求。每次请求显式携带必要上下文，切换模型时不需要迁移 Provider 历史。模型响应结束后释放临时 Request Context；只有经校验的 `LLMResult`、Action、Finding、Decision 或 ContextDelta 才能影响 Pulse 状态。工具调用继续依赖 Pulse 的 `toolCallId / ResultRef`，不依赖 Provider 会话。

后续 Provider Conversation/Thread/previous-response 能力只能作为 Adapter 优化。它天然对应第 15.9 节的 Lane `history`：一条 Lane 的 append-only 历史就是一条 Provider 会话可以承载的内容，`compact_history` 对应重开会话。至少按 Lane 隔离，并绑定实际模型、工具/策略版本和上下文分支；不能让整个 Agent 的不同 Lane 共享一个可变 Provider Thread。切换模型、分支或优化状态失效时，应能从 Pulse 状态重建无状态请求；若无法保证等价输入，就禁用该优化。Session 和恢复的状态真源始终在 Pulse。

### 22.5 Model Fallback 复用 Effect / Attempt

```text
LLMEffect #100（同一任务、同一固定语义输入）
├─ Attempt #1 → Model A → 可重试失败，确认停止
├─ retry_wait → 统一 EffectQueue / 路由与并发准入
└─ Attempt #2 → Model B → succeeded → 发布一次逻辑结果
```

Fallback 受第 18 节 RetryPolicy 的同一 maxAttempts、退避、deadline、取消与 Runtime Limits 约束，不能为每个候选再分配一套无限重试次数。LLM 默认 `maxAttempts` 等于当前合规候选数，见第 18 节。所有候选都必须重新通过隐私、能力、窗口和工具权限过滤；本地模型不可用时，`local_only` 请求不能转云端。

超时、过载或不可用只有在错误可重试、本地清理完成且策略允许时才能 fallback；纯 LLM 的远端未知按 `duplicateExecutionPolicy` 和 `maxUnknownAttempts` 处理，副作用未知才进入 `reconcile_required`/`in_doubt` 并等待对账。取消、权限拒绝、无合规候选不能靠换模型绕过。

同一 Effect 的重试不纳入新到达的结果，不改变指令和工具集合；各 Adapter 可以转换消息/schema 格式，但须保持相同语义输入与输出契约。每个实际请求记录新的 attemptId、所选模型、路由原因及 usage；所有失败尝试的费用也属于该 Effect。切换模型不保证输出相同，日志重放使用已记录结果。

### 22.6 Usage、缓存与路由观测

Provider Adapter 尽可能回报以下单次 Attempt 指标；不支持的值保持缺失，不能记作零或猜测命中：

```ts
interface ModelUsage {
  inputTokens?: number
  outputTokens?: number
  cachedInputTokens?: number
  uncachedInputTokens?: number
  latencyMs: number
  cost?: {
    amount: number
    currency: string
    source: 'reported' | 'estimated'
    pricingVersion?: string
  }
}
```

仅在 Provider 指标定义可对应时推导 `uncachedInputTokens` 或 token 口径的 `cacheHitRatio = cachedInputTokens / inputTokens`；分母为零时不计算。跨请求汇总用兼容口径的 token 总量加权。cacheSavedTokens 必须注明复用 token 的口径，cacheSavedCost 只有在已知价格与无缓存对照成本时才能估算，不能把 cached token 数直接当成确定的费用节省。

Runtime 按 Session/Agent/Lane/Effect/Attempt 关联 provider、model、投影 hash、路由配置版本、候选排除原因、fallback 原因、usage 和缓存指标。指标可供后续动态路由使用，观测回调不能修改调度状态或触发额外模型请求。

### 22.7 Provider 输出分层校验与 Runtime Control Action

输出校验分三层，不得混用：

1. **Adapter**：只把供应商响应归一化为 `LLMResult`。`finishReason` / 字段组合非法 → Attempt 失败 `PROVIDER_RESPONSE_INVALID`。Adapter 不产生 RuntimeAction，也不执行工具。
2. **ModelEffectExecutor**：用 `outputSchema` 校验 `structured`。失败 → Attempt 失败 `OUTPUT_SCHEMA_VIOLATION`（retryable，计入 maxAttempts，允许 fallback），**不发布业务 ResultRef**，Lane 不会把这份非法 structured 当成成功业务输出。被拒的原始文本以 `kind: 'rejected_output'` 的观测记录保存在 ResultStore（有自己的 ResultRef，继承本次请求的 `privacy` 与 `privacyRefs`，不进入 Lane `history`，不参与依赖解析）；Effect 最终失败时 Outcome 携带 `rejectedOutputRefs`，供 Program 显式提交一个带纠错反馈的新 LLMEffect 引用它。纠错是新的 Effect、新的 ContextSpec，不是同一 Effect 的 Attempt 重试。
3. **Lane Step / Action Decoder**：读取已发布的 ResultRef，解码为 `LaneStepOutput`。语义、权限、Admission 失败 → `control_error`，Effect 终态不变。

```ts
interface LLMResult {
  text?: string

  toolCalls?: {
    id: string
    name: string
    arguments: JsonValue
  }[]

  structured?: JsonValue

  finishReason:
    | 'stop'
    | 'tool_call'
    | 'length'
    | 'refusal'
    | 'error'

  refusal?: {
    reason?: string
    message?: string
  }

  usage?: ModelUsage
  privacy: PrivacyLabel
  derivedFrom?: DataRef[]
}
```

`LLMResult.toolCalls[].id` 必须由 Pulse 在归一化阶段生成并登记；Provider 原生 call ID 只能留在 Adapter 的临时映射中，不能作为跨 Attempt、换模型或恢复时的关联键。Adapter 可以填充来源标签，但 Runtime 必须根据本次 LLMContext 的 `privacyRefs` 和实际输入重新校验，不能接受更宽松的结果标签。`finishReason` 与字段组合要经过统一校验：`tool_call` 至少有一个工具调用，`refusal` 必须带 `refusal` 或可解释错误，`stop`/`length` 不得伪造工具调用；供应商无法映射时返回 `error`。

由 LLM 调用产生的 `ToolEffectInput` 也携带 `privacy` 与 `derivedFrom`；工具参数、工具输出和后续 ResultRecord 按同一严格传播规则校验，不能因为模型把敏感值放进工具参数就绕过 ContextBuilder 的标签检查。

归一化且通过第 2 层 schema 校验的 `LLMResult` 作为带 PrivacyMetadata 的不可变 `ResultRecord` 写入 ResultStore，LLMEffect 的 Outcome 只发布对应 `ResultRef`。Action Decoder 在 Lane 的下一次同步 Step 中读取该 ResultRef，生成 `LaneStepOutput`；解析出 `toolCalls` 不等于已经执行工具，仍必须经过 StepTransaction 的 schema、权限、资源和原子提交流程。

支持原生 tool calling 的供应商由 Adapter 生成其所需 schema；`.d.ts` 可以作为紧凑说明，但不是要求供应商直接执行 TypeScript。其他供应商也必须产出同一个 `LLMResult`。

工具调用的关联链固定为：

```text
LLMResult.toolCalls[].id             // Pulse 生成的 toolCallId
↓
Action Decoder / StepTransaction     // Lane 的下一次同步 Step，不是 Adapter
↓
ToolEffectInput { toolCallId, toolName, arguments }
↓
ToolEffect / EffectRecord.toolCallId
↓
ResultStore 发布不可变 ResultRef
↓
ToolCallCorrelation { toolCallId, toolEffectId, resultRef }
```

工具结果消费时，Lane 只通过 `toolCallId` 和 `ResultRef` 读取对应结果；下一轮切换模型时仍沿用这两个 Pulse 标识，不读取或重建 Provider Thread。一个 `toolCallId` 只能绑定一个逻辑 ToolEffect；重试保留 `toolCallId` 和 `effectId`，只更换 `attemptId`。重复、未知或跨 Agent scope 的 `toolCallId` 在 StepTransaction 中拒绝。

chunk 仅用于展示和观测。MVP 等完整响应、结构验证和权限检查通过后才接受 tool call 或控制动作，不执行尚未闭合的流式参数。

Runtime Control Action 以独立命名空间暴露：

```text
pulse.fork
pulse.wait
pulse.join
pulse.complete
pulse.cancel_lane
pulse.propose_cancel
pulse.downgrade_privacy
```

它们进入命令验证和状态事务，不作为普通 Tool Effect 递归执行。`pulse.downgrade_privacy` 只登记经验证的人工批准或可信 Sanitizer 证明，并要求产生新的派生 Result/Artifact/Finding；它不能原地改写 `local_only` 来源。模型不能随意指定已有资源 ID 或超出本 Agent scope 的目标。`pulse.cancel_lane` 只能指向当前 Lane 的自有后代；对 sibling 只能 `pulse.propose_cancel`。计划或优先级建议超出策略时返回可处理的错误。

LLM 返回的是未可信的 Control Proposal，而不是已经生效的 RuntimeAction：

```text
LLM Response
→ Adapter 归一化为 LLMResult          # 第 1 层
→ ModelEffectExecutor schema 校验     # 第 2 层，失败则 Attempt 失败
→ ResultRef 发布
→ 下一同步 Step：Action Decoder
→ Schema Validation
→ Policy / Admission Controller
→ Validated RuntimeAction
→ validate → Mutation[] → apply
```

Action Decoder 的目标产物是完整的 `LaneStepOutput`，而不是一条孤立 Action。一次模型响应可以同时提出认知更新、剪枝提案和后续 Effect：

```ts
{
  contextDelta: {
    target: 'lane',
    baseVersion: 7,
    sourceLaneId: 'analyze',
    ops: [
      { op: 'append', path: ['findings'], value: 'AuthStore 初始化存在竞态' },
    ],
    privacy: 'local_only',
    derivedFrom: [{ kind: 'result', ref: 'result:auth-search' }],
    resultRefs: ['result:auth-search'],
    proposal: true,
  },
  actions: [
    { type: 'propose_cancel', laneId: 'B', reason: 'SUPERSEDED' },
    { type: 'submit_effects', effects: [...], wait: { onUnsatisfied: 'resume_with_error' } },
  ],
  next: { programId: 'coding.main', programVersion: '1', step: 'await-results', locals: {} },
}
```

Runtime 必须把这三部分作为一个 StepTransaction 验证和提交。`ContextDelta` 不负责执行 `pulse.cancel_lane`；它只携带待合并的认知变化。所有 Action 通过后才写入 Context、Lane/Effect/Wait 状态和事件，随后才派发新 Effect；任何一项失败都只产生 `control_error`（携带 original），不留下部分更新。

模型一次返回多个工具调用时，Action Decoder 转成一个批量 Effect Action；若响应混合 Fork、Complete 与工具调用等冲突动作，MVP 拒绝并要求修正，不猜测其执行顺序。

## 23. API 使用草案与完整执行示例

以下是目标 SDK 用法；当前文档不代表这些 API 已实现。`codingPrograms`、`primaryModel` 和工具注册项由应用显式提供；`primaryModel` 是 modelId 为 `cloud:reasoning-primary`、绑定真实 Provider Adapter 与能力声明的注册项，workspacePolicy 必须允许本例数据外发。

```ts
const runtime = new PulseRuntime({
  scheduler: {
    maxLaneStepsPerTick: 32,
    maxTickMs: 5,
    agingIntervalMs: 1000,
    maxTotalLanes: 64,
    maxActiveLanesPerAgent: 64,
    maxQueuedEffects: 256,
    maxRunningTools: 16,
    maxRunningLLMs: 4,
    maxPreparingLLMs: 4,
    maxPreparedLLMs: 8,
    maxConsecutiveControlErrors: 2,
  },
  storage: new InMemoryStorage(),
})

runtime.programs.register(codingPrograms)
runtime.models.register(primaryModel)
const tasks: LLMTaskType[] = [
  'plan', 'reason', 'summarize', 'extract', 'classify',
  'merge', 'verify', 'tool_select', 'format',
]
for (const task of tasks) {
  runtime.modelRouter.register({
    task,
    candidates: ['cloud:reasoning-primary'],
  })
}
runtime.tools.register(searchCode)
runtime.tools.register(readFile)
runtime.tools.register(applyPatch)
runtime.tools.register(runTests)

const agent = runtime.createAgent({
  goal: '定位并修复登录偶发失败的问题',
  program: {
    programId: 'coding.main',
    programVersion: '1',
    step: 'plan',
    locals: {},
  },
  priority: 'high',
  policy: workspacePolicy,
  limits: { timeoutMs: 600_000, maxActiveLanes: 64 },
})

const outcome = await runtime.run(agent.id)
```

`await runtime.run()` 是 Host 等待整个 Agent 收尾，Runtime 内部仍按事件推进。即使 Outcome 带 `unresolvedEffectIds`，`run()` 也必须返回；quarantine 继续可 `inspect`。`requestCancel()`、`setLanePriority()`、`inspectLane()` 属于 Host 命令：前两者入 FactInbox，所有变更仍通过校验和事件记录。

Human-in-loop 不需要第二套执行模型。`HumanEffect` 创建后 Lane waiting，Host/UI 只需在用户响应时提交对应的完成/取消事件。Child Agent 同理通过 `AgentEffect` 启动；主 Agent 与 Child Agent 使用相同 Runtime，只在策略上限制 Child Agent 不再递归创建更深层 Agent。

root Lane 的 plan Step 先提交 `task: 'plan'` 的 LLMEffect；收到模型结果后的同步 Step 经校验创建以下 Fork（省略各 Lane 的 program 配置）：

| key | 工作 | 声明优先级 | 启动依赖 |
| --- | --- | --- | --- |
| analyze | 分析登录请求和错误记录 | normal | 无 |
| tests | 准备可复现用例或测试方案 | normal | 无 |
| fix | 生成并应用修复补丁 | urgent | analyze success |
| verify | 验证补丁与复现用例 | high | fix success、tests success |

```text
                  Main
                    │ fork，随后 join(all, settled)
            ┌───────┴────────┐
            ▼                ▼
         analyze           tests
            │ success        │ success
            ▼                │
           fix               │
            │ success        │
            └────────┬───────┘
                     ▼
                   verify
                     │
              Main 汇总所有 Outcome
```

实际推进：

1. analyze、tests 有执行资格；fix、verify 处于 waiting，不消耗 LLM 并发槽。
2. urgent 的 fix 向 analyze 传递优先级；analyze 的 **queued** Effect 同样获得继承。
3. analyze 发布结果后，fix 的启动输入收到该结果，不必等待 tests。
4. fix 通过独占 workspace 的写工具应用补丁；tests 若写测试文件，也需同一资源锁并检查基线，不能依赖上下文快照解决写冲突。锁等待队列按分数排序，不向已 running 的持锁者传分。
5. fix 和 tests 成功后，verify 收到两份结果，执行测试并发布结果。
6. Main 的 settled Join 汇总所有 Outcome；如果上游失败，success 依赖的下游按规则失败，不永远等待，也不执行缺少前提的验证。若某条调查 Lane 被 owner 以 SUPERSEDED 取消，settled Join 仍能汇总。
7. Main 生成最终说明。`complete` 默认 `reject_if_active`，因此必须先 Join；需要砍掉剩余子任务时显式 `children: 'cancel'`。所属资源收尾或移交 quarantine 后结束 Agent。

该示例只有一个真实模型也能走完整 Router 路径。增加本地与低成本 Adapter 后，可以在不修改 Lane/Wait 语义的情况下按任务配置多个候选：

| 执行位置 | LLM 任务与显式输入 | 路由意图 |
| --- | --- | --- |
| Main 规划 | plan；目标、策略与工具集合 | 满足规划要求的推理模型 |
| analyze 搜索后 | summarize；多个已完成搜索 ResultRef | 合规的本地/低成本模型，生成带来源的局部 Finding |
| analyze 定位原因 | reason；固定快照与已校验 Finding | 高推理能力模型；若 local_only 则只选本地候选 |
| tests 提取复现线索 | extract；显式日志片段 | 满足结构化提取要求的模型 |
| verify 测试后 | verify；测试 Outcome 与补丁证据 | 满足验证要求的模型，不能把模型判断当成测试通过 |
| Main Join 后 | merge，reasoning=high；各 Lane 的 Outcome/Finding | 综合结论通过 ContextMerger 提交，再生成最终说明 |

同一 analyze Lane 可以先 summarize 再 reason。搜索的 500 条原始匹配仍在 ResultStore；其他 Lane 和 Main 只收到显式发布的引用与发现。配置多模型不会让某个 Provider Conversation 自动收集所有 Lane 历史。analyze 若要淘汰 tests，应 `propose_cancel` 给 Main，而不是直接 `cancel_lane`。

## 24. 模块与仓库结构

第一版采用少量包，按内部职责分模块；先建立接口边界，避免为每个概念建立单独 npm 包。

```text
pulse/
├── packages/
│   ├── runtime/
│   │   └── src/
│   │       ├── core/          # records、actions、events、errors、mutations
│   │       ├── transitions/   # 单写者 validate/apply
│   │       ├── scheduler/     # ready/effect 队列、TimerWheel、优先级、准入
│   │       ├── dependencies/  # waits、graph、cycle detection
│   │       ├── lifecycle/     # ownership scopes、取消、quarantine、收尾
│   │       ├── effects/       # registry、attempts、retry、timer
│   │       ├── context/       # Global/Lane snapshots、builder、projection、merge
│   │       ├── models/        # registry、router、request preparation、usage
│   │       └── storage/       # 内存存储、日志接口、导出
│   ├── tool-sdk/              # Tool/Context/Manifest、构建验证
│   └── adapters/              # 本地/云 LLM provider、缓存映射、filesystem、shell
├── examples/
│   ├── deterministic-lanes/
│   ├── parallel-tools/
│   ├── dependency-pipeline/
│   └── context-model-routing/ # 固定投影、能力/隐私过滤、受控 fallback
└── benchmarks/
```

核心采用 TypeScript、ESM，目标 Node.js 22+，实现时固定并验证具体受支持版本。RuntimeClock 可替换为虚拟时钟；ID、随机退避、Executor 可注入，便于确定性验证。CPU 工作通过 Worker 或子进程隔离。

## 25. MVP 范围与交付顺序

M1 不再一次吞下全部产品能力。内核先可收敛，再接真实模型，再补 taint / Watchdog / 存储精细化。

### M0：证明调度内核

不依赖真实 LLM，使用受控 Executor 和虚拟时钟完成：

- Lane 状态机、显式 ResumePoint、同步纯函数 Step、`actions: []` 回队尾。
- `validate → Mutation[] → apply`；`control_error` 携带 original；连续控制错误上限。
- Effect 队列与 Attempt、结果存储和事实/观测双 Inbox；Effect 类型契约覆盖 LLM/Tool/Human/ChildAgent/Timer。
- `concurrencyClass`、TimerWheel、`hasRunnableWork()`、Host 命令入 Inbox。
- Lane/Effect success、settled 依赖，`LocalRef`，单一 Wait 来源，all Wait/Join 和原子 Fork。
- `CompleteAction.children`、`onCancelled`、Join 默认 settled。
- 循环检测（隐含收尾边仅 `await`）、一次恢复、先完成后等待。
- Lane 与 Effect 优先级、aging、`agingCap`、依赖优先级继承、锁等待队列。
- 有界队列、workspace shared/exclusive 锁、`resolveResources`、并发准入。
- 结构化取消、timeout、受限 retry、执行/副作用状态分离。
- QuarantineScope：`cancelGraceMs` 后移交，`run()` 带着 `unresolvedEffectIds` 返回。
- `effect.dispatch_failed`、迟到 emit no-op、explain。

M0 是内核里程碑，不能宣称已经交付完整 Agent Runtime。

### M1：可接真实模型的 MVP

在 M0 之上交付：

- 一个真实 LLM provider adapter、filesystem/shell 工具、Timer Executor，以及最小 HumanEffect / AgentEffect Host Adapter。
- Tool SDK、Manifest、受限类型到 JSON Schema 的构建与验证。
- 模型输出 Action 校验、权限策略、工具集合注入。
- Provider Adapter 到统一 `LLMResult` 的归一化、三层输出校验、Pulse 自有 `toolCallId → ToolEffect → ResultRef` 关联。
- 结构化 `ContextDelta.ops`、ResultRef 调度输入、显式合并与路径冲突报告。
- 显式 `adopt_context(version | 'latest')`、Snapshot Rebase 冲突处理，以及 `adoptCommittedContext` 与 Global ContextDelta 的同事务提交。
- `LaneStepOutput { contextDelta?, actions, next }` 的全量校验与原子提交。
- Global/Lane/Request 三层 Context、固定版本的 ContextSpec、稳定序列化和缓存友好的请求投影；同一次 Wait 的结果合并消费。
- Lane Context 的 `history` / `state` 分段、`HistoryRecord` 归档、`history` 块进入稳定前缀、`prefixHash` 观测，以及显式 `compact_history`（含 `LaneRecord.historyPressure` 水位与 `CONTEXT_TOO_LARGE` 硬上限）。M1 的 `forkAffinity` 固定为 `off`，`advise` 的检查逻辑在 M1.5 交付后才成为默认值。
- ModelRegistry、按 LLMEffect 任务/能力/隐私路由、显式候选顺序、LLM 默认 `maxAttempts = 候选数`、静态 provider/model 并发上限与复用 Attempt 的 fallback；默认无状态请求。
- 有界异步请求准备、`maxPreparedLLMs` lookahead、窗口/输出预留校验、route explain 和 Adapter 可提供的 token/cache/费用指标；缺失指标明确标记。
- Attempt 的 `executionState` / `sideEffectState`、纯 LLM 的 `duplicateExecutionPolicy` / `maxUnknownAttempts`。
- 请求级隐私阻断：投影含 `local_only` 则云端候选不可用。
- 简单驻内存 hard cap（可不实现 pin/compact 精细策略）。
- deadline / Runtime Limits、usage 记录和清晰的错误处理。
- CLI/程序化示例、内存日志导出、完整依赖流水线演示。
- 第 26 节中标记为 M0/M1 的验收项，以及第 27 节对照基准的调度部分。

### M1.5：认知安全与进展治理

- record 级 Privacy Label 与 `derivedFrom` 传播、`downgrade_privacy`。
- Progress Watchdog 稳定指纹（含 `resumeStep` / `localsHash`）、滑动窗口、分级干预。
- `SessionStoragePolicy` 的 pin/compact、事实/观测分流、hard limit 显式失败。
- Child Agent `inheritedFloor` 与 `maxTotalLanes` 的集成验证。
- 副作用未知 Tool 的 `RecoverableTool.reconcile` 与 quarantine 对账 Host API。
- Fork 亲和检查（`forkAffinity: 'advise'`、`FORK_AFFINITY_COLLAPSIBLE`、`affinityAck`）与显式跨 Session `warmStart`（默认 `include: 'facts'`，标签与 `derivedFrom` 保留）。

### M2：可靠恢复与扩展

通过持久化事务/outbox/对账、Mutation 日志、storageState/pin 重建和 checkpoint 截断验证后再宣布 crash recovery。随后按实际需求增加高级 Join、公开 detached/background scope、更细资源锁、叶子级 taint、多 provider 自适应限流、基于质量/延迟/价格/缓存的动态路由、Provider 会话优化（映射 Lane `history`）、Admission 自动折叠亲和组（`forkAffinity: 'coalesce'`，需先解决 Join 成员 key 与单 Lane Outcome 的对应）、基于相关性的 warm start 自动筛选、Host 级费用/调用限制和动态工具检索，不预先把这些能力塞入 M1。M1 的静态并发上限与确定性路由不依赖这些扩展。

MVP 不包含：可靠崩溃恢复、持久数据库、分布式 Worker、流式部分参数执行、软依赖、any/quorum Join、对外 Detached API、自动推测执行、动态工具检索、自动 Context 压缩、学习型/自适应模型路由、Provider Thread 优化、Fork 自动折叠、隐式跨 Session 继承、跨 Wait 的通用事件合并队列、Memory/MCP/Skill 平台和 Web UI。显式 summarize Effect 与显式 `compact_history` 属于普通业务流程，不等于自动压缩平台。HumanEffect 与 AgentEffect 属于核心 Effect 契约；第一版可以只提供最小 Host API，不要求审批 UI 或复杂 Multi-Agent 编排产品。

M1 至少接通一个真实模型 Adapter，并用可控模型替身验证多候选选择、隐私拒绝和 fallback；若宣称本地/云端协同已可用，必须另有对应真实 Adapter 的集成验证，不能仅凭统一接口或配置示例宣称完成。

基础权限 allowlist/deny 和参数约束属于 M1；暂不做审批 UI 不代表工具默认拥有无限权限。

## 26. 验收标准

这些是需要实现并执行的验收用例，不是当前已通过的测试。括号中的里程碑表示该行最早必须在哪一阶段可测。

| 场景 | 必须观察到的结果 |
| --- | --- |
| 单 Lane 串行（M0） | 每个 Effect 完成后恢复对应 Step，最终结果正确 |
| 两 Lane 独立等待（M0） | A 等长工具时，B 可完成多轮推进 |
| Lane 启动依赖（M0） | A 成功前 B 不执行任何业务 Step；成功后 B 收到 A 的 ResultRef |
| all 等待（M0） | 所有 success 条件满足后只恢复一次 |
| success 上游失败（M0） | 下游失败或进入错误处理，不永久 waiting |
| settled 上游失败/取消（M0） | 消费者收到真实 Outcome，可正常汇总 |
| `onCancelled: ignore`（M0） | SUPERSEDED 的成员不使 settled/success Wait 失败 |
| 上游先完成（M0） | 后注册 Wait 立即判断，不丢失唤醒 |
| LocalRef 同批等待（M0） | 同一 Step 提交 Effect 并 Wait，校验通过后只创建一次 |
| 多 Wait 来源（M0） | `submit_effects.wait` + `fork.join` 被拒绝，`MULTIPLE_WAIT_SOURCES` |
| 重复或迟到事件（M0） | 不重复恢复，不覆盖终态；过期 Attempt 单独记录 |
| 依赖闭环（M0） | 自依赖、sibling 环、子等祖先、动态新增环均被原子拒绝 |
| 隐含收尾边（M0） | 仅 `children: 'await'` 参与死锁校验；`cancel` / `reject_if_active` 不误拒 |
| Fork 部分参数非法（M0） | 不留下部分创建的 Lane 或已启动的工具 |
| 不同优先级（M0） | 有执行资格的高分 Lane/Effect 优先，同分按 enqueueSeq |
| 防饥饿（M0） | 持续插入新高优先级工作时，有资源资格的旧低优先级工作能获得派发 |
| 优先级继承（M0） | 消费者提升 **queued** 上游及 Effect，等待解除后撤销提升；不影响 running |
| 不可抢占运行（M0） | 提权不强行中断在途请求，不绕过依赖和锁 |
| shared/exclusive 锁（M0） | 写与读写不重叠；锁等待队列按分数排序；等待写者受 `writerPreferenceBound` 保护 |
| 并发与背压（M0） | 任意时刻不超过槽位上限，队列满时整批拒绝，无空转调度 |
| Human/Timer 不占槽（M0） | 多个 HumanEffect 同时 waiting 不占用 `maxRunningTools` / `maxQueuedEffects` |
| 取消传播（M0） | 自有子任务被取消，共享依赖不被误取消，资源确认停止或 quarantine 后才释放给业务 Lane |
| sibling 不能互砍（M0） | 非 owner 的 `cancel_lane` 被拒绝；`propose_cancel` 到达 owner 的 `control_proposal` |
| 完成/取消竞争（M0） | 结果只提交一次，迟到成功不能恢复 cancelling Lane |
| 执行/副作用状态（M0） | Attempt 分别记录 `executionState` 与 `sideEffectState`；纯 LLM 的 `remote_unknown + none` 可释放模型槽，写副作用未知进入 `reconcile_required`/`in_doubt` |
| cleanup 未确认（M0） | 副作用未知时保留资源隔离，不自动重复写入；纯计算远端未知不误占用 LLM 槽 |
| Quarantine 出口（M0） | `cancelGraceMs` 后 Lane/Agent 进入终态并带 `unresolvedEffectIds`；`run()` 返回；inspect 可见 quarantine |
| 重试（M0） | attemptId 改变、effectId 不变，退避不占槽，走 TimerWheel，消费者只见最终结果 |
| dispatch_failed（M0） | Executor 同步抛错产生 Attempt 失败，不留下无事件的半派发 |
| deadline / Runtime Limit（M0） | 不再启动被拒绝的新工作，取消/失败收尾有记录，不能静默越过限制 |
| Host 命令不重入（M0） | drain 中的 `requestCancel` 只入队，结束后才 apply |
| 空转判定（M0） | 无 ready / 无事实 Inbox / 无 due timer / 无可派发 Effect 时不 `setImmediate` |
| actions 空回队尾（M0） | 纯逻辑 Step 不在同一 tick 连跑满额 |
| Context 冲突（M1） | Lane 快照稳定、结果显式传递，同路径 merge 冲突被报告 |
| Snapshot 固定（M1） | Global v2 发布后未显式 Adopt 的 Lane 仍读取 v1；已提交的 LLM Request 不被改写 |
| 显式 Adopt（M1） | `adopt_context(v2/latest)` 只在原子提交成功后更新当前 Lane 的 snapshot，下一 Step 才读取新版本 |
| 同事务 Adopt（M1） | 当前 Lane 的 Global ContextDelta 与 `adoptCommittedContext: true` 同时提交时，Global 新版本与当前 Lane snapshot 一致可见；其他 Lane 不漂移 |
| Rebase 冲突（M1） | Adopt 目标版本不可见、过期或与局部 ops 冲突时整体拒绝，返回 `control_error`，不静默覆盖 Context |
| Fork 快照（M1） | 默认继承 parent snapshot；`latest` 在提交时固定 |
| Tool Schema（M1） | 非法输入在执行前拒绝，不支持的类型在构建时失败 |
| 事件循环公平性（M0） | 大量 ready Lane 和 progress 事件下，IO、取消、定时器仍被处理 |
| Agent 结束（M0） | root 结果与所属 scope 收尾一致；未确认 Effect 在 quarantine 中，无遗留未托管执行 |
| Storage Policy 维度（M1.5） | 驻内存上限与逻辑保留分离；事实事件逻辑上不因落盘删除；`maxEventLogBytes` 是内存上限 |
| Storage Pin（M1.5） | 活动 Lane、LLM Request、Wait、未消费输入和 ResultRef 引用对象的 `pinCount` 正确增减；被 pin 对象不能被 compact/淘汰 |
| Storage Pressure（M1.5） | 达到内存水位时优先持久化或 compact unpinned Result/观测事件/Snapshot，内存保留索引与 metadata |
| Storage Hard Limit（M1.5） | 持久化不可用且所有可用数据均被 pin 时，超过 hard limit 返回 `SESSION_STORAGE_LIMIT_EXCEEDED`，不提交半个事务、不无限增长、不静默淘汰活动引用 |
| Event Retention（M1.5） | 事实事件逻辑保留；progress、LLM chunk、scheduler trace 可 compact，且 compact 不改变状态重放所需事实 |
| Snapshot Retention（M1.5） | 保留最新 Snapshot 与被 Lane/活动 Request 引用的旧版本，其余旧版本落盘并保留索引；Adopt/Rebase 引用不会因内存回收失效 |
| Progress Fingerprint（M1.5） | 每轮生成稳定指纹，含 `resumeStep`/`localsHash`；随机 ID、timestamp、telemetry 和 Provider ID 不造成假进展；纯逻辑步进不算无进展 |
| Loop Detection（M1.5） | 重复 `search("AuthStore")` 得到规范化等价 Result、Context/Finding 与 Goal 均未变化时累计 `noProgressCount`；新 Event/seq 单独变化不能清零 |
| Progress Intervention（M1.5） | 阈值 1：`control_error`；阈值 2：Program replan + Router `minReasoningFloor`；阈值 3：fail Lane。Runtime 不改写已提交 Effect 输入 |
| Progress Admission（M1.5） | Watchdog 在 validate 阶段拦截重复 Action；被拒事务不进窗口；阈值触发时不派发重复 Tool/LLM |
| Legitimate Wait（M1.5） | 正常 Wait、资源等待、合法重试或产生实质 Context/Finding/Goal/路径/ResumePoint 变化不会被误判为无进展 |
| Step 同步边界（M0） | LaneProgram.step 不执行外部 await，且不读 `Date.now()`；时钟由 `now` 注入 |
| StepTransaction 原子提交（M0） | validate 通过后 apply 一次提交；Context、Lane、Effect、Cancel Intent、ResumePoint 与 Events 一致可见 |
| StepTransaction 全部拒绝（M0） | 任一校验失败时不 apply；当前 Lane 收到带 original 的 `control_error` |
| 控制错误循环（M0） | 同一非法输出连续拒绝达到上限后 `CONTROL_ERROR_LOOP` 失败 Lane |
| 两阶段 Mutation（M0） | apply 路径无 IO/无校验；validate 抛错或拒绝都不留下半状态 |
| 多 Action 一致性（M0） | 同一 Step 可同时提交 ContextDelta、`cancel_lane`（后代）与 `submit_effects`；三者任一失败则整体拒绝，提交后才派发 Effect |
| ContextDelta 纯数据（M1） | ContextDelta 不能隐式触发取消或工具调用；`ops` 可做路径冲突检测 |
| 终结动作冲突（M0） | `complete`/`fail` 与其他会继续执行的 Action 组合被明确拒绝，不猜测执行顺序 |
| complete 子任务（M0） | 默认 `reject_if_active`；`cancel` 砍子任务；`await` 进入 closing |
| Fork Admission（M1） | LLM 只能提出 Proposal；非法/超限 Fork 原子拒绝，不部分创建 Lane |
| Lane 剪枝（M0） | owner 可将后代以 SUPERSEDED 取消；运行中 Effect 正确 Abort；局部 Context 不自动合并 |
| Result 调度（M1） | 原始结果先进入 ResultStore/FactInbox/ReadyQueue，未被 Scheduler 选中的 Lane 不同步调用 LLM |
| Result 消化（M1） | LLM 消化 ResultRef 后才提交 Finding/ContextDelta，原始大输出不自动写入 GlobalContext |
| Tool 回报（M0） | return/ToolError/emit/AbortSignal 分别对应成功/失败/中间回报/取消控制；终态后 emit 为 no-op |
| HumanEffect（M0） | 用户响应作为完成事件恢复等待 Lane，不需要特殊同步阻塞路径 |
| AgentEffect（M0/M1） | Child Agent 与主 Agent 使用同一执行模型，深度限制生效；父等待期间 child 获得 inheritedFloor |
| Session 状态所有权（M1） | 禁用 Provider Thread 后仍能构建完整请求；messages 由 Pulse 状态投影，不成为第二状态源 |
| 三层 Context 隔离（M1） | Lane A 的未合并历史不进入 B；Global 更新不暗改已有 Lane 快照；Request 不整体写回 Context |
| Result Coalescing（M1） | all Wait 的多个结果只恢复一次，可进入一个 LLMEffect；未满足依赖不提前唤醒 |
| 固定请求输入（M1） | 排队和重试期间到达的新结果不改变当前 ContextSpec；fallback 保持相同语义输入与来源引用 |
| ContextBuilder（M1） | 相同输入和版本产生相同块顺序/hash；缺失、越权引用显式失败；大结果保留可追溯范围 |
| Privacy Label 传播（M1.5） | record 级标签齐全；多来源派生取最严格值并保留 `derivedFrom`，缺失标签拒绝提交 |
| local_only 摘要（M1.5） | local_only 输入经本地模型摘要后仍为 local_only |
| 云端隐私阻断（M1） | ContextBuilder 重算投影标签；包含 local_only 时云端候选被阻断 |
| 显式隐私降级（M1.5） | 只有带人工批准或可信 Sanitizer 证明的 `downgrade_privacy` 能生成 cloud_allowed 派生对象 |
| public vs cloud_allowed（M1.5） | public 可导出/给 Child Agent；cloud_allowed 默认可上云但不可无脱敏导出 |
| 异步准备（M1） | Artifact 读取不阻塞 tick；`maxPreparingLLMs` 与 `maxPreparedLLMs` 生效；取消后迟到结果不能派发 |
| 稳定前缀（M1） | 同输入不因随机 ID/telemetry 改变前缀；缓存不可用时语义不变 |
| Lane 历史前缀（M1） | 同一 Lane 连续两次 LLMEffect，后一次 `history` 块 = 前一次 `history` 块 + 前一轮归档记录，逐字节一致；`prefixHash` 仅在 compact 或 Global 快照切换时变化 |
| history 不可改写（M1） | `set` / `remove` 命中 `['history', ...]` 路径被 validate 拒绝；`compact_history` 的 `upToSeq` 越界被拒绝 |
| 显式 compact（M1） | `historyPressure` 超过 soft 水位后 Program 提交 summarize + `compact_history`；compact 后 `history = [summary] + 余下记录`，摘要标签为被压缩记录中的最严格标签；超过 `hardTokens` 未 compact 返回 `CONTEXT_TOO_LARGE`，不自动裁剪 |
| Fork 亲和建议（M1.5） | 资源 `exclusive` 重叠的 Fork 首次被 `FORK_AFFINITY_COLLAPSIBLE` 拒绝且不计入 `consecutiveControlErrors`；带 `affinityAck: true` 重提通过；`forkAffinity: 'off'` 时不检查 |
| 显式 warm start（M1.5） | 新 Agent 的 Global v0 等于指定 Session 版本的副本；`local_only` 记录仍阻断云端路由；未指定 `warmStart` 时 v0 为空；旧 Session 后续变更不影响新 Agent |
| 每 Effect 路由（M1） | 同一 Lane 可对 summarize/reason 选择不同模型；均走同一队列、优先级和 Attempt 生命周期 |
| 能力与窗口（M1） | 不满足 tool calling、输出契约或窗口的模型被过滤；无合规候选返回明确错误 |
| 隐私与 fallback（M1） | local_only 的本地候选失败时不发送云端请求；策略收紧后旧投影不得越权发送 |
| 模型并发准入（M1） | Runtime/provider/model 槽原子取得；候选占满时不持有部分额度 |
| 模型 fallback（M1） | 默认 maxAttempts 覆盖候选数；effectId 不变、attemptId/model 逐次记录 |
| Adapter 不产 Action（M1） | Adapter 只返回 LLMResult；工具调用在下一同步 Step 由 Decoder 提交 |
| 输出分层（M1） | schema 失败不发布 Result；Decoder 失败走 control_error，不改写已成功 Effect |
| LLMResult 归一化（M1） | 不同 Provider 的响应都转换为统一 `LLMResult`；Provider 原生 call ID 不进入 Runtime 状态 |
| Structured Output（M1） | `outputSchema` 与 structured schema 在 Attempt 成功前可验证；不满足则 Attempt 失败 |
| Tool Call 关联（M1） | Pulse 生成 `toolCallId`，重试保持该 ID，完成后通过 ResultRef 回传 |
| Usage 与缓存指标（M1） | 所有 Attempt（含失败）纳入记录；不可得数据为缺失 |

关键不变量应通过可控事件顺序和虚拟时钟覆盖，不用真实网络延迟证明并发正确性。真实 provider、输出/schema 映射、token/cache 指标、Shell 取消和文件锁还需独立集成验证；缓存命中率不能作为内核测试的确定性前提。M2 再增加各持久化边界的故障注入、重启与副作用对账测试。

## 27. 基准与决策指标

比较相同任务、模型、输入、工具和相同 Runtime Limits 下的三种执行方式：

1. 串行 Agent Loop。
2. 单 Lane 批量并行 Tool。
3. Pulse 多 Lane 独立推进并通过依赖汇合（`forkAffinity: 'off'`，模型提出多少条就开多少条）。
4. Pulse 多 Lane + 亲和建议（`forkAffinity: 'advise'`，同系列方向折叠进同一 Lane 串行）。

先用确定性模拟任务验证调度开销，再用真实任务验证质量与费用；重复执行，报告分布与失败样本，不能只展示最快一次。

调度基准固定模型与路由配置。另设路由/Context 对照实验：在相同任务、工具、权限和 Runtime Limits 下比较单模型与多模型策略，以及逐次消费与合法的结果合并消费；分别记录质量变化。缓存实验区分冷/热请求、模型与前缀版本，不能把换模型、减少输入或缓存预热造成的收益都归因于多 Lane 调度。

Context Affinity 另设三组对照，各自只改一个变量：

- `laneHistory: 'append_only'` 对 `'rebuild'`：同一任务、同一 Lane 数，比较连续请求的前缀命中率、总 token、任务成功率和重复调查比例。这组回答“把对话连续性装进 Lane 值不值”。
- 方式 3 对方式 4：比较关键路径延迟、Lane 数、请求数、缓存命中和合并冲突。预期是方式 4 延迟更高、费用和冲突更低；哪一侧占优由任务的相关性结构决定，结果用于校准 `affinitySignals` 阈值，不用于证明某一侧永远正确。
- 有无 `warmStart`：对同系列的第二个任务，比较首请求缓存命中（区分是否在 Provider TTL 内）、重复调查比例和任务成功率；`include: 'facts'` 对 `'facts_and_findings'` 再分一层，检验陈旧 Finding 是否拖累质量。

采集指标：

- 端到端耗时、关键路径耗时、p50/p95 排队延迟。
- ready/queued/waiting 各阶段耗时，以及优先级继承原因。
- 工具/模型并发利用率、锁等待时间、事件循环响应延迟、空转 tick 次数。
- LLM 请求、token、工具调用、重试次数和可获得的费用。
- 任务成功率、结果正确性、重复调查比例、合并冲突。
- 取消完成时延、in_doubt 数量、quarantine 数量与资源清理失败。
- `remote_unknown` Attempt 数、未知 Attempt 的本地槽占用时长、按 `duplicateExecutionPolicy` 的重试/放弃次数，以及 `reconcile_required` 的等待时长。
- Context 准备耗时、投影大小、已准备投影数、一次请求消费的 ResultRef 数、Coalescing 前后请求数。
- 按 task/provider/model 的选择分布、无合规候选次数、fallback 率及其额外耗时/费用。
- Adapter 可提供的 cached/uncached input tokens、同口径加权 cacheHitRatio 与有依据的费用节省估算。
- Session 驻内存字节数、pin 数、persist/compact 次数、因 storage pressure 的等待时间和 `SESSION_STORAGE_LIMIT_EXCEEDED` 次数。
- Progress Watchdog 的指纹窗口命中率、重复 Action 比例、`noProgressCount` 分布、干预级别、replan/fallback 次数以及 `NO_PROGRESS_DETECTED` 导致的 Lane 失败数。
- `control_error` 次数、`CONTROL_ERROR_LOOP` 失败数。
- 按 Lane 的连续请求 `prefixHash` 稳定率、`history` 记录数与 token 数、`historyPressure` 超 soft 水位次数、compact 次数及每次 compact 后首请求的冷命中。
- `FORK_AFFINITY_COLLAPSIBLE` 次数、折叠后 Lane 数与 proposal Lane 数之比、`affinityAck` 比例、按信号类型的亲和组分布。
- warm start 的复制记录数与字节数、首请求 cached tokens、是否在 Provider TTL 内、与无 warm start 对照的重复调查比例差。

是否采用更多 Lane，应以可接受的质量和费用换来多少延迟改善为依据。若任务基本是串行依赖链，允许退化为单 Lane，不为并发而 Fork。同系列方向默认亲和到同一 Lane，只有测得延迟收益覆盖缓存与合并成本时才拆开。

## 28. 设计结论与实现前检查

Pulse 的执行闭环是：

```text
Host 命令 / Executor 完成 → FactInbox → wake()
Scheduler Tick
→ timers / 事实事件 / 有界观测
→ ReadyQueue 中的同步 Lane Step（纯函数，禁止外部 await）
→ 生成 ProgressFingerprint，validate Control Proposal / RuntimeAction + admission
→ Progress Watchdog 判断实质推进；必要时注入 control_error / 要求 replan / fail
→ apply(Mutation[])：Effect / Fork / Wait / ResumePoint / Events
→ EffectQueue（LLM 先按固定 ContextSpec 准备投影与模型候选）
→ Scheduler 原子取得资源 → Executor / Attempt
→ Event → 不可变 Outcome / ResultRef → Dependency resolution
→ eligible Lane / pending ResumeInput → ReadyQueue
→ priority + aging + fairness → 下一同步 Step
→ 处理结果：必要时提交新的 LLMEffect 消化原始数据
→ 模型结果经三层校验形成 Action / Finding / ContextDelta
→ 显式 Context Commit 或下一轮执行
无法确认停止的 Effect → QuarantineScope，Lane/Agent 仍可终态
```

本版明确了以下必须一起实现的规则：

1. Lane 依赖是第一版能力，决定启动和恢复资格；Join 复用同一套机制；一个 Step 只有一个 Wait 来源。
2. Lane 是长期逻辑执行线，Step 是类似宏任务的同步执行切片；所有外部等待必须 Effect 化。`step()` 保持同步纯函数，不改成 `async step()`。
3. 优先级覆盖 Lane 与 queued Effect，并通过依赖继承与 aging 处理关键路径和公平性；不向 running / 持锁者传分。LLMEffect 也复用同一调度规则。
4. LLM 只提出 Fork/Cancel 等 Control Proposal，Runtime Validation + Admission 决定是否真正生效；`cancel_lane` 仅限自有后代。Pulse 不做 Lane 预分配总预算。
5. Tool 通过 return / ToolError / emit 回报，Runtime 通过 AbortSignal 控制取消；Tool 不拥有 Effect/Lane 状态。
6. HumanEffect、AgentEffect、LLMEffect、ToolEffect、TimerEffect 使用同一 Effect/Event 生命周期；Human/Timer 不占执行槽。并行探索优先 Lane，真正语义隔离才创建 Child Agent。
7. 原始结果先进入 ResultStore 和调度队列，Scheduler 决定消费 Lane 的执行时机；LLM 消化结果后才提交 Finding/ContextDelta。
8. 取消、重试、timeout 以实际执行为准；收尾到期的未知副作用进入 QuarantineScope，不挂死 `run()`。无价值 Lane 可由 owner 以 SUPERSEDED 剪枝。
9. 序列化模型为恢复提供基础；`Mutation[]` 是事务与未来持久化日志。持久化、幂等派发和对账完成前不承诺可靠恢复。
10. Pulse Session 是状态真源；Global Context、Lane Context 和临时 Request Context 分层，Provider Conversation 不能替代会话状态。
11. ContextBuilder 基于固定版本与显式引用构建请求，稳定前缀服务于缓存优化；结果在提交请求前合并，提交后不因排队或重试改写输入。
12. 模型选择绑定每次 LLMEffect；ModelRouter 过滤能力、隐私与窗口并给出候选，Scheduler 统一取得资源，ModelEffectExecutor 只执行已批准的 Attempt。
13. 本地/云端切换与 fallback 不能放宽权限或隐私；LLM 默认 maxAttempts 覆盖候选数；usage/cache 记录实际可得数据。
14. `contextDelta + actions + next` 是一个 StepTransaction；validate 与 apply 分离；ContextDelta 用 `ops` 表达认知更新，控制意图必须显式建模，所有外部 Effect 只能在 apply 成功后派发。
15. Provider 响应先归一化为 `LLMResult`；schema 失败不发布结果；工具调用由下一同步 Step 的 Decoder 经 Pulse `toolCallId` 提交，不依赖 Provider Conversation。
16. `executionState` 与 `sideEffectState` 分离；纯 LLM 的远端未知可以释放本地模型槽并按策略有界重复计算，副作用未知必须进入 `reconcile_required`/`in_doubt`，不得直接重试。
17. Global Context 版本发布不改变任何 Lane 的 Snapshot；只有显式 `adopt_context` 或同事务 `adoptCommittedContext` 才能切换 `contextSnapshotVersion`，并且切换只影响下一次 Step。
18. Privacy Label 随记录传播；MVP 为 record 级；`local_only` 阻断云端路由；`public` 与 `cloud_allowed` 去向不同；只有可审计的降级才能生成 `cloud_allowed` 新对象。
19. SessionStoragePolicy 约束驻内存；事实事件逻辑上不设上限，M2 checkpoint 截断；活动引用必须 pin；超过 hard limit 返回 `SESSION_STORAGE_LIMIT_EXCEEDED`。
20. Progress Watchdog 用含 ResumePoint 的稳定指纹识别无进展；被拒事务不进窗口；升级由 Program + Router 策略收紧完成，Runtime 不改写已提交语义输入。
21. Host 命令与完成事件走 FactInbox；TimerWheel 统一到期；`hasRunnableWork()` 决定是否 `setImmediate`。这就是 Pulse 对 Node.js event loop 的实现映射。
22. Context Affinity 分三层：Lane `history` append-only 进稳定前缀，只能显式 `compact_history`；Fork 亲和由 Admission 建议、Program 决定，Runtime 不改写 Fork 形状；跨 Session 只允许 `createAgent` 时显式 `warmStart`，默认只带事实。三层都不改变快照、隐私和事务规则，取舍按第 27 节测量。

第一轮编码从 M0 开始，以状态不变量和验收场景驱动实现，再接真实模型与工具。当前文件交付的是架构与验收契约，不代表运行时已完成。
