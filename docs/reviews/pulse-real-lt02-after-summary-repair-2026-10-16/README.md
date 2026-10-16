# LT02 修复后唯一一次真实测试（2026-10-16）

## 结果

**任务未完成。30次真实请求均HTTP200，耗时351.420秒（5分51秒），独立恢复验收7/9，与上轮相同。没有追加真实运行。**

Runtime `succeeded` 表示拒绝后安全收尾成功；业务 `taskOutcome.status=incomplete`，不代表需求完成。第六阶段被人工审批拒绝阻断，另有两个独立业务断言失败。本次不是预算耗尽：评测额外次数、token、费用、总时长限制均未设置；产品256次上限、180秒单请求超时、审批及循环保护保留。

模型为 `deepseek/deepseek-flash`，API `deepseek-flash`，high；使用当前已编译开发 Host/Runtime，原始缺陷任务副本。用户已明确授权必需的非公开源码/脱敏资料到 `https://api.deepseek.com`；正式配置/凭据仅本地路由和鉴权，不作为模型输入。

## 与上轮相比

| 项目 | 上轮 | 本轮 |
|---|---:|---:|
| 请求 | 30/32 | 30，无额外上限 |
| 墙钟 | 573.043秒 | 351.420秒 |
| token | 1191180 | 1233863 |
| 独立恢复断言 | 7/9 | 7/9 |
| 压缩 | 两次空正文工具提议 | 一次纯文本摘要，无工具提议 |
| 拒绝后收尾 | 最终验收被审批错误再次阻断 | 冻结检查及确定性报告完成，零追加请求 |
| 已知失败展示 | 漏列 | 展示，但重复八次、标准归因过粗 |
| 重复汇总/未知费用继承 | 失败/失败 | 失败/失败 |

耗时下降、token略升；这是单次样本，不能推出稳定成功率。评分器临时91分包含产物/依赖检查，且本轮额外预算项不适用；不能把它与此前有预算惩罚的81分直接比较，也不能称91%完成。

## 为什么停止

第30次模型提议 `node scripts/eval/.verify-resume/make-dataset.mjs`，此任意Node准备脚本未在必要检查规则内。评测未配置本地reviewer，转原生人工确认，评测按无blanket approval规则拒绝。后续两个git只读提议也未执行，继承同一拒绝错误；不是三次独立审核，也没有等价重试。

修复后的控制器正确停止工作并执行冻结的九项独立只读检查，不再尝试被全局拒绝状态阻断的最终模型请求。第六阶段 blocked，其余五阶段的已完成证据保留。**本轮仍缺少在产品工作路径内完成的端到端验收，而且候选自身仍有业务缺陷。**

[问题与优化顺序](/Users/zhuhengtan/projects/Pulse/docs/reviews/pulse-real-lt02-after-summary-repair-2026-10-16/problems.md)详细记录根因：重复终态汇总、未知费用继承、新发现的原夹具覆盖、最终报告重复/归因，以及检查准备入口的审批边界。

## 阶段与过程

| 阶段 | 类型 | 状态 | lane | 独立候选 |
|---|---|---|---|---|
| stage-1 | analyze | passed | lane-1 | result-19 |
| stage-2 | edit | passed | lane-1 | result-23 |
| stage-3 | edit | passed | lane-1 | result-35 |
| stage-4 | verify | passed | lane-1 | result-46 |
| stage-5 | edit | passed | lane-1 | result-55 |
| stage-6 | verify | blocked | lane-1 | result-67 |

六阶段各一次，重规划0。30次请求按Runtime分类为规划1、工作22、纠偏1、阶段验收5、压缩1；无最终模型验收请求、无主DeepSeek审批请求。

[逐请求过程](/Users/zhuhengtan/projects/Pulse/docs/reviews/pulse-real-lt02-after-summary-repair-2026-10-16/process.md) / [验收矩阵](/Users/zhuhengtan/projects/Pulse/docs/reviews/pulse-real-lt02-after-summary-repair-2026-10-16/matrix.md)。

## 停止后的离线诊断

在新的离线副本中，仅保留PATH/TMPDIR环境，使用已检查的本地假CLI，生成调用0。候选自己的模块8项加端到端5项共13/13通过；仍不覆盖两个独立失败。先前一次离线准备漏建输出父目录，已保留失败日志，随后在新的诊断目录补齐测试前置；这不是产品运行或真实模型重试。

另加的待恢复trial原夹具探针失败：已有用户修改被初始fixture覆盖。该诊断未修改真实候选、未改冻结9项评分。

[完整离线诊断](/Users/zhuhengtan/projects/Pulse/.pulse-dev/long-task-eval-round12-lt02-repaired-20261016/candidate-offline-tests-complete/result.json)；[首次离线准备错误日志](/Users/zhuhengtan/projects/Pulse/.pulse-dev/long-task-eval-round12-lt02-repaired-20261016/candidate-offline-tests/first.log)。

## 用量与完整性

| 字段 | HTTP原始统计 | Host账本 |
|---|---:|---:|
| inputTokens | 1180320 | 1180320 |
| outputTokens | 53543 | 53543 |
| cachedInputTokens | 799104 | 799104 |
| uncachedInputTokens | 381216 | 381216 |
| reasoningTokens | 42063 | 42063 |
| visibleOutputChars | 9231 | 9231 |
| latencyMs | 303720 | 305786 |

总token **1233863**，30个usageReceipt唯一，全部字段已知计数30。可见输出字符完全一致；HTTP累计延迟303720ms、Host305786ms，计时边界不同。没有价格信息，费用未知，未填零。

冻结输入502文件、引擎/驱动308文件；原始runner/README与上轮输入哈希相同，没有预放修好后的resume答案。输入凭据值扫描0匹配。运行前后主工作区既有文件、冻结输入、冻结引擎、旧round11现场均无漂移，HEAD未变。正式7330/7331/7332服务PID仍为39969/39970/26777，未重启。

候选只改8个任务文件；本轮Codex只新增诊断记录和报告，未修改功能源码、提交、推送或发布。

## 原始证据

- [真实结果](/Users/zhuhengtan/projects/Pulse/.pulse-dev/long-task-eval-round12-lt02-repaired-20261016/LT02/result.json) / [实际独立评分器](/Users/zhuhengtan/projects/Pulse/.pulse-dev/long-task-eval-round12-lt02-repaired-20261016/LT02/grade.json)。
- [请求记录](/Users/zhuhengtan/projects/Pulse/.pulse-dev/long-task-eval-round12-lt02-repaired-20261016/LT02/attempts.jsonl) / [运行事件](/Users/zhuhengtan/projects/Pulse/.pulse-dev/long-task-eval-round12-lt02-repaired-20261016/LT02/events.jsonl)。
- [阶段和冻结检查](/Users/zhuhengtan/projects/Pulse/.pulse-dev/long-task-eval-round12-lt02-repaired-20261016/LT02/data/conversations/conv-a0a0d880-76ac-40f9-bfa4-a2c052eab33a/runs/run-2c587a00-519f-4665-a2e5-7c78e197d4e1/task-controller.json) / [业务结果](/Users/zhuhengtan/projects/Pulse/.pulse-dev/long-task-eval-round12-lt02-repaired-20261016/LT02/data/conversations/conv-a0a0d880-76ac-40f9-bfa4-a2c052eab33a/runs/run-2c587a00-519f-4665-a2e5-7c78e197d4e1/task-outcome.json)。
- [逐请求结构记录](/Users/zhuhengtan/projects/Pulse/.pulse-dev/long-task-eval-round12-lt02-repaired-20261016/request-process.json) / [压缩验证](/Users/zhuhengtan/projects/Pulse/.pulse-dev/long-task-eval-round12-lt02-repaired-20261016/compaction-validation.json)。
- [用量对账](/Users/zhuhengtan/projects/Pulse/.pulse-dev/long-task-eval-round12-lt02-repaired-20261016/usage-reconciliation.json) / [完整性](/Users/zhuhengtan/projects/Pulse/.pulse-dev/long-task-eval-round12-lt02-repaired-20261016/post-run-integrity.json)。

后续建议先补齐本地边界和可执行的离线检查入口，再决定是否真实重跑。本轮已经停止，没有自动增加调用。
