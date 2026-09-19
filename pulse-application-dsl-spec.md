# Pulse Application DSL & Developer Experience 规范

> 设计版本：2026-09-19 r2 · 状态：待评审规范（Draft for Review）
>
> 上游依据：`pulse-runtime-architecture.md`（含 9.1 `localsHash` 排除规则、15.9 Context Affinity、21 `Tool.summarize`、22.7 `rejected_output`）
>
> 本文档定义 Pulse Runtime 之上的应用层开发体验：高阶状态图构建器（StepBuilder DSL）、预置 Agent 模板库（Templates）以及宿主实时交互协议（Session API）。r2 相对 r1 的修订见第 10 节。

---

## 1. 设计定位与分层视图

Pulse Runtime 内核是一个事件驱动调度器，原子单位是同步纯函数切片：

```text
LaneProgram.step(lane, context, resumeInput, now) → LaneStepOutput
```

直接手写 `step()`、手动分支匹配 `resumeInput`、手动拼接 `ContextOp[]` 与 `RuntimeAction[]`，心智负担过高。本规范的目标是：**在保持内核不变量的前提下，提供强类型、符合人体工学的高层抽象。**

需要保持的不变量，以及 DSL 对每一条的承诺：

| 内核不变量 | DSL 的承诺 |
| --- | --- |
| `step()` 是纯函数，禁止 IO / `Date.now()` / `Math.random()` / 全局可变状态 | 回调只能通过 `StepContext` 读写；观测走 `ctx.trace()`；开发模式冻结 `console` / `Date` / `Math.random` / `fetch` 并报错 |
| `ResumePoint` 只存 `step + locals`，代码由 `programId + programVersion` 定位 | 宏步编译为带命名空间的原子 Step 名；所有回调是确定性代码，不存在需要序列化的闭包状态；Fork 只能引用已注册的 Program |
| Step 只提交 `LLMContextSpec`，不内联数据；ContextBuilder 从引用重算 Privacy | `instruction` 只允许模板 + 标量插值；数据通过 `inputs` 以 ResultRef / FindingRef 传递 |
| 稳定前缀：System → Policy → Tools → Global 快照 → Lane History（append-only） | system 与 toolSet 是 Program 级；Global 快照与 history 永远全量进投影；Step 级只改后缀 |
| 一个 StepTransaction 一个 Wait 来源 | 每个宏步最多产生一个 Wait；编译期检查 |
| Fork 亲和：Runtime 建议、Program 决定 | M1.5 开启 `FORK_AFFINITY_COLLAPSIBLE` 后，SDK 默认折叠为 series Lane；`ack` 必须显式选择 |
| Progress Watchdog 依赖 `resumeStep + localsHash` | SDK 簿记全部放在 `locals.$sdk`，不进入 `localsHash` |
| Privacy 随记录传播，模型/开发者声明不能覆盖来源 | DSL 默认省略 `privacy`，SDK 记录来源，Runtime 按来源重算最严格标签 |
| `CONTROL_ERROR_LOOP`、Watchdog level 3、Limits、Cancel 是结构化终态 | ErrorBoundary 明确不捕获这些 |

r1 里"零隐式闭包"的说法不准确。回调就是闭包；正确的表述是：回调是由 `programId + programVersion` 定位的确定性代码，`ResumePoint` 里只有数据，因此重放、恢复和换进程都不需要序列化函数。

### 1.1 四层架构模型

```text
┌─────────────────────────────────────────────────────────────┐
│  Layer 3: Host Integration & Session                        │
│  - runtime.start(agentId) -> PulseSession                   │
│  - await runtime.run(agentId) -> Outcome                    │
│  - session.stream() / session.outcome() / session.reply()   │
└──────────────────────────────┬──────────────────────────────┘
┌──────────────────────────────▼──────────────────────────────┐
│  Layer 2: Pre-built Agent Templates                         │
│  - defineReActLane / defineSeriesLane                       │
│  - definePlanAndExecuteLane / defineScatterGatherLane       │
└──────────────────────────────┬──────────────────────────────┘
┌──────────────────────────────▼──────────────────────────────┐
│  Layer 1: StateGraph & StepBuilder DSL                      │
│  - addStructuredLLMStep / addReActLoopStep                  │
│  - addParallelStep / addDynamicForkStep / addMergeStep      │
│  - addWaitStep / addHumanStep / addTimerStep                │
│  - ctx.mutateLane / proposeGlobal / commitGlobal / trace    │
│  - Self-Correction / onError / ErrorBoundary                │
│  - 自动 history 压缩宏步                                    │
└──────────────────────────────┬──────────────────────────────┘
                               │ 编译为纯函数 step() 与 ResumePoint
┌──────────────────────────────▼──────────────────────────────┐
│  Layer 0: Pulse Runtime Kernel                              │
│  - LaneProgram, StepTransaction, validate → apply           │
│  - DependencyGraph, Scheduler, TimerWheel, QuarantineScope  │
└─────────────────────────────────────────────────────────────┘
```

---

## 2. Layer 1: Program 定义与 StepBuilder

### 2.1 Program 级配置：system 与 toolSet 是 Lane 的稳定前缀

```ts
const program = defineLaneProgram({
  id: 'coding.main',
  version: '3',
  system: '你是资深排障工程师……',          // 进入稳定前缀的 System 块，整个 Lane 生命周期不变
  toolSet: 'coding.default',              // Host 批准且带版本的工具集合 id；Lane 内不变
  state: z.object({ ... }),               // Lane state 的 Zod Schema，用于 mutateLane 的类型与路径校验
  historyCompaction: {                    // 可选；见 3.4
    summarizeTask: 'summarize',
    keepRecentRounds: 4,
  },
}, (builder) => { ... })
```

`system` 与 `toolSet` 放在 Program 级而不是 Step 级，是为了让同一条 Lane 从 `plan` 走到 `investigate` 再到 `verify` 时前缀不冷。Step 级对工具的限制通过 `toolAllow`（第 2.3 节）表达：它是权限策略层面的子集约束，Runtime 在 ToolEffect 提交时校验，不改变投影里的 Tools 块，也不改变 `toolSetId`。

Program 必须通过 `runtime.programs.register(program)` 注册后才能被 `createAgent` 或 Fork 引用。Fork 不接受内联的匿名 Program 对象。

### 2.2 复合宏步的编译原理

`builder.addXxxStep('name', ...)` 在构建期展开为带命名空间的原子 Step。每个原子 Step 都是纯函数，SDK 的簿记全部在 `locals.$sdk` 下：

| 宏步 | 派生原子 Step | 说明 |
| --- | --- | --- |
| `addStructuredLLMStep('plan')` | `plan:submit` → `plan:decode` → （`plan:correct` → `plan:decode`）? | `correct` 只在 Effect 以 `OUTPUT_SCHEMA_VIOLATION` 失败且 `selfCorrect.maxRounds > 0` 时进入，引用 `rejectedOutputRefs` 提交新 LLMEffect |
| `addReActLoopStep('investigate')` | `investigate:llm` → `investigate:decode` → `investigate:tools` → `investigate:llm` … | 有界 LLM ↔ Tool 循环；轮次计数在 `$sdk.turn` |
| `addParallelStep('pipeline')` | `pipeline:fork` → `pipeline:join` | 静态 `ForkAction + join`，一个 Wait 来源 |
| `addDynamicForkStep('dispatch')` | `dispatch:fork` → （`dispatch:affinity`）? → `dispatch:join` | M1.5 的 `affinity` 处理 `FORK_AFFINITY_COLLAPSIBLE`：默认折叠为 series Lane 重提 |
| `addMergeStep('merge')` | `merge:submit` → `merge:decode` | 输入限定为 MergeProposal 表与 Join Outcome |
| `addWaitStep` / `addHumanStep` / `addTimerStep` | `x:submit` → `x:resume` | 单一 Wait 来源 |
| 任意宏步（启用 `historyCompaction`） | `$compact:summarize` → `$compact:apply` 前置 | 见 3.4；只在宏步边界、无活动 Wait 时插入 |

```ts
interface SdkLocals {
  $sdk: {
    turn?: number
    pendingToolCalls?: Record<string, ToolCallRef>
    correctRound?: number
    series?: { index: number; keys: string[] }
    compactPending?: boolean
  }
}
```

`$sdk` 由 Runtime 在 `localsHash` 中排除（架构 9.1）。业务 locals 不得写入 `$sdk`；SDK 在开发模式下对此断言。

### 2.3 认知宏步

#### 2.3.1 `addStructuredLLMStep`：单轮结构化认知

```ts
interface StructuredLLMStepOptions<TState, TOutput extends z.ZodTypeAny> {
  task: LLMTaskType
  instruction: string | ((view: InstructionView<TState>) => string)
  inputs?: (ctx: StepContext<TState>) => StepInputs
  schema: TOutput
  requirements?: LLMRequirements            // 追加到 Program/Host 策略之上，只能收紧
  selfCorrect?: { maxRounds: 0 | 1 }        // 默认 { maxRounds: 1 }
  executionPolicy?: LLMExecutionPolicy
  retryPolicy?: RetryPolicy                  // selfCorrect 时通常设 maxAttempts: 1
  onSuccess: (data: z.infer<TOutput>, ctx: StepContext<TState>) => NextStepTarget<TState>
  onError?: (error: RuntimeError, ctx: StepContext<TState>) => NextStepTarget<TState>
}

interface StepInputs {
  results?: ResultRef[]                     // 已授权、不可变的结果
  findings?: FindingRef[]
  events?: string[]
}

interface InstructionView<TState> {
  goal: string
  state: ScalarProjection<TState>           // 只暴露 string | number | boolean | null 字段；对象与数组为 never
}
```

`instruction` 只能插值标量。`view.state` 的类型把对象和数组字段映射为 `never`，在编译期就写不出 `${JSON.stringify(view.state.errorLogs)}`；运行时 SDK 对渲染后的 instruction 做长度上限检查（默认 2 KB），超出则在 validate 阶段拒绝并给出 `INSTRUCTION_TOO_LARGE`。要给模型看数据，用 `inputs`：

```ts
builder.addStructuredLLMStep('plan_investigation', {
  task: 'plan',
  instruction: (v) => `目标：${v.goal}。请根据输入中的异常日志制定排查计划。`,
  inputs: (ctx) => ({ results: [ctx.laneState.errorLogRef] }),
  schema: z.object({
    rootCauseHypothesis: z.string(),
    tasks: z.array(z.object({ key: z.string(), goal: z.string(), affinityKey: z.string().optional() })),
  }),
  onSuccess: (plan, ctx) => {
    ctx.mutateLane((d) => { d.plan = plan })
    return { step: 'dispatch' }
  },
})
```

编译后 `plan:submit` 提交的是：

```ts
{
  type: 'llm',
  task: 'plan',
  context: {
    globalSnapshotVersion: lane.contextSnapshotVersion,   // 整个快照进前缀，不按键选取
    laneSnapshotVersion: lane.laneContextVersion,         // history 全量，append-only
    resultRefs: [errorLogRef],
    eventIds: [],
    toolSetId: program.toolSet,
    instruction: '目标：……',
    privacy: /* Runtime 重算 */,
    privacyRefs: /* Runtime 重算 */,
  },
  outputSchema: zodToJsonSchema(schema),
  retryPolicy: { maxAttempts: 1 },
}
```

r1 的 `contextSelector.global: string[]` 与 `laneHistory: number` 已删除。按键选取 Global 会让每个 Step 的前缀不同；只取最近 N 轮 history 会破坏"后一次 history 块 = 前一次 + 一轮"的逐字节一致。history 的长度只由 `compact_history` 控制。

**Self-correction 的数据流。** `OUTPUT_SCHEMA_VIOLATION` 是 Attempt 失败；当 `retryPolicy.maxAttempts: 1` 时，Effect 直接失败并带出 `rejectedOutputRefs`。`plan:correct` 提交一个新的 LLMEffect：`inputs` 为原始 inputs + `rejectedOutputRefs`，instruction 附加校验错误列表。这是新 Effect、新 ContextSpec，不是同一 Effect 的重试。被拒输出不进入 `history`；只有最终通过校验的结果归档。`selfCorrect` 用尽后进入 `onError`，未配置则进入 ErrorBoundary。

#### 2.3.2 `addReActLoopStep`：有界 LLM ↔ Tool 循环

```ts
interface ReActLoopStepOptions<TState> {
  task?: LLMTaskType                        // 默认 'reason'
  instruction: string | ((view: InstructionView<TState>) => string)
  inputs?: (ctx: StepContext<TState>) => StepInputs      // 首轮输入；后续轮次自动带上本轮 Tool 结果
  toolAllow?: string[]                      // Program toolSet 的子集；权限层校验，不改变 Tools 块
  maxTurns?: number                         // 默认 10
  requirements?: LLMRequirements
  onFinish: {
    text: (finalTextRef: ResultRef, ctx: StepContext<TState>) => NextStepTarget<TState>
    structured?: { schema: z.ZodTypeAny; onParsed: (data: unknown, ctx: StepContext<TState>) => NextStepTarget<TState> }
  }
  onMaxTurns?: (ctx: StepContext<TState>) => NextStepTarget<TState>
  onError?: (error: RuntimeError, ctx: StepContext<TState>) => NextStepTarget<TState>
}
```

内置行为：

- 每轮 `investigate:decode` 读取已发布的 `LLMResult`，把 `toolCalls` 通过 Pulse 自有 `toolCallId` 提交为 ToolEffect 批量（一个 `submit_effects.wait all`），不依赖 Provider 会话。
- Tool 结果（含 `ToolError`）作为下一轮 `inputs.results` 送回模型；工具错误不在 SDK 层重试，交给模型决定。
- `$sdk.turn` 计数；达到 `maxTurns` 进入 `onMaxTurns`，未配置则以 `MAX_TURNS_REACHED` 进入 `onError` / ErrorBoundary。
- `onFinish.text` 收到的是 ResultRef，不是字符串：最终文本可能很大，同步 Step 只拿引用。要在 Step 内分支，用 `onFinish.structured`。

Watchdog 对这个循环有效：`$sdk.turn` 不进 `localsHash`，同一查询重复三次会被识别为无进展。

### 2.4 并发宏步

#### 2.4.1 `addParallelStep`：静态 DAG

```ts
interface ProgramRef {
  programId: string
  programVersion: string
  step?: string                             // 默认 Program 入口
  locals?: JsonValue
}

interface ParallelStepOptions<TState, TKeys extends string> {
  lanes: Record<TKeys, {
    goal: string
    program: ProgramRef
    priority?: LanePriority
    contextVersion?: 'parent' | 'latest'   // 默认 parent
    affinityKey?: string
    dependsOn?: Array<{ sibling: TKeys; condition: 'success' | 'settled' }>
  }>
  join?: {
    condition?: 'success' | 'settled'       // 默认 settled
    onUnsatisfied?: 'fail_lane' | 'resume_with_error'
    onCancelled?: 'unsatisfied' | 'ignore'
  }
  affinity?: 'collapse' | 'ack'             // M1.5 默认 collapse；M1 的 forkAffinity=off 时不触发
  onJoin: (outcomes: Record<TKeys, Outcome>, ctx: StepContext<TState>) => NextStepTarget<TState>
}
```

`program` 只接受 `ProgramRef`。静态 Fork 也可能触发 `FORK_AFFINITY_COLLAPSIBLE`（例如三条 Lane 都声明了同一目录的 `exclusive` 锁），处理策略与 2.4.2 相同。

#### 2.4.2 `addDynamicForkStep`：模型驱动的 Fork 与亲和处理

```ts
interface DynamicForkStepOptions<TState> {
  proposal: (ctx: StepContext<TState>) => ForkProposal
  join?: ParallelStepOptions<TState, string>['join']
  affinity?: 'collapse' | 'ack' | ((groups: AffinityGroup[], ctx: StepContext<TState>) => 'collapse' | 'ack') // M1.5
  onJoin: (outcomes: Map<string, Outcome>, ctx: StepContext<TState>) => NextStepTarget<TState>
}
```

`dispatch:affinity` 收到 `FORK_AFFINITY_COLLAPSIBLE`（不计入 `consecutiveControlErrors`）后：

- **`collapse`（默认）**：对每个亲和组，若成员使用同一 `programId` 且没有指向组外的 `dependsOn` 差异，SDK 把它们改写为一条 series Lane（第 4.2 节）：`program` 为同一 Program，`locals.$sdk.series = { keys, index: 0 }`，goal 为按组内 `dependsOn` 拓扑排序后的有序子目标列表。不满足折叠条件的组退化为 `ack`。重提的 ForkAction 带 `affinityAck: true`，避免第二次往返。此改写发生在 Program/SDK 的错误处理 Step 中，Runtime 不直接改写已提交的 Fork。
- **`ack`**：保留原拆分，`affinityAck: true` 重提。用于开发者已知方向确实独立（如 scatter-gather）的场景。

`onJoin` 看到的 key 集合永远是原 proposal 的 key。series Lane 的 Outcome 是 `{ results: Record<key, MemberOutcome> }`，SDK 在 `dispatch:join` 解包成逐 key 的 `Outcome` 视图，因此上层代码不感知折叠是否发生。

r1 的"默认自动带 `affinityAck` 重试"已删除：它把亲和建议变成一次无意义的往返，等于在 DSL 层取消了架构 15.9 的默认原则。

### 2.5 等待与控制宏步

```ts
builder.addWaitStep('await_tests', {
  targets: (ctx) => [{ key: 'tests', target: ctx.laneState.testsLaneRef, condition: 'settled' }],
  mode: 'all',
  timeoutMs?: number,
  onResolved: (resolution, ctx) => NextStepTarget,
  onUnsatisfied?: (resolution, ctx) => NextStepTarget,
})

builder.addHumanStep('confirm_patch', {
  prompt: (view) => string,                 // 标量插值规则同 instruction
  inputs?: (ctx) => StepInputs,             // 给人看的引用
  schema: z.ZodTypeAny,                     // 人类回复的结构
  timeoutMs?: number,
  onReply: (reply, ctx) => NextStepTarget,
  onTimeout?: (ctx) => NextStepTarget,
})

builder.addTimerStep('backoff', { delayMs: (ctx) => number, onFire: (ctx) => NextStepTarget })
```

`StepContext` 上的控制动作（在 `NextStepTarget` 之外附加到同一事务）：

- `ctx.cancelLane(laneRef, reason: CancelLaneReason)`：仅自有后代；Runtime 校验所有权。
- `ctx.proposeCancel(laneRef, reason: ProposeCancelReason)`：非自有 Lane，进入 owner 的 `control_proposal`。
- `ctx.adoptContext(version | 'latest')`：只影响下一次 Step；`CONTEXT_REBASE_CONFLICT` 进入本 Step 的 `onError`。

`NextStepTarget`：

```ts
type NextStepTarget<TState> =
  | { step: string }
  | { complete: { value?: JsonValue; privacy?: PrivacyLabel; children?: 'reject_if_active' | 'cancel' | 'await' } }
  | { fail: { code: string; message: string; privacy?: PrivacyLabel } }
```

```ts
type CancelLaneReason = 'SUPERSEDED' | 'USER_REQUESTED' | 'POLICY'
type ProposeCancelReason = 'SUPERSEDED' | 'POLICY'
```

`complete.children` 默认 `reject_if_active`，与内核一致；需要收尾子 Lane 时显式写 `'await'` 或 `'cancel'`。

编译期检查：一个宏步只能有一个 Wait 来源。`addParallelStep` 的 join、`addWaitStep`、ReAct 内部的 tool wait 互斥；开发者无法在 `onSuccess` 里再挂第二个 Wait，因为 `NextStepTarget` 不暴露 Wait。

---

## 3. Context 读写

### 3.1 `StepContext`

```ts
interface StepContext<TState> {
  readonly lane: Readonly<LaneRecord>
  readonly global: Readonly<JsonValue>         // 本 Lane 固定的 Global 快照（contextSnapshotVersion），不是最新版本
  readonly globalVersion: ContextVersion
  readonly laneState: Readonly<TState>         // Lane Context 的 state 段
  readonly history: ReadonlyArray<HistoryRecordMeta>   // 只有元数据（seq、effectId、privacy、hash），没有正文
  readonly now: number                         // Runtime 注入
  readonly watchdog?: ProgressWatchdogState

  results: {
    meta(ref: ResultRef): ResultMeta           // privacy、sizeBytes、hash、producer
    summary(ref: ResultRef): JsonValue | undefined   // Tool.summarize 的有界摘要，架构 21 节
  }

  mutateLane(fn: (draft: TState) => void): void
  proposeGlobal(opts: { ops: ContextOp[] | ((draft: any) => void); privacy?: PrivacyLabel }): void
  commitGlobal(opts: { ops: ContextOp[] | ((draft: any) => void); privacy?: PrivacyLabel; adoptImmediately?: boolean }): void
  adoptContext(version: ContextVersion | 'latest'): void

  cancelLane(target: LaneRef, reason: CancelLaneReason): void
  proposeCancel(target: LaneRef, reason: ProposeCancelReason): void

  trace(event: { kind: string; data?: JsonValue }): void     // 进 ObservationInbox，不进事实日志
}
```

规则：

- **正文不进同步 Step。** `ctx.results` 没有 `get(ref).value`。分支判断只能依赖 `summary`（Tool 声明的 ≤ 4 KB 结构化摘要）或 `LLMResult` 的结构化输出。大结果由 LLMEffect 或 Tool 通过 ResultRef 消费。
- **`mutateLane` 只写 `state` 段。** 路径以 `['history', ...]` 开头的写入在编译期（`state` Schema 中不允许 `history` 字段）和 validate 阶段双重拒绝。
- **Draft 到 `ContextOp[]` 的映射是确定性的且路径粒度有限：** 对象字段赋值 → `set(path)`；`push` → `append(path)`；`delete` → `remove(path)`；对数组元素的索引写入、`splice`、`sort` → 对整个数组 `set`。索引路径不进入 ops，因为数组索引在并发 append 下不稳定，会让路径级冲突检测失效。
- `proposeGlobal` 编译为 `target: 'global', proposal: true`；`commitGlobal` 编译为 `target: 'global'`，需要 policy 授权（通常 root）。`adoptImmediately: true` 编译为 `LaneStepOutput.adoptCommittedContext = true`，与 `adoptContext` Action 互斥，编译期报错。
- `trace()` 是唯一合法的观测出口。开发模式下 SDK 冻结 `console.*`、`Date.now`、`Math.random`、`fetch`、`process`，回调触碰即抛 `PURE_STEP_VIOLATION`；生产模式不冻结但也不承诺重放一致。

### 3.2 Privacy：来源自动收集，标签由 Runtime 重算

所有产出（`complete.value`、`fail`、`proposeGlobal`、`commitGlobal`、`mutateLane` 生成的 ContextDelta）在 DSL 层默认省略 `privacy`。SDK 必须记录本 Step 实际读取或消费的来源，包括 `inputs.results` / `inputs.findings`、`LLMResult`、Join Outcome、`ctx.results.summary(ref)` 读取的 ResultRef，以及被读取的 Global/Lane Snapshot 记录；Runtime 再按完整 `derivedFrom` 集合计算最严格标签。

`ctx.global` 或 `ctx.laneState` 的读取如果没有更细的字段级来源追踪，必须保守继承对应 Snapshot 的有效隐私标签，不能因为只读取了一个字段就自动降级。`ctx.results.meta(ref)` 只读元数据，`summary(ref)` 则把该 ResultRef 计入来源集合。

显式指定 `privacy` 只能比 Runtime 根据来源计算的标签更严格；指定更宽松会在 validate 阶段被拒绝（`PRIVACY_DOWNGRADE_WITHOUT_PROOF`）。降级只能走架构 15.6.1 的 `downgrade_privacy`，DSL 不提供快捷方式。

DSL 不暴露 `privacy: 'derived'` 伪标签；“派生”只表示 `derivedFrom` 关系，真正的 PrivacyLabel 仍只有 `public`、`cloud_allowed` 和 `local_only`。

DSL 类型中的 `privacy?` 只是表示“由编译器根据来源补全”；编译成 RuntimeAction 或 ContextDelta 前必须已经得到具体 PrivacyLabel，不能把缺省值或 `derived` 传入 Runtime。

### 3.3 `addMergeStep`：认知合并

```ts
builder.addMergeStep('synthesize', {
  task?: LLMTaskType,                        // 默认 'reason'
  sources: {
    proposals: 'joined' | LaneRef[],         // MergeProposal 表中由这些 Lane 提交的 proposal
    outcomes: 'joined' | LaneRef[],          // 这些 Lane 的 Outcome.result
  },
  instruction: string | ((view) => string),
  schema: z.ZodTypeAny,
  onSynthesized: (report, ctx) => NextStepTarget,
})
```

`sources` 只能是两类：子 Lane 通过 `proposeGlobal` 登记的 `MergeProposal`，以及 Join 拿到的 `Outcome.result`。子 Lane 的 Lane Context 对父 Lane 不可见，r1 的 `'all_joined_lanes' → 子 Lane 的 FindingRefs` 违反 15.6 的隔离规则，已删除。root 在 `onSynthesized` 中用 `commitGlobal` 落地；`proposeGlobal` 是给非 root 用的。

### 3.4 自动 history 压缩

Program 级 `historyCompaction` 开启后，SDK 在每个宏步入口插入检查：若 `lane.historyPressure` 存在、`$sdk.compactPending` 为 false、且当前没有活动 Wait，则先进入 `$compact:summarize`（`task: summarizeTask`，inputs 为 Runtime 按真实 `HistoryRecord.seq` 计算出的待压缩范围），再在 `$compact:apply` 提交 `compact_history { upToSeq, summaryRef }`，然后回到原宏步。`upToSeq` 必须来自 Runtime 的序号边界计算，不能用数组长度代替。

这是普通 Program 逻辑，不是内核的自动压缩：Runtime 仍只在超过 `hardTokens` 时返回 `CONTEXT_TOO_LARGE`。未开启 `historyCompaction` 的 Program 需要自己响应 `lane.historyPressure`。

---

## 4. Layer 2: 预置模板

### 4.1 `defineReActLane`

```ts
defineReActLane({
  id, version,
  system: string,
  toolSet: string,
  instruction: string | ((view) => string),
  maxTurns?: number,
  outputSchema?: z.ZodTypeAny,
  historyCompaction?: HistoryCompactionOptions,
}): LaneProgram
```

等价于一个只含 `addReActLoopStep` 的 Program，完成时 `complete: { value: structured ?? { textRef } }`，由 Runtime 根据来源填充 PrivacyLabel。

### 4.2 `defineSeriesLane`：同系列子目标串行执行

series 是亲和折叠的载体，也可以直接使用。它把 N 个同 Program 的子目标放进一条 Lane 依次执行，共享同一段 `history`，每个子目标完成时不发 `CompleteAction`，而是推进 `$sdk.series.index` 并回到 Program 入口；全部完成后以 `{ results: Record<key, MemberOutcome> }` 完成。

```ts
defineSeriesLane({ id, version, member: ProgramRef }): LaneProgram
```

限制：成员必须是同一 `programId`；成员间 `dependsOn` 只能是组内前序（拓扑序执行）；任一成员 `fail` 时后续成员按 `onMemberFailure: 'continue' | 'abort'`（默认 `continue`，与 Join `settled` 语义对齐）处理。

### 4.3 `definePlanAndExecuteLane`

```ts
definePlanAndExecuteLane({
  id, version, system, toolSet,
  planner: { task: LLMTaskType; instruction; schema },
  workers: Record<string, ProgramRef>,
  affinity?: 'collapse' | 'ack',            // M1.5 默认 collapse；M1 的 forkAffinity=off 时不触发
  synthesizer: { instruction; schema },
}): LaneProgram
```

Plan（`addStructuredLLMStep`）→ Fork（`addDynamicForkStep`，亲和默认折叠）→ Join → Synthesize（`addMergeStep`，sources 为 joined proposals + outcomes）→ `commitGlobal` + `complete`。

### 4.4 `defineScatterGatherLane`

```ts
defineScatterGatherLane<TItem>({
  id, version,
  items: (ctx) => TItem[],
  worker: ProgramRef,
  batch?: number,                           // 默认 1：每个 item 一条 Lane
  reducer: (outcomes: Outcome[], ctx) => NextStepTarget,
}): LaneProgram
```

数据并行是开发者声明的意图，模板对 Fork 设 `affinity: 'ack'`：同一目录下 50 个文件按路径前缀信号会被整体判为同系列，折叠成一条 Lane 会让 scatter 失去意义。要用延迟换缓存，用 `batch: k` 把 k 个 item 组成一条 series Lane，这是显式选择而不是 Admission 猜测。`reducer` 拿到的是 Outcome（其 `result` 是各 worker 的 `complete.value`，应当是小型结构化数据；大产物用 ArtifactRef）。

---

## 5. 容错、自愈与错误边界

```text
Level 1  宏步内置自愈
         OUTPUT_SCHEMA_VIOLATION → selfCorrect（新 Effect，引用 rejected_output）
Level 2  Step 级 onError(error, ctx)
Level 3  Program 级 onErrorBoundary(error, ctx)
```

### 5.1 ErrorBoundary 能接什么、不能接什么

能接：

- 未配置 `onError` 的 Step 的 `RuntimeError`（含 `MAX_TURNS_REACHED`、`CONTEXT_REBASE_CONFLICT`、Wait `unsatisfied` 且策略为 `resume_with_error`）。
- Watchdog `interventionLevel` 1、2 的 `control_error { code: 'NO_PROGRESS_DETECTED' }`。Boundary 返回的目标 Step 同样会被指纹化；如果它本身不推进，Watchdog 继续升级。
- 未在 `addDynamicForkStep` 中处理的 `FORK_AFFINITY_COLLAPSIBLE`（一般不会发生，SDK 默认已处理）。

不能接，Runtime 直接把 Lane 置为终态：

- `CONTROL_ERROR_LOOP`（连续控制错误达上限）。
- Watchdog `interventionLevel` 3。
- `LIMIT_EXCEEDED`、`TIMEOUT`（Agent/Lane 级 deadline）、`SESSION_STORAGE_LIMIT_EXCEEDED`。
- Cancel（含 `SUPERSEDED`）。

r1 写的"捕获连续控制错误超限"与内核"上限到达则结构化失败"冲突，已删除。

### 5.2 "降级"是收紧路由要求，不是 Program 换模型

Boundary 想在无进展后换更强的模型，做法是跳转到一个 `requirements` 更严格的 Step（如 `requirements.reasoning: 'high'`）。ModelRouter 会叠加 `minReasoningFloor(interventionLevel)`；Program 不能指定 `model: 'xxx'`，也不能放宽 Privacy / Limits。

```ts
builder.onErrorBoundary((error, ctx) => {
  ctx.trace({ kind: 'boundary', data: { code: error.code } })     // 不是 console.error
  if (error.code === 'NO_PROGRESS_DETECTED') return { step: 'plan' }
  return { fail: { code: error.code, message: error.message } }
})
```

---

## 6. Layer 3: 宿主交互

### 6.1 API

`runtime.start()` 是 DSL 提供的 Host Facade：它创建一个交互式 `PulseSession`，内部仍使用 Runtime 的 FactInbox、EventLog 和状态事务。内核的 `runtime.run()` 保持一次性等待并返回最终 `Outcome`。

```ts
const session = runtime.start(agentId)        // 交互式 Session；run() 仍返回最终 Outcome

for await (const ev of session.stream()) { ... }
const outcome = await session.outcome()       // Outcome 含 unresolvedEffectIds（quarantine）
await session.reply(humanEffectId, payload)   // 回复 HumanEffect；经 FactInbox
await session.cancel(reason)                  // Host 命令；经 FactInbox
```

```ts
interface PulseSession {
  stream(): AsyncIterable<SessionEvent>
  snapshot(): Promise<SessionSnapshot>
  outcome(): Promise<Outcome>
  reply(humanEffectId: EffectId, payload: JsonValue): Promise<void>
  cancel(reason: string): Promise<void>
}
```

`outcome()` 在 Agent 进入终态后 resolve。终态已经蕴含"子 Lane 收尾、非 quarantine Effect 结束"；仍在 quarantine 中的 Effect 以 `unresolvedEffectIds` 返回，宿主自行决定是否等待对账。

### 6.2 流事件分两类，背压策略不同

| 类别 | 事件 | 慢消费者时 |
| --- | --- | --- |
| 观测（ObservationInbox 镜像） | `llm:chunk`、`tool:progress`、`scheduler:trace`、`step:trace` | 有界 ring buffer，可丢弃 |
| 事实（FactInbox / EventLog 镜像） | `lane:created`、`lane:fork`、`lane:settled`、`effect:settled`、`agent:settled`、`human:requested` | 不丢弃；缓冲满时插入 `{ kind: 'gap', fromSeq, toSeq }`，宿主用 `session.snapshot()` 重同步 |

两类事件都不能反向阻塞 Scheduler tick；事实事件的"不丢弃"靠 gap 标记 + 快照重同步实现，不是靠阻塞内核。流的消费与内核状态转换完全解耦：宿主对流做任何事都不会进入 `validate` / `apply`。

Session 不拥有独立的保留策略；结果、事件、Snapshot 和流缓冲的驻内存占用由 Runtime 的 `SessionStoragePolicy` 统一管理。活动 Lane、Wait、LLM Request、ResultRef 和 `session.snapshot()` 重同步所需的数据必须 pin；未被引用的数据才能持久化或 compact。无法持久化且所有数据都被 pin 时，Session 以 `SESSION_STORAGE_LIMIT_EXCEEDED` 结束，DSL 不得自行丢弃事实事件。

### 6.3 `createAgent` 与 warm start

```ts
runtime.createAgent({
  goal,
  program: ProgramRef,
  priority?, policy?, limits?,
  warmStart?: {
    sessionId: SessionId
    globalVersion: ContextVersion | 'final'
    include?: 'facts' | 'facts_and_findings'   // 默认 facts
    relevanceRefs?: ResultRef[]
  },
})
```

语义见架构 15.9 第三层：一次显式 adopt，标签与 `derivedFrom` 原样保留，之后独立演进。

---

## 7. 端到端示例：定位并修复登录偶发失败

```ts
import { z } from 'zod'
import { defineLaneProgram, PulseRuntime } from '@pulse/runtime'

const MainState = z.object({
  plan: z.object({ analyzeGoal: z.string(), testsGoal: z.string() }).optional(),
  fixOutcomeRef: z.string().optional(),
})

export const mainProgram = defineLaneProgram({
  id: 'coding.main',
  version: '1',
  system: '你是资深排障工程师。按证据行动，不臆测。',
  toolSet: 'coding.default',
  state: MainState,
  historyCompaction: { summarizeTask: 'summarize', keepRecentRounds: 4 },
}, (builder) => {
  builder.addStructuredLLMStep('plan', {
    task: 'plan',
    instruction: (v) => `目标：${v.goal}。拆解为"代码排查"与"复现测试"两个子目标。`,
    schema: z.object({ analyzeGoal: z.string(), testsGoal: z.string() }),
    onSuccess: (plan, ctx) => {
      ctx.mutateLane((d) => { d.plan = plan })
      return { step: 'dispatch' }
    },
  })

  builder.addParallelStep('dispatch', {
    lanes: {
      analyze: { goal: '排查登录偶发失败的根因', program: { programId: 'coding.analyze', programVersion: '1' } },
      tests:   { goal: '编写复现偶发失败的测试', program: { programId: 'coding.tests', programVersion: '1' } },
      fix: {
        goal: '根据 analyze 的结论生成并应用修复',
        program: { programId: 'coding.fix', programVersion: '1' },
        dependsOn: [{ sibling: 'analyze', condition: 'success' }],
      },
    },
    join: { condition: 'settled' },
    // M1.5 且启用 forkAffinity=advise 时，默认 collapse：若 analyze 与 fix 声明了同一模块的 exclusive 锁，会被折叠为一条 series Lane
    onJoin: (o, ctx) => {
      if (o.fix.status === 'succeeded' && o.tests.status === 'succeeded') {
        ctx.mutateLane((d) => { d.fixOutcomeRef = o.fix.resultRef })
        return { step: 'verify' }
      }
      return { fail: { code: 'PIPELINE_FAILED', message: `fix=${o.fix.status} tests=${o.tests.status}` } }
    },
  })

  builder.addReActLoopStep('verify', {
    instruction: '运行测试，验证补丁是否彻底解决登录偶发失败。',
    inputs: (ctx) => ({ results: [ctx.laneState.fixOutcomeRef!] }),
    toolAllow: ['run_tests'],
    maxTurns: 3,
    onFinish: {
      structured: {
        schema: z.object({ passed: z.boolean(), summary: z.string() }),
        onParsed: (r, ctx) => {
          if (r.passed) {
            ctx.commitGlobal({ ops: (d) => { d.status = 'fixed'; d.summary = r.summary } })
            return { complete: { value: r, children: 'await' } }     // PrivacyLabel 由 Runtime 根据来源计算
          }
          return { step: 'plan' }   // Watchdog 会盯住这条回路
        },
      },
      text: (ref, ctx) => ({ fail: { code: 'UNSTRUCTURED_VERIFY', message: `见 ${ref}` } }),
    },
  })

  builder.onErrorBoundary((error, ctx) => {
    ctx.trace({ kind: 'boundary', data: { code: error.code } })
    if (error.code === 'NO_PROGRESS_DETECTED') return { step: 'plan' }
    return { fail: { code: error.code, message: error.message } }
  })
})

async function main() {
  const runtime = new PulseRuntime({ /* limits, policy, adapters */ })
  runtime.programs.register(mainProgram)
  // analyze / tests / fix 三个 worker Program 同样注册

  const agent = runtime.createAgent({
    goal: '定位并修复登录偶发失败的问题',
    program: { programId: 'coding.main', programVersion: '1' },
  })

  const session = runtime.start(agent.id)
  for await (const ev of session.stream()) {
    if (ev.kind === 'llm:chunk') process.stdout.write(ev.token)
    if (ev.kind === 'gap') await resync(session.snapshot())
    if (ev.kind === 'human:requested') await session.reply(ev.effectId, await askUser(ev))
  }
  const outcome = await session.outcome()
  console.log(outcome.status, outcome.unresolvedEffectIds)
}
```

---

## 8. 与内核规范的对齐映射表

| DSL 概念 | 内核概念 |
| --- | --- |
| `defineLaneProgram({ id, version, system, toolSet })` | `programId` / `programVersion`；`system` 进 System 块；`toolSet` 是 `toolSetId`，Lane 内不变 |
| `builder.addXxxStep('name')` | 命名空间化的 `ResumePoint.step`；SDK 簿记在 `locals.$sdk`，被 `localsHash` 排除（9.1） |
| `instruction + inputs` | `LLMContextSpec.instruction` + `resultRefs` / `eventIds`；Global 快照与 history 全量进前缀（15.7、15.8、15.9） |
| `selfCorrect` | Effect 以 `OUTPUT_SCHEMA_VIOLATION` 失败后，引用 `rejectedOutputRefs` 提交新 LLMEffect（22.7） |
| `toolAllow` | ToolEffect 提交时的权限子集校验；不改 Tools 块 |
| `ctx.mutateLane` | `ContextDelta { target: 'lane', ops }`，只写 `state` 段；数组索引写入折叠为整数组 `set` |
| `ctx.proposeGlobal` / `ctx.commitGlobal` | `target: 'global', proposal: true` → MergeProposal；`target: 'global'` 需授权；`adoptImmediately` 编译为 `adoptCommittedContext` |
| `ctx.results.summary(ref)` | `ResultRecord.summary`（`Tool.summarize`，21 节）；正文不进同步 Step |
| `ctx.trace()` | ObservationInbox；不进事实日志、不触发状态转换 |
| DSL 省略 `privacy` | Runtime 按完整 `derivedFrom` 重算最严格标签（15.6.1）；显式值只能更严格 |
| `addParallelStep` / `addDynamicForkStep` | `ForkAction + join`；`FORK_AFFINITY_COLLAPSIBLE` → series Lane 重提或 `affinityAck`（14.1、15.9） |
| `defineSeriesLane` | 一条 Lane、一段 history、`$sdk.series` 游标；Runtime 不感知折叠 |
| `addMergeStep.sources` | MergeProposal 表 + Join `Outcome.result`；不读子 Lane Context |
| `historyCompaction` | 宏步边界插入 summarize + `compact_history`；`hardTokens` 仍由内核 `CONTEXT_TOO_LARGE` 兜底 |
| `addWaitStep` / `addHumanStep` / `addTimerStep` | `wait` / HumanEffect / TimerEffect；单一 Wait 来源 |
| `ctx.cancelLane` / `ctx.proposeCancel` | `cancel_lane`（仅后代）/ `propose_cancel` → `control_proposal` |
| `complete.children` | `CompleteAction.children`，默认 `reject_if_active` |
| `onErrorBoundary` | 接 `RuntimeError` 与 Watchdog level 1/2；不接 `CONTROL_ERROR_LOOP` / level 3 / Limits / Cancel |
| `runtime.start()` → `session.stream()` | ObservationInbox 可丢弃；FactInbox 不丢弃，用 `gap` + `snapshot()` 重同步；`runtime.run()` 直接返回 Outcome |
| `session.outcome()` | Agent 终态 Outcome，含 `unresolvedEffectIds` |
| `session.reply()` / `session.cancel()` | Host 命令经 FactInbox（19 节） |
| `createAgent.warmStart` | 15.9 第三层显式 adopt |

---

## 9. 审核结论

DSL 在以下三点上不再架空内核：

1. **显式引用**：`instruction` 只能插标量，数据走 `inputs`；Global 快照与 history 全量进前缀。隐私重算、缓存前缀、投影重建三件事都保住了。
2. **亲和默认**：在 M1.5 开启亲和检查后，`FORK_AFFINITY_COLLAPSIBLE` 默认折叠为 series Lane；`ack` 是显式选择。scatter-gather 因意图明确而例外。
3. **Watchdog 可见性**：SDK 簿记进 `locals.$sdk`，不进 `localsHash`；ReAct 循环里的重复查询能被识别。

以及：Boundary 边界与内核终态一致；`addMergeStep` 不越过 Lane 隔离；PrivacyLabel 随来源传播；观测流对事实事件不丢；system/toolSet 为 Program 级，前缀不在宏步之间冷。

## 10. r1 → r2 变更清单

| r1 | r2 | 原因 |
| --- | --- | --- |
| `prompt: (ctx) => string`，可内联 `laneState` 任意字段 | `instruction`（标量插值）+ `inputs`（ResultRef / FindingRef） | 15.7 显式引用；隐私重算；稳定前缀 |
| `contextSelector.global: string[]`、`laneHistory: number` | 删除；快照与 history 全量 | 15.8 / 15.9 前缀逐字节一致 |
| Step 级 `systemPrompt` / `tools` | Program 级 `system` / `toolSet`；Step 级 `toolAllow` | 前缀不在宏步间冷 |
| `addDynamicForkStep` 默认 `affinityAck` 重试 | M1.5 默认 `collapse` 为 series Lane；`ack` 显式 | 15.9 默认原则 |
| 簿记位置未定义 | `locals.$sdk`，`localsHash` 排除 | 9.1 Watchdog 可见性 |
| 自愈"重试 1 次"来源未定义 | 新 Effect 引用 `rejectedOutputRefs`；被拒输出不进 history | 22.7 |
| ErrorBoundary 捕获"连续控制错误超限" | 不捕获 `CONTROL_ERROR_LOOP` / level 3 / Limits / Cancel | 上限语义 |
| `console.error` 于纯函数 | `ctx.trace()`；开发模式冻结全局 | 纯函数不变量 |
| `addMergeStep.sources: 'all_joined_lanes'` 读子 Lane Finding | MergeProposal + Join Outcome | 15.6 隔离 |
| 示例硬编码 `privacy: 'public'` | DSL 默认省略标签；Runtime 按 `derivedFrom` 计算，显式只能收紧 | 15.6.1 |
| `program: LaneProgram` 内联对象 | `ProgramRef` | ResumePoint 只存数据 |
| 观测流 ring buffer 统一可丢 | 观测可丢；事实 `gap` + `snapshot()` | 宿主不漏 Lane 终态 |
| `runtime.execute()` | `runtime.run()` 返回 Outcome；交互式宿主使用 `runtime.start()` 获取 Session | 与架构 23 节一致 |
| 无 | `addWaitStep` / `addHumanStep` / `addTimerStep`、`cancelLane` / `proposeCancel`、`complete.children`、`historyCompaction`、`warmStart`、`ctx.results.summary` | 补齐内核已有能力的 DSL 面 |
