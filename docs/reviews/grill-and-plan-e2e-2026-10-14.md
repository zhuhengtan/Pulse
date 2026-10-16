# /grill-and-plan 端到端验收问题记录（2026-10-14）

环境：Pulse 开发版 CLI，正式配置选择 `deepseek/deepseek-flash`，隔离的 `PULSE_HOME` 与临时项目；Pulse 仓库未提交、未推送。测试项目均位于 `/private/tmp/pulse-grill-e2e.CsVBjE/`。

| 编号 | 真实运行中的现象与复现 | 处理状态 |
| --- | --- | --- |
| P-01 | 第一轮长计划运行中，`fs.stage begin` 接受 `content`，界面展示正文差异，但 `.pulse/drafts/*.json` 的 `content` 为空；模型误以为已写入。 | Pulse 已修复 `begin(content)` 暂存，`tests/incremental-editing.test.ts` 5 项通过。 |
| P-02 | 确认前保护规则拦截只读 `git status --short`；另一次模型使用 `git status --short --branch` 仍被拦截。 | Pulse 已补 `--short --branch` 两种参数顺序，拒绝复合命令；8 条直接输入检查通过。 |
| P-03 | 放行只读命令的初版复用了过宽判定，可能把 `sed -i`、`git branch -D` 当作只读。 | Pulse 改用确认阶段的严格匹配；两种危险命令的拒绝断言通过。 |
| P-04 | 长计划首次运行因同一模型回合混合 `ask` 与工作区工具，报 `ASK_MIXED_TOOL_CALLS`。 | Pulse 在技能正文加入提问单独回合要求；后续真实运行成功进入单题选择。 |
| P-05 | 长计划后续两轮在 `fs.stage begin` 后反复 `inspect` 暂存稿、读取尚不存在的目标，未 `append/commit`，最终 `NO_PROGRESS`。 | Pulse 已加仅限 `docs/plans/*.md`、16 KiB 上限且不覆盖已有文件的 `plan.write`，定向测试 9 项通过；`long6` 真实 DeepSeek 生成 5415 字节计划，完整预览后默认选择“暂不执行”，运行成功且无实现文件，复测通过。 |
| P-06 | “执行”路径中 Pulse 的 `node -e` 行为检查被自动审批拒绝 `AI_APPROVAL_DENIED:shell.exec`；其后又尝试等价命令。 | Codex 独立运行隔离项目中的模块，trim、空白、空串、null 四项输出通过；Pulse 内部自动审批体验仍需改进。 |
| P-07 | `tests/builtin-skills.test.ts` 的两处文案断言与技能正文不一致。 | Pulse 调整正文；内置技能与暂存编辑两组定向测试共 7 项通过。 |
| P-08 | Pulse 开发对话多次重复读取和规划；全量 `pnpm test` 在其工具环境中反复取消，最终 `REPEATED_TOOL_FAILURE`。 | 后续已修复无动作重规划、循环读取保护和过大编辑的无界纠正；任务控制器 60 项通过。模型仍不能可靠完成通用分段写入，最后被 16 次调用预算止损，详见下方。 |
| P-09 | `long4` 隔离项目的真实 DeepSeek 复测，前两次都在首次模型请求返回 `PROVIDER_NETWORK_ERROR`，未进入技能流程；两个 run 的 `outcome.json` 均标记 `retryable: true`。 | 已定位为受限环境 Node DNS 解析失败（ENOTFOUND）；在获准访问网络的开发 CLI 中复测成功，不属于技能逻辑故障。 |

已通过的主路径：`defer` 项目完成单题访谈、计划保存与聊天预览、默认“暂不执行”且无实现文件；`execute2` 项目明确选择“执行”后才创建 `src/greet.mjs`，独立 Node 行为检查通过。空外部技能目录下可发现内置技能，打包后单独提取模块也可激活。

最新验收：`long6` 的 5415 字节计划真实模型路径已通过；内置技能与编辑器定向测试 9 项、类型检查、git diff --check 通过；最新打包资源在单独提取且无外部技能目录时可发现并激活。

剩余边界：全量测试未通过；P-06 自动审批体验与 P-08 重复读取/规划根因未解决；开放式 ask.input、同名计划冲突及重启恢复没有做真实模型端到端验收。开发 CLI 重启后实际进入了新会话，未保持最初会话连续性。用户要求控制 token 消耗后，停止新增模型调用，保留上述问题待后续处理。


## 已批准后续修复的执行记录

- Pulse 已接通普通工作 run 的 maxModelCalls 持久化与恢复；审批/内部 provider 重试累计尚未完成，不能称为全部预算闭环。类型检查、原预算定向测试与普通 run 配置落盘检查通过。
- 用户明确允许 Codex 仅修复阻断问题后交回 Pulse。Codex 修复工具证据去重（含参数、忽略命令耗时）、普通实现任务持续只读的纠正与止损、合法分页豁免；49 项相关定向测试与类型检查通过。真实开发 run 已在 9 次与 6 次调用时按 INVESTIGATION_LIMIT_REACHED 停止，未自动续跑。
- Codex 同时修复已确认的费用控制参数透传缺口：活动模型目录此前覆盖 CLI 显式输出/思考上限。新增路由回归通过；cli-config 测试发现既有内置技能列表断言过时，待 Pulse 更新。
- Pulse 已分别修复所有阶段 passed 但 finalReview.not_met 时的自动重规划，以及宿主证据无效时的无动作重规划；同步调整了旧计数断言，控制器 60 项已全部通过。
- Pulse 已修改确认前 git status --short --branch 放行与复合命令拒绝，8 条直接检查通过；尚未补充持久测试用例。
- 开发终端输入曾卡住；确认无活动 run 后只重启本轮进程，继续 conv-a737a0d6-a98b-44af-b692-70d477161482。
- 本轮最多两次真实 DeepSeek 产品验收尚未开始；正在使用本地检查与隔离的开发修复 run。恢复、审批和完整累计预算仍未完成。


## 本轮收尾状态（部分完成）

最后一个开发 run `run-7b0fc810-97a1-476d-b86d-afd4a9cf34b6` 达到 16 次调用，下一次请求以 `TASK_MODEL_CALL_BUDGET_EXHAUSTED` 被阻断；此后没有启动新模型 run。该 run 只成功暂存了计数器文件的 begin，15 次后续提案都把超过 2048 字节的内容当作 append，未真正执行，因此 `packages/server/src/model-budget.ts` 不存在，暂存证据保留。

Codex 在用户明确允许的阻断修复范围内，另补了编辑纠正次数上限：连续 3 次过大或无效编辑提案、其间无成功编辑或用户回答时停止；参数变化不再重置次数。模拟复现现已在 4 次模型响应后停止，仅执行 begin，未执行非法 append。这个追加修复只做本地验证，没有再让真实模型重试。

### 已验证

- 7 个相关测试文件、128 项定向测试全部通过，类型检查及 git diff --check 通过。
- 完整本地测试（脚本排除 tests/live）1033 项通过、2 项超时：H5 配对接口与超大目录遍历。对这两个文件串行定向复跑，30 项全部通过。完整并行测试并非一次全绿，超时根因尚未确认。日志：`.pulse-dev/full-test-20261014.log` 与 `.pulse-dev/timeout-recheck-20261014.log`。
- 恢复的本地模拟检查：相同 conversation/run/effect ID，题目与 [暂不执行, 执行] 顺序保留；选择暂不执行后正常结束；无效显式 ID 被拒绝且未创建新会话。证据项目 `/private/tmp/pulse-resume-acceptance-yjQywY`。该检查验证 Host 与 CLI 选择入口，不能替代真实终端验收。
- 确认前命令 8 条输入检查通过，覆盖 --branch 两种顺序、复合命令及危险命令拒绝。

### 尚未完成

- 审批对必要检查命令的误拒绝，以及被拒后等价命令重复尝试的抑制，尚未修改。
- 审批、provider 内部重试、前置模型的统一持久化累计预算，尚未闭环；本轮只完成普通工作 run 的原有预算接线。
- 已验收工作在继续/压缩/恢复后的全面回归没有全部补齐；现有控制器与恢复检查只证明对应场景。
- 本轮计划限定的两次真实 DeepSeek 产品验收均未开始（0/2），原因是开发 run 已触达预算并停止。没有把上一轮通过的验收算作本轮结果。
- 未提交、推送或发布，保留所有原有未提交改动。

### 本轮开发调用记录

以下是每个 run 的 usage.modelCalls 记录，包含失败的小批；不是“总共只用了 16 次”。被取消的在途请求可能没有完整 usage，因此这些数字不等于最终账单。完整数据在 `.pulse-dev/repair-run-audit-20261014.json`。

| 本地开始时间 | run ID | 记录调用数 | 结果 |
| --- | --- | ---: | --- |
| 17:03:58 | `run-b88655e3-a64a-47a4-8475-d59450137dce` | 13 | MAX_TURNS_REACHED |
| 17:10:59 | `run-b55041a4-8886-4fc7-b7f6-606137f3dd56` | 13 | MAX_TURNS_REACHED |
| 17:23:12 | `run-b34e1fba-91f1-4bf6-b598-5bc1040a27db` | 9 | INVESTIGATION_LIMIT_REACHED |
| 17:28:47 | `run-c0e211bf-bde6-495b-8ec4-5477d6f6bac8` | 6 | INVESTIGATION_LIMIT_REACHED |
| 17:33:39 | `run-834fe7c3-c5dd-4c20-bbfb-4f6152d67f62` | 4 | succeeded |
| 17:35:25 | `run-c236185b-ee4e-470b-b535-cf528ddf83e3` | 6 | INVESTIGATION_LIMIT_REACHED |
| 17:36:56 | `run-5c56feaa-b46c-49c1-a12f-3d525d618ff1` | 6 | succeeded |
| 17:38:02 | `run-46cc97d7-b6cb-4635-9adc-6e39546c95c0` | 5 | succeeded |
| 17:40:16 | `run-f841b2f8-8548-4988-9142-2007ac281d59` | 6 | succeeded |
| 17:41:41 | `run-2c17bb0c-8a16-4f56-9f10-ffec91ac8aac` | 7 | OUTPUT_TRUNCATED |
| 17:45:24 | `run-2c06aa48-ea3d-417f-a2f6-035a2cbe5eb5` | 4 | succeeded |
| 17:47:07 | `run-db67b884-fddb-48cd-b35c-0e6d0df2f029` | 7 | succeeded |
| 17:50:18 | `run-8a038b8c-7935-4448-8bbf-72c82b401dbe` | 5 | succeeded |
| 17:53:35 | `run-5f72d6db-9403-45c6-b2e8-eb4a874ea67f` | 4 | OUTPUT_TRUNCATED |
| 17:57:05 | `run-7b0fc810-97a1-476d-b86d-afd4a9cf34b6` | 16 | TASK_MODEL_CALL_BUDGET_EXHAUSTED |

合计记录 111 次调用；费用字段为空，未估算金额。

## 用户要求继续后的进展（18:24 起，仍为部分完成）

复用开发会话 `conv-a737a0d6-a98b-44af-b692-70d477161482`，由 Pulse CLI 继续修改产品代码。Codex 提取现有源码片段、运行独立检查并记录结果。本次没有扩大 Codex 的产品实现权限，也没有提交、推送、发布或修改正式配置。

### 新增代码与实际生效范围

- Pulse 取回并完成上轮未提交的草稿，生成 `packages/server/src/model-budget.ts`。预留前持久化计数、串行并发预留、重开保留原额度和计数、损坏拒绝恢复、写入失败不增加内存计数均通过独立本地检查。
- Pulse 在 provider executor 增加请求前钩子，在 OpenAICompatibleAdapter 的 reasoning 参数降级重试前增加钩子。模拟检查证明共用预算对象的两个 executor 不会绕过额度；内部重试可以在第二次请求前被阻断。
- Pulse 在 front-model 增加请求前钩子，并让预算耗尽错误穿透启发式降级。
- **Host 尚未创建和传递该预算对象，尚未更新恢复、审批和 usage 接线。上述模块与可选钩子不能视为累计预算产品功能已修好。**

### 保留的失败证据

- 独立无模型检查 10 项，9 项通过，1 项失败：front-model 调用 adapter.executeAttempt 时没有传递 beforeRetryAttempt。模拟 reasoning 参数拒绝会产生两次 fetch，预留钩子仅执行一次。失败检查保留，未放宽断言。脚本 `.pulse-dev/verify-budget-continuation.mjs`，结果 `.pulse-dev/budget-continuation-checks.json`。
- 开发 run `run-95a0c4ee-fc58-49ee-a9e1-e451315b701a` 在 16 次实际记录调用后停止。虽然输入已附源码片段和完整 hash，Pulse 仍反复读取接线窗口；合法分页被视为进展，现有循环防护没有阻止这种调查消耗。运行中发送纠正还产生了同时在途的模型效果；没有另开开发 run 绕过额度。
- 本次 usage 记录输入 612550 token（其中缓存 475392）、输出 31524（其中 reasoning 25845），modelCalls=16；费用字段为空。这是本次新增消耗，与前一节的 111 次开发调用分开计算。两个被预算拦截的 LLM 效果不计入这 16 次。脱敏审计 `.pulse-dev/continuation-audit-20261014.json`。

### 本地验证与后续入口

- 类型构建和 `git diff --check` 通过；7 个定向回归文件、162 项测试通过，日志 `.pulse-dev/continuation-targeted-20261014.log`。这些既有回归未覆盖未接通的 Host 累计预算，不能抵消上述失败。
- 完整本地检查使用 `pnpm test --maxWorkers 2 --minWorkers 1`：134 个文件、1035 项全部通过，耗时 79.52 秒，日志 `.pulse-dev/continuation-full-20261014.log`。上轮两个超时在此次降低并发的完整执行中未复现；默认并发下超时根因仍不能据此认定已修复。
- 下一步应先在 Host 新 run/front-model/普通执行/恢复/自动审批/本地审批入口共用持久化预算，再补齐 front-model 的内部重试钩子与准确 usage；随后处理必要检查审批误拒绝和被拒后的等价重试。不要再次重做已完成阶段或模块。
- 真实 DeepSeek 产品验收仍为 0/2，未启动额外验收；本次开发 CLI 已在确认无活动 run 后正常退出，同一会话历史保留。

## Codex 直接修复后的结果（用户更改执行方式后）

用户明确要求“你来进行这些问题的优化，不要用pulse cli了”。本节由 Codex 直接实现和验证；没有启动 Pulse CLI 开发进程，也没有新增真实模型调用。之前各节保留为历史记录，以下为当前代码状态。

### 已修复

| 问题 | 根因与修改 | 当前证据 |
| --- | --- | --- |
| 累计预算未生效、漏计请求 | 原先只计算主 Runtime 效果； detached 审批、前置模型、provider 内部重试和启动前历史压缩都能绕过。现由同一 run 的持久化 ModelAttemptBudget 在 provider 请求前串行预留；恢复优先读取原 limit/used。自动压缩也共享额度，手动压缩使用独立的有界操作额度。 | model-budget、host-model-budget 回归覆盖并发预留、内部重试、前置模型、自动安全审核、本地 Ollama 审批、压缩及冷恢复；实际模拟请求达上限后不再发送。 |
| 预算错误丢码、失败请求虚增 usage | 宿主独立 LLM 调用此前只保留错误文案；失败的模型准入元数据也可能被当成调用。现在传递预算错误码，以持久计数生成 usage；缺失 token 数据时标记 partial/unavailable。前置澄清短路和 Runtime 启动前耗尽也保存 usage/失败 run。 | 额度 4 时实际模拟请求和 usage 都为 4；自动压缩耗尽后保留原历史及失败记录，不存在可自动恢复的新运行。 |
| 必要验证误拒绝 | 所有 shell 调用进入模型审批；此外原有路径检查没有 await。新增任务授权和规范化工作区路径检查，只直接允许严格形式的 node --check、指定测试文件、指定 Vitest 检查、简单项目测试/类型脚本。拒绝 node -e、额外执行参数、越界/敏感路径、复合命令及生命周期钩子；其他操作继续原审批流程。 | verification-policy 22 项；真实本地 node --check 在自动审批和本地审批入口均执行成功；未调用审核模型。 |
| 拒绝后换等价命令重试 | ReAct 把拒绝当普通失败反馈给模型，控制器父阶段还能重新规划。现在拒绝、取消和自动审核不可用会停止当前运行；Host 同时阻止父阶段或其他后续模型/工具再次绕过。网络原因只保留允许的脱敏代码。 | 参数化 ReAct 回归只发生 1 次模型响应和 1 次工具操作；Host 控制器拒绝场景只发生计划、执行提案和审核共 3 次模拟请求，没有第二次 shell 操作；ENOTFOUND 被保留且敏感 URL 不出现。 |
| 无关修改导致完成阶段全部重开 | 旧 validateCheckpoint 要求整个工作区摘要完全一致。新增每阶段文件证据哈希，只失效引用已变化文件的阶段及其依赖，独立阶段保留；shell/外部检查继续要求新证据。 | task-efficiency 覆盖无关文件变化、单阶段证据失效、依赖传播及连续检查点复用；原控制器负向证据测试保持通过。 |
| 非流式计划预览缺失、重启后丢失 | 带 ask.choice 的正文没有流式 delta 时，在最终确认前不会作为消息发布。现在在最终选择题之前，依据成功写入回执核对文件哈希，展示并持久化实际保存的计划。 | 新增 grill-and-plan-workflow 两条路径：先读项目、开放式访谈、询问已有同名计划、保存并预览超过 5 KB 的计划、发生历史压缩、在最终选择处冷重启，恢复同一问题和安全选项顺序，明确执行后才创建实现文件。 |
| 显式恢复 ID 不存在时诊断不清 | 为不存在的显式会话返回 CONVERSATION_NOT_FOUND 和中文提示；非法路径仍拒绝，不创建替代会话。 | cli-commands 验证有效 ID、缺失 ID、非法 ID，以及会话数量保持不变。 |

### 最终本地验证

- `pnpm exec tsc -b --pretty false`：通过。
- `git diff --check`：通过。
- 最终代码固定后的 `pnpm test --maxWorkers 2 --minWorkers 1`：**138 个文件、1087 项全部通过**，耗时 80.56 秒。日志 `.pulse-dev/codex-final-full-20261014.log`。
- 自动压缩预算追加修复后的定向回归：4 个文件、95 项通过。日志 `.pulse-dev/codex-final-targeted-20261014.log`。
- 原先失败的前置模型内部重试预留断言已纳入 `tests/model-budget.test.ts`，没有放宽断言，现通过。
- 技能两条流程使用模拟模型和真实 Host、文件系统、持久化恢复；本地语法检查使用真实 Node。它们不能等同于新的真实 DeepSeek 或原生终端键盘验收。

### 验证边界

- 本轮真实模型调用 **0**；此前计划的两次真实 DeepSeek 产品验收仍为 0/2，未消耗额外验收次数。正式配置、已安装版本和常驻服务没有部署或重启。
- 预算在请求前持久化；若进程恰好在预留后、发送前崩溃，该次额度会保守占用，不会重新授予。调用额度不能当作供应商账单。
- 新运行及其恢复拥有完整预算账本。没有账本的旧快照使用原有已记录/已准入尝试保守初始化；旧版本未记录的内部请求不能事后精确重建。旧检查点无法按阶段归属文件时继续采用较保守的引用文件校验。
- 全量测试降低了并发；没有据此认定默认高并发时的历史超时根因已经修复。
- 保留全部原有未提交改动；未提交、推送或发布。
