# Pulse 与开源 harness / agent 对照审查

日期：2026-10-15（Asia/Shanghai）。范围为当前未提交工作区源码，Git HEAD 为 `cb1e11871a5910254a53165e5e50e7f175768ccd`；结论包含 HEAD 之后尚未提交的修复。没有把运行中的正式服务当作本次受测版本。

## 结论

发现 **5 项优先修复的缺口、4 项后续能力改进**。最值得先处理的是：最终验收失效时仍能宣布通过、需求没有完整映射到验收条目、检查结果没有绑定到被测代码版本。长命令输出丢失和新文件逐段写入的交互成本，也会直接影响长任务的排障与交付。

本轮进行了官方源码和文档对照，未运行产品测试、第三方 agent 或真实模型；没有测得新的失败率、性能数字或模型排名。下文的反例是根据分支条件构造的待验收场景，不能称为已经动态复现。产物为本报告和固定版本的参考源码快照，功能代码未修改。

## 参考对象与版本

| 对象 | 固定提交 | 主要借鉴点 |
|---|---|---|
| mini-swe-agent | `04d809ceab9d` | 简洁执行循环、显式成本/步骤上限、每步轨迹落盘。[源码](https://github.com/SWE-agent/mini-swe-agent/blob/04d809ceab9df28f9adaed044884180159172930/src/minisweagent/agents/default.py#L132) |
| SWE-bench harness | `02e7a74ffd0b` | 执行实际测试并分别判定 FAIL_TO_PASS 和 PASS_TO_PASS。[评分源码](https://github.com/SWE-bench/SWE-bench/blob/02e7a74ffd0b707aab73d203fe87bdc7c76afc8e/swebench/harness/grading.py#L231) |
| OpenHands Software Agent SDK | `11d82b2c267a` | 完成时可运行 Stop hook 并阻止结束，持久事件、审批及组合卡住检测。[Stop hook](https://github.com/OpenHands/software-agent-sdk/blob/11d82b2c267ab180e94ebcb668dc3c1cbce28f85/openhands-sdk/openhands/sdk/conversation/impl/local_conversation.py#L1963) |
| Pi coding agent | `6a1f799b675c` | 新文件工具、完整命令日志留存、会话投影/压缩与格式迁移。[写入](https://github.com/earendil-works/pi/blob/6a1f799b675c8cb98320b71ff7ee44f160fe8d66/packages/coding-agent/src/core/tools/write.ts#L11)、[日志](https://github.com/earendil-works/pi/blob/6a1f799b675c8cb98320b71ff7ee44f160fe8d66/packages/coding-agent/src/core/tools/bash.ts#L332)、[压缩](https://github.com/earendil-works/pi/blob/6a1f799b675c8cb98320b71ff7ee44f160fe8d66/packages/coding-agent/docs/compaction.md) |
| Deep Agents | `7764f1f8d21a` | 大工具结果转存 backend，短结果附可恢复引用，按任务选择上下文和委派能力。[结果转存源码](https://github.com/langchain-ai/deepagents/blob/7764f1f8d21a594f0cbd31d273a7cad36597d6ba/libs/deepagents/deepagents/middleware/filesystem.py#L3500) |

Pi 的原 `badlogic/pi-mono` 地址当前重定向至 `earendil-works/pi`，本轮使用重定向后的官方仓库。上述提交通过 GitHub API 获取，17 个相关源码文件按提交下载，只作阅读；[来源与文件哈希清单](/Users/zhuhengtan/projects/Pulse/.pulse-dev/harness-comparison-20261015/references/sources.json)可核对。

这些项目展示的是可借鉴机制。例如 OpenHands 的 Stop hook 需要正确配置，SWE-bench 的评分针对其测试任务；它们不保证任意开放任务都能可靠完成。本轮没有进行同模型、同任务、同环境的横向跑分。

## 优先修复

### H01 · P1：最终验证异常或不完整，仍可能 accepted

**源码确认。** [verify-task 及 report](/Users/zhuhengtan/projects/Pulse/packages/server/src/task-controller/program.ts:718)中，最终验证异常会清空 `finalReview` 后进入报告；报告只在某个 criterion 恰好有一条明确失败判断时否决，否则沿用阶段通过状态。第二次未知引用也直接进入报告，没有强制置为不可验收。

可构造四种情况：

- 所有阶段 passed，最终验证返回合法结构 `criteria: []`。
- 同一 criterion 返回两条互相冲突的判断，`review.length !== 1`。
- 最终验证连续两次引用不存在的结果。
- 最终验证遭遇网络、预算或格式错误，且不是当前专门处理的 EVIDENCE_CHANGED。

这些路径仍可能得到 accepted。已经保留的阶段证据可以支持继续工作，最终验收状态则需要单独判断。

**借鉴：** [SWE-bench 的独立判定](https://github.com/SWE-bench/SWE-bench/blob/02e7a74ffd0b707aab73d203fe87bdc7c76afc8e/swebench/harness/grading.py#L231)和 [OpenHands 的完成阻断挂钩](https://github.com/OpenHands/software-agent-sdk/blob/11d82b2c267ab180e94ebcb668dc3c1cbce28f85/openhands-sdk/openhands/sdk/conversation/impl/local_conversation.py#L1963)。建立 Host 拥有的最终验收契约：每个原始 criterion 恰好出现一次、引用有效、必须完成的检查均有实际结果；验证异常记为 unverifiable/incomplete，保留阶段，停止自动重做实现。

**验收条件：** 上述四个反例不再 accepted；已完成文件、阶段证据和预算保持；正常最终验证仍通过。文件/命令检查尽量由确定性检查完成，模型负责解释证据与补充语义评审。

### H02 · P1：混合段落需求中的约束未全部成为显式验收条目

**源码确认。** [acceptanceCriteriaFromObjective](/Users/zhuhengtan/projects/Pulse/packages/server/src/task.ts:104)在识别到两个以上列表项后，只把列表项用于条目生成。

例子：

```text
实现用户注册。必须复用现有数据库，禁止新增依赖。
- 支持邮箱注册
- 支持手机号注册
```

显式条目只覆盖两种注册方式。完整原文仍保存在 objective 并进入上下文；“复用数据库、禁止加依赖”没有独立的验收条目，覆盖矩阵不能证明这些约束已经满足。对于长需求文档，这会把部分约束交给模型自行记住。

**借鉴：** [SWE-bench 的外部测试规格](https://github.com/SWE-bench/SWE-bench/blob/02e7a74ffd0b707aab73d203fe87bdc7c76afc8e/swebench/harness/grading.py#L231)。把任务结果、禁止事项、环境约束分别形成有来源的契约，保留原段落/文档 hash。最小修复先覆盖列表之外的正文；不能因为条目上限而丢掉检查粒度，也不必为每条约束新增一次模型调用。

**验收条件：** 混合正文/列表、需求附件和后续明确修改都能追踪到验收条目；违反禁止新增依赖时不能只凭两项功能通过就完成任务。

### H03 · P1：成功检查缺少“针对哪一版产物”的证明

**机制缺口确认，影响待定向回归。** [必要检查判断](/Users/zhuhengtan/projects/Pulse/packages/server/src/task-controller/program.ts:672)记录同命令的最近结果；[文件新鲜度检查](/Users/zhuhengtan/projects/Pulse/packages/server/src/task-controller/evidence-current.ts:6)只核对所提供文件回执的当前 hash。shell 检查结果尚未把已有来源关系转化为可强制校验的被测版本、测试定义 hash 和依赖范围契约。

因此可构造“测试对版本 A 成功 → 修改为版本 B → 验证模型引用旧成功和新写入回执”的场景。当前文件 hash 可以完全正确，成功检查仍针对旧内容。当前新鲜度白名单还未覆盖 artifact.record、fs.move 或插件产物，需要统一证据类型。

**借鉴：** [SWE-bench 在候选补丁环境中执行检查](https://github.com/SWE-bench/SWE-bench/blob/02e7a74ffd0b707aab73d203fe87bdc7c76afc8e/swebench/harness/run_evaluation.py#L350)。形成标准 CheckReceipt，包含 criterionId、command/argv/cwd、测试定义、被测产物/工作区版本、环境与结果引用。受影响产物改变时，只失效相关检查。评测的固定检查规格由 harness 保管，不能由实现代理任意弱化。

**验收条件：** A 的通过不能证明 B；无关文件变化不要求重跑全部检查；模型漏引失败、修改检查使其永远成功、引用插件旧产物时均有明确判定。

### H04 · P1：长命令输出被截断后无法恢复

**源码确认。** [runShell.append](/Users/zhuhengtan/projects/Pulse/packages/adapters/src/tools/shell.ts:261)达到输出上限后丢弃剩余字节，最终只返回截断字符串和标记。[Host shell 工具](/Users/zhuhengtan/projects/Pulse/packages/server/src/index.ts:394)配置为每个输出流最多 64 KiB；ResultRef 保存的也只有这些已保留内容。

大型测试、构建或迁移输出的最后诊断可能因此不可见。重复取同一 ResultRef 不能恢复被丢掉的部分，容易迫使模型重新运行命令。

**借鉴：** [Pi 的 fullOutputPath](https://github.com/earendil-works/pi/blob/6a1f799b675c8cb98320b71ff7ee44f160fe8d66/packages/coding-agent/src/core/tools/bash.ts#L332)和 [Deep Agents 的可恢复转存](https://github.com/langchain-ai/deepagents/blob/7764f1f8d21a594f0cbd31d273a7cad36597d6ba/libs/deepagents/deepagents/middleware/filesystem.py#L3500)。流式写入本 run 的受控 artifact，模型只读摘要及首尾片段，按引用分页读取完整日志；设置独立磁盘上限并继承结果的访问范围。

**验收条件：** 超长输出的末尾错误可从原执行 artifact 读取，无需重跑命令；退出码、超时/取消、原字节数、截断位置和 artifact hash 保持可审计。

### H05 · P1：新文件写入协议对长任务产生过多串行步骤

**硬限制确认；轮次代价为协议推算。** [编辑工具限制](/Users/zhuhengtan/projects/Pulse/packages/server/src/editing.ts:7)中，新文件分段最多 2048 UTF-8 字节，追加需要上一回执的 revision，普通新文件不能一次写入较大内容；计划有 16 KiB 的单独例外。

100 KiB 的一个新文件，若 begin 含首段，需要 1 次 begin、49 次 append、1 次 commit，共 51 个依赖步骤。模型按每次回执生成下一操作时，通常也会产生相应轮次。其他已授权的生成工具或脚本可能提供替代路径，因此这不是任意 100 KiB 任务的绝对调用下限；它是原生 fs.stage 路径的成本。

**借鉴：** [Pi 的新文件 content 工具](https://github.com/earendil-works/pi/blob/6a1f799b675c8cb98320b71ff7ee44f160fe8d66/packages/coding-agent/src/core/tools/write.ts#L11)。区分“输出给模型的观察预算”和“模型交付给 Host 的新文件预算”。根据模型输出能力调整新文件块大小，或让 Host 流式接收一次生成并管理草稿，最后统一校验、提交。继续保留已有文件的 CAS、小范围 patch、归属和语法保护。

**验收条件：** 给定 16/32/64 次实际调用预算，预先识别交付尺寸与协议是否可行；长新文件不会因固定 2 KiB 分段耗尽绝大多数预算。比较总轮次、输入/输出 token、首个可用产物及中断恢复，不能只比较单次响应大小。

## 后续能力改进

### H06 · P2：费用预算、验证预留与控制开销尚未统一

当前 [Host 持久预算](/Users/zhuhengtan/projects/Pulse/packages/server/src/model-budget.ts:101)正确限制实际调用次数，底层 [Runtime 已有 maxCostByCurrency](/Users/zhuhengtan/projects/Pulse/packages/runtime/src/scheduler/runtime.ts:2911)。但 [LocalHostOptions](/Users/zhuhengtan/projects/Pulse/packages/server/src/index.ts:127)及 [Runtime 创建](/Users/zhuhengtan/projects/Pulse/packages/server/src/index.ts:1925)没有把这类费用限额作为普通任务配置接入。相同调用次数仍可对应不同上下文长度、输出长度和成本。

控制器有轮次余量估计；[适配器提示预留两次验证](/Users/zhuhengtan/projects/Pulse/packages/adapters/src/providers/runtime-executor.ts:160)并非按实际 provider attempt 锁定的专用预留。审批、重试、压缩可能先消耗它们，与 H01 叠加时影响最终验收真实性。

借鉴 [mini-swe-agent 的显式成本/步骤边界](https://github.com/SWE-agent/mini-swe-agent/blob/04d809ceab9df28f9adaed044884180159172930/src/minisweagent/agents/default.py#L132)：保留用户确定的实际调用上限，增加可选费用/token 上限、按调用用途统计、明确的验证预留与预算不足检查点。底层已有能力应先接线，不能描述成整个 Pulse 没有预算控制。mini 的成本上限也是结算后检查，不能照搬成严格预估收费保证。

**建议验收：** 同一实际调用账本覆盖所有角色；复杂压缩/重试后验证额度仍有明确处理；无价格或 token 用量时显示未知；耗尽不自动创建新 run。对简单任务评估控制调用的占比，再决定轻量执行策略。

### H07 · P2：已确认事实的选择仍主要按新旧顺序

[confirmedInteractionSurface](/Users/zhuhengtan/projects/Pulse/packages/runtime/src/dsl/program.ts:246)保留约 8 KiB 最新条目；完整回复及查询工具已存在。尚未按原始约束、当前阶段、未完成验收和重要决定进行固定保留。旧的重要决定被移出常驻表面后，正确使用仍依赖模型主动查询。

这是**能力风险，尚未证明新的实际错误**。借鉴 [Pi 的结构化压缩](https://github.com/earendil-works/pi/blob/6a1f799b675c8cb98320b71ff7ee44f160fe8d66/packages/coding-agent/docs/compaction.md)及 [Deep Agents 的可回取引用](https://github.com/langchain-ai/deepagents/blob/7764f1f8d21a594f0cbd31d273a7cad36597d6ba/libs/deepagents/deepagents/middleware/filesystem.py#L3500)，建立当前任务事实投影：关键约束固定保留、相关决定随阶段进入、其余按需取回。决策更新应指向明确 ID 和版本，而不是依靠某个领域的问法与选项匹配。

**建议验收：** 访谈 30/100 个决定后仍落实最早的关键禁止事项；用户改意只替换对应事实；记录召回次数和错误计划率，不能仅以摘要字节变小为成功。

### H08 · P2：Host 持久化仍是整体 JSON 快照

[LocalHost](/Users/zhuhengtan/projects/Pulse/packages/server/src/index.ts:1915)固定选择 FileRuntimePersistenceBackend；[该后端](/Users/zhuhengtan/projects/Pulse/packages/runtime/src/storage/persistence.ts:671)加载整个 JSON，并为保存序列化完整快照。已有摘要 digest 去重保护没有变化的状态，但持续进展仍会让历史、Effect 请求和结果随运行积累。

底层已经有 SQLite、结果外置及事件归档等原语；[外置结果恢复](/Users/zhuhengtan/projects/Pulse/packages/runtime/src/storage/persistence.ts:899)目前也会重新水合全部正文。文件不断增长带来的写放大、恢复时间和内存风险需要测量，本轮没有给出性能数值。

借鉴 OpenHands [文件支持的 EventLog 与独立状态快照](https://github.com/OpenHands/software-agent-sdk/blob/11d82b2c267ab180e94ebcb668dc3c1cbce28f85/openhands-sdk/openhands/sdk/conversation/state.py#L432)：Host 提供持久化后端选择，先复用已有外置存储，再把原始轨迹与活跃工作集分开，按 ResultRef 懒加载；继续保留原子提交与对账语义。

**建议验收：** 无模型条件下测 100/1000/10000 个步骤的磁盘写入量、恢复耗时、峰值内存及持久化故障恢复；不通过无限放宽存储护栏解决容量问题。

### H09 · P2：恢复兼容主要依赖人工版本号，迁移路径不完整

[恢复兼容检查](/Users/zhuhengtan/projects/Pulse/packages/runtime/src/scheduler/runtime.ts:1163)核对 program/tool version 以及可选 policy/router version，已有明确拒绝机制。版本号未变化时，实现、schema 或策略变动并不必然被识别；旧 ownerless 草稿当前需要确认归属后处理，也缺少完整的用户迁移入口。

借鉴 [Pi 的显式会话格式迁移](https://github.com/earendil-works/pi/blob/6a1f799b675c8cb98320b71ff7ee44f160fe8d66/packages/coding-agent/src/core/session-manager.ts#L334)，为 run 保存构建/工具 schema/策略指纹，提供“兼容继续、迁移继续、无法继续”的明确结果与迁移记录。旧草稿提供 dry-run 清单和人工归属确认，不能按文件名或时间自动认领；旧执行批准不能因迁移自动恢复效力。

**建议验收：** 升级前后恢复同一待答问题和草稿；工具 schema 不兼容时有具体原因；迁移失败原件完整；不会重复外部副作用或复活旧批准。Pi 的数据格式迁移不等于已解决所有执行代码版本问题，此处是进一步设计建议。

## 已有基础应当保留

Pulse 的 Runtime 已有原子状态变更、Effect 持久化、取消/不确定副作用对账、ResultRef/来源、恢复版本检查和 human effects；Host 已有共享调用账本、阶段控制、循环纠正/停止、检查点及文件 hash 核对。它也已有模型路由、工具发现和分工执行原语。此次差距主要在验收契约、证据绑定、数据留存/投影及 Host 对已有原语的接入。

OpenHands 的组合卡住检测值得参考，但 Pulse 的交替读取、草稿轮转和无进展停止已经有对应修复。本轮没有把它们再次列为缺失能力，也没有建议默认开启更多代理以消耗预算。

## 建议实施顺序

1. **验收真实性**：H01、H02、H03。先补缺失/重复最终判定、混合需求约束、旧测试证明新代码的正反回归；保留已完成阶段，不回到全量重规划。
2. **交付与排障成本**：H04、H05、H06。先完整日志 artifact，再改善新文件接收协议和实际调用预算分配；利用固定任务做调用数与产物对照。
3. **长会话容量与升级**：H07、H08、H09。先测规模和召回，再改变存储或迁移。真实模型对照需另定预算；本次审查不触发调用。

## 证据与边界

- [固定参考源码清单](/Users/zhuhengtan/projects/Pulse/.pulse-dev/harness-comparison-20261015/references/sources.json)。
- [本轮保留审计](/Users/zhuhengtan/projects/Pulse/.pulse-dev/harness-comparison-20261015/final-audit.json)。
- [上一轮修复与实际验证范围](/Users/zhuhengtan/projects/Pulse/docs/reviews/pulse-all-known-issues-repair-2026-10-15.md)。

本轮只读代码审查。上一轮的 1164 项本地测试与 18 项边界回归是历史证据，本轮没有重新运行；它们也不意味着上述新分支和容量场景已经被覆盖。正式环境、终端实际操作、跨平台、开源项目默认效果以及真实模型长任务成功率均不在本轮验收范围。
