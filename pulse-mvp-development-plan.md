# Pulse Runtime MVP 开发方案（M0 + M1 贯通交付计划）

> 设计版本：2026-09-19 · 状态：实施基准（Execution Blueprint）
> 
> 上游依据：
> - `pulse-runtime-architecture.md`（内核规范与验收标准）
> - `pulse-application-dsl-spec.md`（应用层 DSL 与开发体验规范 r2）

---

## 1. 方案目标与交付范围

本方案为 Pulse Runtime 的首个生产级实施蓝图，目标是**从零构建并贯通 M0（调度内核）到 M1（真实可用多模型 Runtime）的全流程**。

### 1.1 交付范围界定

```text
┌──────────────────────────────────────────────────────────────────────────┐
│  M0：证明调度内核（确定性仿真闭环）                                       │
│  - 纯函数状态机：validate -> Mutation[] -> apply 两阶段提交             │
│  - 依赖图拓扑、死锁检测、单一 Wait 约束、优先继承与 Aging 机制          │
│  - 调度器 Tick 循环、TimerWheel、Fact/Observation 双 Inbox              │
│  - Effect 队列与 Attempt 隔离、QuarantineScope 资源收容                 │
│  - 虚拟时钟 Harness 跑通全量 28 项 M0 验收标准用例                      │
└────────────────────────────────────┬─────────────────────────────────────┘
                                     │ 顺畅递进
┌────────────────────────────────────▼─────────────────────────────────────┐
│  M1：多模型与应用层 DSL 贯通（真实任务可用）                             │
│  - 三层 Context 隔离（Global/Lane/Request）与稳定前缀构建器              │
│  - 多模型生态适配：DeepSeek、Qwen、GLM、MiniMax、Anthropic、Ollama      │
│  - 标准 Tool SDK、Filesystem 与安全 Shell 执行器                        │
│  - Layer 1 StepBuilder 宏步编译器与 Layer 2 预制模板库                  │
│  - Layer 3 Session 双通道流式 API 与端到端排障流水线演示                │
└──────────────────────────────────────────────────────────────────────────┘
```

> **明确排除项（非 MVP 范围）**：M1.5 的 Progress Watchdog 指纹检测与三级 Privacy 严格自动传播（M1 先做 record 级标头与 local_only 云端阻断）、M2 的崩溃恢复（crash recovery）、分布式 Worker、动态上下文压缩平台。

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
│   ├── runtime/                    # 核心调度内核 + StepBuilder DSL
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── src/
│   │       ├── index.ts
│   │       ├── types/              # 核心数据接口 (records, actions, events, mutations)
│   │       ├── kernel/             # 两阶段提交事务引擎 (validate, apply)
│   │       ├── graph/              # 依赖拓扑图、死锁环检测、WaitingIndex
│   │       ├── scheduler/          # 优先级计算、Aging、Tick 循环、TimerWheel
│   │       ├── lifecycle/          # QuarantineScope、CancellationScope
│   │       ├── effects/            # Effect 队列、Attempt 生命周期
│   │       ├── context/            # 三层 Context、稳定前缀、ContextBuilder
│   │       ├── router/             # ModelRegistry、ModelRouter
│   │       └── dsl/                # StepBuilder、复合宏步编译器、Session Handle
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
│           │   ├── openai-compat.ts# 通用兼容层 (DeepSeek, Qwen, GLM, MiniMax, Ollama)
│           │   ├── anthropic.ts    # Anthropic Messages + 显式 Prompt Cache
│           │   └── mock.ts         # 测试用受控 MockAdapter
│           └── tools/
│               ├── filesystem.ts   # readFile, writeFile, listFiles
│               └── shell.ts        # 带超时与进程组隔离的 ShellExecutor
├── tests/
│   ├── fixtures/                   # 离线模型响应快照 (DeepSeek, Qwen, Anthropic)
│   ├── m0-acceptance/              # 28 个内核确定性虚拟时钟测试
│   ├── m1-integration/             # Context 投影、模型路由、工具交互测试
│   └── e2e/                        # 端到端真实/Mock 排障流水线测试
└── examples/
    └── login-troubleshooting/      # 第 23 节完整实战示例
```

---

## 3. 多模型生态接入设计（@pulse/adapters）

为了全面覆盖国内外主流顶尖模型（**DeepSeek、Qwen 通义千问、GLM 智谱、MiniMax、Anthropic Claude、本地 Ollama**），采用“**通用 OpenAI-Compatible 核心 + 专精厂商预设 + Anthropic 显式缓存专有层**”的架构。

```text
                     createProviderAdapter(config)
                                  │
         ┌────────────────────────┴────────────────────────┐
         ▼                                                 ▼
OpenAICompatibleAdapter                            AnthropicAdapter
(标准 Chat Completions + Tool Calls)             (Messages API + Cache Control)
 ├─ Preset: DeepSeek (deepseek-chat / reasoner)   └─ Claude 3.5 / 3.7 Sonnet
 ├─ Preset: Qwen (DashScope 兼容端点)                 (显式 cache_control: ephemeral)
 ├─ Preset: GLM (BigModel 兼容端点)                   (采集 cache_read_tokens)
 ├─ Preset: MiniMax (ChatCompletion 端点)
 ├─ Preset: Ollama / vLLM (本地部署，支持 local_only)
 └─ Preset: OpenAI (GPT-4o, o3-mini)
         │                                                 │
         └────────────────────────┬────────────────────────┘
                                  ▼
                     统一归一化为 LLMResult
       - Pulse 自有 toolCallId 映射与生成
       - finishReason 归一化 (tool_calls, stop, length, error)
       - Token & 缓存指标标准化 (ModelUsage)
```

### 3.1 统一适配器接口契约

```ts
export interface ProviderAdapter {
  readonly id: string
  readonly name: string
  
  executeAttempt(params: {
    request: PreparedLLMRequest
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
1. **类型定义 (`packages/runtime/src/types/`)**
   - 编写 `records.ts`：`AgentRecord`, `LaneRecord`, `EffectRecord`, `WaitRecord`, `ResultRecord`
   - 编写 `actions.ts`：`SubmitEffectsAction`, `ForkAction`, `WaitAction`, `CancelLaneAction`, `CompleteAction`, `FailAction`
   - 编写 `mutations.ts`：不可变状态变更原子操作集
   - 编写 `events.ts`：运行时事实事件与观测事件规范
2. **两阶段状态转移引擎 (`packages/runtime/src/kernel/`)**
   - 实现 `validate(state, input): { mutations: Mutation[] } | { rejection: ControlError }`（必须纯函数、禁止任何副作用、全面校验引用完整性与单一 Wait 约束）
   - 实现 `apply(state, mutations: Mutation[]): void`（不可失败、零 I/O、确定性更新内存数据索引）
3. **依赖拓扑与循环检测 (`packages/runtime/src/graph/`)**
   - 实现 `DependencyGraph`：维护 Lane 间与 Effect 间有向依赖边
   - 实现 `CycleDetector`：Tarjan 算法检测死锁闭环（按架构规则，仅 `children: 'await'` 形成死锁边，`cancel` 不误判）
   - 实现 `WaitingIndex`：高效键值索引，保证上游发布不可变结果时，下游以 $O(1)$ 查找并唤醒，杜绝丢失唤醒（Lost Wakeup）

#### 验收门禁 Gate 1
- [ ] 纯函数验证：使用属性测试（Property-based Test）证明 `apply` 永远不抛异常，且相同 input 在相同状态下输出完全一致。
- [ ] 循环检测门禁：通过包含自依赖、兄弟环、跨代祖先依赖等 10 组拓扑测试用例。
- [ ] 单一 Wait 门禁：同时提交 `submit_effects.wait` 与 `fork.join` 必须 100% 触发 `MULTIPLE_WAIT_SOURCES` 拒绝并生成 `control_error`。

---

### 4.2 Milestone 2：调度引擎、QuarantineScope 与 M0 确定性验收闭环（M1-2）

#### 核心目标
构建核心事件循环驱动、多队列管理、时间轮唤醒以及失联收尾隔离区。使用受控 Virtual Clock 跑通第 26 节全量 28 个 M0 验收场景。

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
   - 基于 MockExecutor 与 VirtualClock 逐项编写第 26 节规定的 28 个核心场景用例。

#### 验收门禁 Gate 2（第 26 节 28 项 M0 验收全绿）
- [ ] 单 Lane 串行推进正确性
- [ ] 两 Lane 独立等待（A 等长工具不阻塞 B 多轮推进）
- [ ] Lane 启动依赖（A 成功前 B 绝不执行任何业务 step）
- [ ] all 汇聚等待（所有条件满足后只恢复一次）
- [ ] success 上游失败优雅处理
- [ ] settled 上游失败/取消汇总
- [ ] onCancelled: ignore 不使 Join 失败
- [ ] 上游先完成、后注册 Wait 绝不丢失唤醒
- [ ] LocalRef 同批提交并等待原子生效
- [ ] 多 Wait 来源原子拒绝 (`MULTIPLE_WAIT_SOURCES`)
- [ ] 迟到完成事件 no-op，终态不被改写
- [ ] 依赖闭环动态拒绝
- [ ] 隐含收尾边死锁正确性校验
- [ ] Fork 参数非法整批回滚，不留下半创建 Lane
- [ ] 优先级与 aging 排序严格生效
- [ ] 防饥饿测试：老旧低优先级工作获得派发机会
- [ ] 依赖优先级继承正确穿透到 queued 工作
- [ ] 不可抢占运行：提权不强行中断在途 Attempt
- [ ] shared/exclusive 锁隔离与防写饥饿
- [ ] 并发槽位满整批背压拒绝
- [ ] Human/Timer 确认不占执行槽位
- [ ] 自有子任务取消传播，共享依赖不被误取消
- [ ] 兄弟 Lane 禁止直接互相 cancel（只能 propose）
- [ ] 完成与取消并发竞争一致性
- [ ] executionState 与 sideEffectState 分离记录
- [ ] QuarantineScope 正常接收超时未确认 Effect，`run()` 正常返回
- [ ] 重试 attemptId 自增而 effectId 不变，退避走时间轮
- [ ] Host 命令在 drain 期间只入队不重入

---

### 4.3 Milestone 3：三层 Context、多模型路由与真实工具集成（M1-3）

#### 核心目标
打通真实外部 I/O。实现稳定的请求投影构建器、多模型路由策略与候选 Fallback、六大模型通用适配器以及标准工具 SDK。

#### 具体任务拆解
1. **三层 Context 引擎 (`packages/runtime/src/context/`)**
   - 实现 GlobalContext 快照版本管理（`v0 -> v1 -> v2`）
   - 实现 LaneContext 的 `history` 与 `state` 物理分段存储
   - 实现 `ContextBuilder`：严格按照 `System -> Policy -> Tools -> Global 快照 -> Lane History` 生成逐字节一致的稳定请求前缀，并计算 `prefixHash`
   - 实现显式 `adopt_context` 与同事务 `adoptCommittedContext`
2. **多模型路由器与候选管理 (`packages/runtime/src/router/`)**
   - 实现 `ModelRegistry` 与 `ModelRouter`：根据任务类型（`plan`, `reason`, `summarize` 等）与隐私标记匹配合规候选
   - 静态并发槽位原子申请（Runtime 槽 + Provider 槽），槽位满整批等待
   - 实现候选自动 Fallback：复用 Effect 标识，顺序尝试后继模型候选
3. **多模型适配器实现 (`packages/adapters/src/providers/`)**
   - `OpenAICompatibleAdapter`：支持 DeepSeek (Reasoner 思考流解析), Qwen, GLM, MiniMax, Ollama
   - `AnthropicAdapter`：构造 `cache_control: { type: 'ephemeral' }` 标记，解析 `cache_read_input_tokens`
   - 实现统一 `LLMResult` 归一化与 Pulse 自有 `toolCallId` 强绑定
4. **工具 SDK 与真实执行器 (`packages/tool-sdk/`, `packages/adapters/src/tools/`)**
   - 实现 `defineTool` API，自动由 Zod 生成标准 JSON Schema Manifest
   - 实现 `FilesystemTool`：安全路径沙箱校验、读写与列表
   - 实现 `ShellTool`：子进程组管理、POSIX 信号优雅终止、`cancelGraceMs` 超时升级与输出缓冲截断

#### 验收门禁 Gate 3
- [ ] 稳定前缀测试：连续两次调用同一个 Lane，证明后一次生成的 History 前缀字节序列 100% 包含前一次。
- [ ] 模型生态离线 Fixture 测试：DeepSeek、Qwen、GLM、MiniMax、Anthropic 的模拟响应 100% 正确归一化为统一 `LLMResult`，Pulse `toolCallId` 正确映射。
- [ ] 本地与云端隐私阻断：当上下文投影包含 `local_only` 标签时，云端候选自动被过滤，若无可用本地候选则显式失败。
- [ ] 模型 Fallback 测试：首选模型超时或 500 报错时，调度器无缝派发第二候选，维持相同的 EffectId。
- [ ] Shell 进程组清理：对长时间运行的死循环脚本触发取消，验证系统无残留僵尸进程。

---

### 4.4 Milestone 4：应用层 StepBuilder DSL 与端到端真实流水线（M1-4）

#### 核心目标
构建符合人体工学的高层 DSL。实现复合宏步编译器、Immer Draft Proxy、双通道实时会话 API，并在真实模型上跑通“排查并修复偶发登录失败”完整业务流水线。

#### 具体任务拆解
1. **复合宏步编译器 (`packages/runtime/src/dsl/`)**
   - 实现 `defineLaneProgram` 与 `StepBuilder`
   - 实现 `addStructuredLLMStep`：绑定 Zod 强类型，编译展开为 `submit -> decode -> correct`，内置 1 轮 Schema 自我纠错
   - 实现 `addReActLoopStep`：展开为带轮次上限的纯函数有限状态机
   - 实现 `addParallelStep` 与 `addDynamicForkStep`：支持静态 DAG 与动态 Fork，内置 `FORK_AFFINITY_COLLAPSIBLE` 折叠重提
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
   - 分别使用 Mock 模型与真实模型（如 DeepSeek / Claude）执行全流程验证。

#### 验收门禁 Gate 4
- [ ] DSL 编译不变量：验证由 `StepBuilder` 编译出的 Program 100% 为纯函数，`ResumePoint` 仅含标量/JSON 状态，无隐式闭包。
- [ ] 结构化自愈验证：故意配置模型返回非规范 JSON，验证宏步自动发起 1 轮带有错误提示的自愈请求并成功解析。
- [ ] 慢消费者背压保护：在 `session.stream()` 人为阻塞消费的情况下，Runtime 内部调度 Tick 耗时不受任何影响。
- [ ] 端到端实战全绿：在真实模型环境下成功执行登录偶发故障排查示例，Main Lane 顺利汇总各子任务结果并生成修复补丁。

---

## 5. 测试与持续集成（CI）设计

为了确保工程在多模型接入背景下的稳定推进，实行**双层测试体系**：

```text
┌──────────────────────────────────────────────────────────────────────────┐
│  Level 1：CI 自动化无凭证测试（Zero-Credential Deterministic Suite）      │
│  - 触发时机：代码提交、Pull Request                                     │
│  - 运行方式：全量 MockAdapter + 录制好的真实 Provider Fixtures           │
│  - 覆盖范围：28 项 M0 内核验收 + 多模型转换 + DSL 编译 + Shell 沙箱     │
│  - 运行耗时：< 15 秒                                                     │
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
| **Milestone 2** | Week 3~4 | 调度器 Tick、时间轮、Quarantine、VirtualClock | Gate 2 门禁通过（第 26 节 28 个 M0 单测全绿） |
| **Milestone 3** | Week 5~6 | 三层 Context、稳定前缀、多模型适配器（DeepSeek/Qwen/GLM/Claude）、工具 SDK | Gate 3 门禁通过（多模型归一化、前缀一致性通过） |
| **Milestone 4** | Week 7~8 | StepBuilder DSL、Session 双通道流式 API、端到端实战示例 | Gate 4 门禁通过（端到端排查实战跑通，交付 M1） |

---

## 7. 方案结论

本方案严格继承并落地了《Pulse Runtime 架构设计》与《Pulse Application DSL 规范》：
1. **内核底座极其坚固**：通过 M0 的 28 个纯虚拟单测，先在完全确定的沙盒内锁死状态转移、依赖调度与资源隔离，不把底层并发 Bug 带入外部网络联调阶段。
2. **模型生态极度包容**：一套通用 OpenAI 兼容层直接吃透 DeepSeek、通义千问、智谱 GLM、MiniMax 与本地 Ollama，同时为 Anthropic 保留显式缓存前缀优化。
3. **应用开发极度优雅**：通过 StepBuilder 宏步与 Immer 代理抹平了多 Lane 并发与状态提交的复杂度，实现开箱即用的现代化 Agent 开发体验。

方案已就绪，可作为后续开发编码的唯一执行标准。
