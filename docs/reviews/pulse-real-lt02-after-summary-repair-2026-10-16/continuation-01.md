# LT02 原会话续跑与代审接入（2026-10-16）

## 结果

**已恢复原会话继续执行，任务仍未完成。本次新增19次请求，累计49次；18次有完整用量，第49次收到HTTP200头后触发单请求TimeoutError。独立恢复验收仍7/9，没有新补丁落盘。**

续跑墙钟790.206秒。网络失败后停止，未再追加运行。Runtime succeeded仅表示安全收尾，业务incomplete。旧30次运行结果与评分未覆盖。

## 恢复与授权

用户原话：“你就是人工啊，后续的测试你来代替我做出审批，这次测试你恢复上次对话，继续工作”。因此允许必要操作再次提出并由Codex逐项审查，旧拒绝证据保留。

原run已终态、manifest无activeRunId，无法恢复等待中的审批；通过正式sendMessage(text=继续, continueTask=true)进入同一会话的新run，未编辑Runtime存储伪造恢复。

- 会话：`conv-a0a0d880-76ac-40f9-bfa4-a2c052eab33a`，保持一致。
- 原run：`run-2c587a00-519f-4665-a2e5-7c78e197d4e1`。
- 续跑run：`run-3e15f55f-15ae-4bbd-a48b-5a7a4afb23af`，TaskRecord继承原任务。
- 原工作目录和产物保留。原检查点reusableIds为空，没有可直接复用阶段；本次重新花7次工作请求做核对，缺陷仍存在。
- 额外评测次数/总时长限制未设；累计产品256保护保留，原30次不重置，新run剩余226。正式模型单次输出16384及180秒网络超时仍保留。

## 人工审批方式与实际覆盖

新的监督驱动将原生审批卡片保存并暂停，等待Codex检查准确命令、脚本/依赖、工作区及网络/凭据边界；决定包含runId、effectId、inputHash和理由，回复前再次核对待审批内容，通过原生run.reply提交。没有一律通过，也没有改产品安全规则。

**本次没有产生新的审批卡片，实际审批0次。** 因模型先发生输出截断及超时，此次不能证明“代审通过后继续执行”的真实路径；后续测试继续按用户授权由Codex逐项代审。

## 执行过程

| 阶段 | 状态 | 尝试 | 工作请求 |
|---|---|---:|---:|
| S1 | passed | 1 | 7 |
| S2 | blocked | 3 | 5 |
| S3 | blocked | 0 | 0 |
| S4 | blocked | 0 | 0 |
| S5 | blocked | 0 | 0 |

始终lane-1。S1定位了重复汇总、未知费用继承、原夹具覆盖；S2前三次请求用完输出额度且只返回推理内容，没有工具调用。有界重试后请求47仍截断；49流超时终止。没有回放原写操作，也没有声称补丁已执行。

[逐请求过程](/Users/zhuhengtan/projects/Pulse/docs/reviews/pulse-real-lt02-after-summary-repair-2026-10-16/continuation-01-process.md)。

## 新暴露问题与优化顺序

1. **P1：同会话续做缺少可复用证据。** 旧五个passed阶段但checkpoint reusableIds=[]。文件版本变化、shell检查不缓存及依赖级联使可复用列表为空；即使已提供明确失败位置，仍重新核对7次。应分开保存可复用代码事实和需要新跑的检查，定向失效，避免整链退回调查。
2. **P1：纯推理截断恢复没有产出进展。** 四次length分别为41/42/43/47，合计65536输出token，前三次可见正文0。纠正提示与阶段重试未带来有效小补丁。应对纯推理耗尽设置明确的无进展诊断和单一最小动作恢复，不能只重复相同输入或把工具提议当执行。
3. **P2：压缩在无任务进展时连续发生。** 同lane连续三次压缩，后续又一次；均返回有效纯文本，但没有中间工具交付。应检测“已有摘要+纯截断响应”的重复压缩收益，保留计数与失败上下文，避免仅以压缩视为任务进展。
4. **P1：用量truncationEvents仍为0。** 原始响应明确4次finish=length，Host报告却0。应按原始finish原因及唯一请求回执计数，并覆盖归档/恢复；不能只统计文本裁剪。
5. **P1：评测停止原因漏识别。** 已保存的完整结果有未知用量1次、阶段PROVIDER_NETWORK_ERROR(TimeoutError)，但evaluationBlockReason(result)返回null，因为Runtime安全收尾为succeeded且已知总量是数字。应读取业务/阶段的阻塞原因和字段完整性，避免多案例监督器错误继续烧后续样本。本次专用驱动只有这一个续跑，没有继续其他案例。
6. **P2：非审批阻塞时早期候选正文仍混入最终结果。** 本次最终正文拼入“我先做一次定向检索……”的早期阶段文字，同时同组失败重复八次。审批拒绝分支的修复尚未覆盖网络/截断等所有终止路径；最终报告应统一使用当前控制器状态，逐断言归因、共享详情只展示一次。

上述为本次真实轨迹及本地只读诊断证据，不宣称已修复。三个候选恢复语义缺陷仍未解决，独立7/9保持失败。

## 用量对账

| 字段 | 原始已知18次 | Host已知18次 |
|---|---:|---:|
| inputTokens | 470578 | 470578 |
| outputTokens | 93027 | 93027 |
| cachedInputTokens | 188416 | 188416 |
| uncachedInputTokens | 282162 | 282162 |
| reasoningTokens | 83814 | 83814 |
| visibleOutputChars | 16189 | 16189 |
| latencyMs | 514736 | 515486 |

本次已知token 563605，累计已知token 1797468。第49次最终用量未知，不填零；18个唯一回执，所有字段known=18/total=19，完整性partial。Host与HTTP延迟边界不同。原始可见字符与Host已知总数一致；截断片段不作为工具执行事实。费用未知。

[完整对账](/Users/zhuhengtan/projects/Pulse/.pulse-dev/long-task-eval-round12-lt02-repaired-20261016/continuation-01/usage-reconciliation.json) / [停止诊断](/Users/zhuhengtan/projects/Pulse/.pulse-dev/long-task-eval-round12-lt02-repaired-20261016/continuation-01/supervisor-block-diagnostic.json)。

## 完整性与验证边界

原run所有文件、主工作区既有文件和编译引擎无漂移；原会话消息前缀保留，manifest合法新增一个run。候选文件与续跑前完全一致，新增代码0。独立冻结9项再次执行，仍两项失败；本轮没有运行候选端到端检查，没有实际人工审批通过，不属于CLI键盘/安装包/跨平台验收。

未提交、推送、发布或重启正式服务。原始证据保留于 [续跑目录](/Users/zhuhengtan/projects/Pulse/.pulse-dev/long-task-eval-round12-lt02-repaired-20261016/continuation-01)；[真实结果](/Users/zhuhengtan/projects/Pulse/.pulse-dev/long-task-eval-round12-lt02-repaired-20261016/continuation-01/LT02/result.json) / [实际评分](/Users/zhuhengtan/projects/Pulse/.pulse-dev/long-task-eval-round12-lt02-repaired-20261016/continuation-01/LT02/grade.json) / [完整性](/Users/zhuhengtan/projects/Pulse/.pulse-dev/long-task-eval-round12-lt02-repaired-20261016/continuation-01/post-run-integrity.json)。
