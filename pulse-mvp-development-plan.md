# Pulse Runtime MVP 开发方案（M0 + M1 贯通交付计划）

> 设计版本：2026-09-19 · 状态：MVP 实施基准 + 代码验收记录（Execution Blueprint）
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

本仓库已从空仓库落地四个可独立运行的模块，并遵守“模块测试全绿后提交”：

| 模块 | 实现 | 测试证据 | 提交 |
| --- | --- | --- | --- |
| M1-1 内核契约 | Monorepo、records/actions、`validate → Mutation[] → apply`、依赖图、SCC、WaitingIndex | `tests/m1-core.test.ts`：6/6 | `ef1b95a` |
| M1-2 调度闭环 | VirtualClock/TimerWheel、ReadyQueue、aging、锁、Cancellation/Quarantine、Effect 调度 | `tests/m2-scheduler.test.ts`：9/9 | `7a0a262` |
| M1-3 Context/模型/工具 | 三层 Context 投影、稳定 hash、隐私路由、Provider Fixture、Zod Manifest、Filesystem/Shell、hard cap | `tests/m3-context-adapters.test.ts`：6/6 | `cd00c9a` |
| M1-4 DSL/Session/E2E | StepBuilder 宏步、纯函数边界扫描、Session、模板、登录排障示例 | `tests/m4-dsl-e2e.test.ts`：4/4 | `89b5e24`、`23af0f7` |

统一验证命令为 `pnpm exec tsc -b --pretty false && pnpm test`，当前结果为 4 个测试文件、25/25 通过。

以下内容没有被本次无凭证确定性测试伪装成“已完成”：完整第 26 节 M0 矩阵尚未逐项覆盖；真实 Provider Live Smoke、Shell 长进程组取消残留检查、Session 慢消费者背压基准、完整 fallback/remote_unknown 对账、持久化恢复、M1.5 Watchdog/record 级 Privacy/Fork Affinity，以及 M2 能力仍需独立实现或在真实环境验证。未勾选的 Gate 条目继续表示这些证据缺口。

> **里程碑边界**：M1 只做请求级 `local_only` 云端阻断、简单驻内存 hard cap 与显式 `compact_history`；M1.5 才做 record 级 Privacy Label/`derivedFrom`、Progress Watchdog、精细 Storage pin/compact、Fork Affinity 和 warm start。M2 再做可靠崩溃恢复、持久化 outbox、分布式 Worker 与其他扩展。

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
- [ ] success 上游失败优雅处理
- [ ] settled 上游失败/取消汇总
- [ ] onCancelled: ignore 不使 Join 失败
- [ ] 上游先完成、后注册 Wait 绝不丢失唤醒
- [ ] LocalRef 同批提交并等待原子生效
- [ ] 多 Wait 来源原子拒绝 (`MULTIPLE_WAIT_SOURCES`)
- [ ] StepTransaction 全部拒绝：Context、Lane、Effect、Cancel Intent、ResumePoint 和 Events 均不部分提交
- [ ] 多 Action 原子提交：同一 Step 的 ContextDelta、后代 `cancel_lane` 与 `submit_effects` 必须整体成功或整体拒绝
- [x] 迟到完成事件 no-op，终态不被改写
- [ ] 依赖闭环动态拒绝
- [ ] 隐含收尾边死锁正确性校验
- [x] Fork 参数非法整批回滚，不留下半创建 Lane
- [x] 优先级与 aging 排序严格生效
- [x] 防饥饿测试：老旧低优先级工作获得派发机会
- [ ] 依赖优先级继承正确穿透到 queued 工作
- [ ] 不可抢占运行：提权不强行中断在途 Attempt
- [x] shared/exclusive 锁隔离与防写饥饿
- [ ] 并发槽位满整批背压拒绝
- [ ] Human/Timer 确认不占执行槽位
- [x] 自有子任务取消传播，共享依赖不被误取消
- [ ] 兄弟 Lane 禁止直接互相 cancel（只能 propose）
- [x] 完成与取消并发竞争一致性
- [x] executionState 与 sideEffectState 分离记录
- [x] QuarantineScope 正常接收超时未确认 Effect，`run()` 正常返回
- [x] 重试 attemptId 自增而 effectId 不变，退避走时间轮
- [ ] Host 命令在 drain 期间只入队不重入

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
   - 实现 M1 请求级 `local_only` 云端阻断；record 级 Privacy Label、`derivedFrom` 重算与显式降级留到 M1.5
2. **模型路由器与候选管理 (`packages/runtime/src/models/`)**
   - 实现 `ModelRegistry` 与 `ModelRouter`：根据任务类型（`plan`, `reason`, `summarize` 等）与隐私标记匹配合规候选
   - 静态并发槽位原子申请（Runtime 槽 + Provider 槽），槽位满整批等待
   - 实现候选 Fallback：复用 Effect 标识，按 RetryPolicy 顺序尝试后继模型候选；只有错误可重试、本地清理完成、deadline/limits 允许且 `sideEffectState` 为 `none` 或已完成对账时才允许切换
3. **Provider 适配器实现 (`packages/adapters/src/providers/`)**
   - 实现一个 M1 选定的真实 Adapter，以及 `MockAdapter`；其他 Provider 通过 Fixture 验证字段归一化，不作为 M1 必交付
   - Anthropic/Provider cache control 作为后续 Adapter 优化；支持时记录指标，不把缓存命中当成 Runtime 正确性的前提
   - 实现统一 `LLMResult` 归一化与 Pulse 自有 `toolCallId` 强绑定；Adapter 不产生 RuntimeAction、不执行工具
   - 实现三层输出校验：Adapter 字段归一化、`outputSchema`/structured 校验、下一同步 Step 的 Action Decoder；非法输出进入 `rejected_output`，不发布业务 ResultRef
4. **工具 SDK 与真实执行器 (`packages/tool-sdk/`, `packages/adapters/src/tools/`)**
   - 实现 `defineTool` API，自动由 Zod 生成标准 JSON Schema Manifest
   - Manifest 必须声明输入/输出 schema、`concurrencyClass`、资源锁、AbortSignal 能力与副作用策略；工具不得自行循环重试
   - 实现 `FilesystemTool`：安全路径沙箱校验、读写与列表
   - 实现 `ShellTool`：子进程组管理、POSIX 信号优雅终止、`cancelGraceMs` 超时升级与输出缓冲截断
5. **M1 存储边界 (`packages/runtime/src/storage/`)**
   - 实现简单驻内存 hard cap、大小预估和 `SESSION_STORAGE_LIMIT_EXCEEDED`；M1 不实现精细 pin/compact，不能把未落盘数据标记为 persisted

#### 验收门禁 Gate 3
- [x] 稳定前缀测试：固定块顺序、Global/Lane 版本和 History 追加行为通过测试；完整逐字节前缀增长对比仍待补强。
- [x] Provider Fixture 测试：OpenAI-compatible / Anthropic 响应归一化为统一 `LLMResult`，Pulse `toolCallId` 正确映射；Fixture 不等于真实 Provider 已接入。
- [x] 本地与云端隐私阻断：`local_only` 投影只保留可信本地候选。
- [ ] 输出分层校验：非法 Provider 响应、structured schema 失败和 Action/权限失败分别产生对应错误；被拒输出不进入 Lane history，Tool 调用必须在下一同步 Step 提交。
- [ ] 模型 Fallback 测试：对可重试且已本地关闭的失败切换第二候选，维持相同的 EffectId；对 `remote_unknown + sideEffectState=unknown` 或 `duplicateExecutionPolicy='forbid'` 的情况不得直接重复派发。
- [ ] Shell 进程组清理：对长时间运行的死循环脚本触发取消，验证系统无残留僵尸进程。

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
- [x] DSL 编译不变量：宏步展开、JSON ResumePoint 与 `Date`/随机数/外部 I/O 源码违规扫描通过；完整运行时冻结 harness 仍待补强。
- [x] 结构化自愈验证：非规范输出触发一次带错误信息的新 LLM Effect 并成功解析。
- [ ] 慢消费者背压保护：在 `session.stream()` 人为阻塞消费的情况下，Runtime 内部调度 Tick 耗时不受任何影响。
- [x] 端到端实战全绿：Mock 环境成功执行登录排障 Main/Fork/Join/Synthesize 流程并汇总证据。
- [ ] Live Smoke（可选）：在真实 Provider 环境下验证请求投影、`LLMResult` 归一化、工具调用关联、隐私阻断和取消收尾；失败只记录 Provider 集成问题，不否定确定性 Gate。

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
2. M1 交付一个真实 Provider Adapter、受控 Mock、三层 Context、工具 SDK、StepBuilder 和确定性端到端示例；其他 Provider 与真实网络任务属于独立集成验证。
3. M1 不提前承诺 M1.5 的 Watchdog、record 级 Privacy、精细 Storage、Fork Affinity 和 warm start；这些能力按主架构单独排期。
4. 所有外部模型与工具行为都必须经统一 Effect/Attempt、隐私、取消、重试和 ResultRef 契约进入 Runtime。

已勾选条目对应的实现和测试证据已经落库；未勾选条目仍是明确的后续验收任务。本方案不把当前确定性参考实现等同于生产级可靠恢复或完整多模型产品交付。
