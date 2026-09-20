# Pulse Runtime MVP 开发方案（M0 + M1 贯通交付计划）

> 设计版本：2026-09-19 · 更新：2026-09-20 · 状态：MVP 实施基准 + 代码验收记录（Execution Blueprint）
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
| DSL Draft 数组语义与运行诊断 | `push→append`、数组索引/splice/sort→整数组 set；explain 补充队列、等待、watchdog、preparation、execution metadata | `tests/dsl-context.test.ts`、`tests/runtime-control.test.ts` | `d5c6ef2`、`f57ae27` |
| Mutation 事务预检 | clone 预检失败不写日志、不改变运行时；提交时保留 Lane/Effect 对象身份 | `tests/storage-mutation-log.test.ts` | `70c3534` |
| Tool Schema 与 Provider 上限 | 不支持的 Zod 类型构建时 fail-closed；Anthropic `maxOutputTokens` 不再写死 | `tests/m3-context-adapters.test.ts` | `e21907a` |
| 持久化恢复边界 | `persisted` 驻留状态、backend restore、在途写副作用 quarantine、journal event `txId` 一致 | `tests/storage-policy.test.ts`、`tests/storage-outbox.test.ts` | `00d49f6`、`f7ba385`、`9b22fd3`、`c0e87f6` |
| 运行观测 | 只读 telemetry 聚合 agent/lane/effect/attempt、route 排除、provider/model、slot wait、usage/cost | `tests/provider-host.test.ts` | `e68cae0` |
| 输出预算与可恢复 Tool | `maxOutputTokens` 参与窗口预留、候选准入和 Provider 请求；structured schema 与最终 `outputSchema` 契约校验；保存 executionRef 并提供 RecoverableTool 对账入口 | `tests/provider-host.test.ts`、`tests/tool-host.test.ts`、`tests/m3-context-adapters.test.ts` | `d451014`、`b4461a8`、`83ebe38` |
| 高级 Wait 与 Tool 准入 | Wait 支持 `any/quorum`、独立 deadline 和恢复重建；Tool Manifest 可在提交前注入可信锁、副作用策略与默认超时 | `tests/advanced-join.test.ts`、`tests/tool-host.test.ts` | `af1ff6f`、`f523c71`、`a95d4f5` |

统一验证命令为 `pnpm exec tsc -b --pretty false && pnpm test`；当前结果为 40 个测试文件、160/160 通过，`pnpm build` 也已通过。

以下内容没有被无凭证确定性测试伪装成“已完成”：有效凭证下的真实 Provider Live Smoke、进程级故障注入后的完整崩溃恢复/副作用对账，以及真实网络下的 Provider 工具 schema/取消验证。确定性持久化、恢复、pin/retention 和 telemetry 已补齐对应代码与测试，但不替代真实进程/网络证据。

> **里程碑边界**：M1 的 Context/模型/DSL 主链已经实现；record 级 Privacy、Progress Watchdog、Fork Affinity、warm start、ResultRef 隔离、结构化拒绝输出、持久化恢复入口和 correlated telemetry 已补入当前代码。真实崩溃故障注入、外部副作用对账和真实 Provider 验证仍保持独立 Gate，不用本地单测冒充完成。

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
   - 已实现独立的驻内存 hard cap、大小预估、自动 pin/retention、显式 compact、backend 确认后的 `persisted` 驻留状态、`SESSION_STORAGE_LIMIT_EXCEEDED` 和统一恢复入口；进程级故障注入与外部副作用对账仍属于独立恢复 Gate

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
   - 实现 `addParallelStep` 与 `addDynamicForkStep`：支持静态 DAG 与动态 Fork；M1 固定 `forkAffinity=off`，M1.5 才启用 `FORK_AFFINITY_COLLAPSIBLE` 的 collapse/ack 重提
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
- [ ] Live Smoke：已尝试真实 Provider 请求，但当前环境返回 `PROVIDER_HTTP_401`；需要有效凭证后重新验证请求投影、`LLMResult` 归一化、工具调用关联和取消收尾。该失败只记录 Provider 集成阻塞，不否定确定性 Gate。

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
- 当前确定性门禁：`pnpm exec tsc -b --pretty false && pnpm test`，40 个测试文件、160 个测试通过；`pnpm build` 通过。Live Smoke 已执行到真实 HTTP 鉴权层并收到 `PROVIDER_HTTP_401`，未将其失败冒充内核证明。

### 5.2 当前仍未达到“完全可用”的验收项

| 验收项 | 当前状态 | 缺口 |
| --- | --- | --- |
| 真实 Provider Live Smoke | 已执行但被鉴权阻塞 | 请求已到真实 HTTP endpoint，当前返回 `PROVIDER_HTTP_401`；需要有效凭证验证 token、取消、structured output 和 tool-call 往返 |
| Runtime Storage pin/retention | 确定性代码与后端快照已覆盖 | 自动 pin、hard-limit 预检、compact、backend 确认后的 `persisted` 标记和 restore 已有测试；旧 Snapshot/Result 外部索引与所有进程入口的统一写事务仍需生产实现 |
| 崩溃恢复与副作用对账 | 部分完成 | 有快照、Mutation Log、Outbox、backend restore 和启动 quarantine；仍缺进程级故障注入、真正的持久化事务边界和真实写副作用 reconcile 证明 |
| Provider 请求完整能力 | 确定性映射已覆盖，真实厂商仍待验证 | OpenAI-compatible/Anthropic 请求带 model、tool schema、structured schema，usage 已归一化；真实 endpoint 的字段兼容、计费口径、取消和 tool-call 往返仍需有效凭证 |
| 运行观测 | Runtime 侧已补齐只读出口 | `inspect/explain` 加上 telemetry，覆盖 route 排除原因、provider/model slot、Attempt usage/cost；生产 exporter、长期聚合和告警仍未实现 |

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
3. ResultRef 隔离、record Privacy、Watchdog、Fork Affinity、warm start、history 归档、结构化拒绝输出、ToolCallCorrelation、Runtime 自动 Storage pin、bounded preparation、Provider 请求映射、backend restore 和 correlated telemetry 已实现并有确定性测试；真实 Provider smoke、进程级故障恢复与生产 exporter 仍未勾选。
4. 所有外部模型与工具行为都必须经统一 Effect/Attempt、隐私、取消、重试和 ResultRef 契约进入 Runtime。

已勾选条目对应的实现和测试证据已经落库；未勾选条目仍是明确的后续验收任务。本方案不把当前确定性参考实现等同于生产级可靠恢复或完整多模型产品交付。
