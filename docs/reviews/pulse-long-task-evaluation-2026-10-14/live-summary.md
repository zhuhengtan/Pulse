# 六例真实 DeepSeek 长任务评估

执行日期：2026-10-15。模型：`deepseek/deepseek-flash`。修复后的Pulse Host驱动初次冻结的历史维护场景；没有使用Pulse CLI开发或在测试中修复产品来刷新分数。

## 结论

**在每例最多16次实际模型调用的约束下，当前长流程交付能力不足。**五个正常执行的场景都在预算耗尽时未完成整体需求，其中只有批量恢复场景留下一个可独立使用的辅助模块。访谈场景受到评估脚本误选和主动取消影响，不能归为Pulse失败。

这不是网络故障：93次生成请求全部HTTP 200。费用限额与明确失败提示正常工作，但独立阶段调查、进度审查、分块文件操作消耗了大量额度，实际产物不足。这个结论只适用于本轮任务/模型/预算组合；没有测试提高预算是否能改善，也没有证明其他模型或几十小时任务的表现。

| 场景 | effort | 请求 | Runtime | 独立结论 | 分数 | 实际交付 |
|---|---|---:|---|---|---:|---|
| [LT01 模型配置/预算入口](LT01.md) | low | 16 | failed | failed | 10 | 35行不完整JS，runner/README未改 |
| [LT02 批量恢复](LT02.md) | high | 16 | failed | partial | 34 | 队列辅助模块通过探针，未接入runner |
| [LT03 历史数据核算](LT03.md) | low | 16 | failed | failed | 10 | 44行不完整JS，没有数据结果或报告 |
| [LT04 技术研究](LT04.md) | high | 16 | failed | failed | 10 | 44次工具操作，没有研究报告 |
| [LT05 中英文文档维护](LT05.md) | low | 16 | failed | failed | 10 | 原文档无修改，没有维护报告 |
| [LT06 访谈与计划恢复](LT06.md) | high | 13 | cancelled | blocked_env（评估侧） | 不评分 | 同名原件保留，计划/最终确认/冷恢复未触发 |

最终评分是按[预先冻结规则](rubric.md)做的独立人工验收；机械provisional分不作为结论。部分文件原来就存在，不能算本次交付；语法错误导致负向样例非0退出，也不能算“正确拒绝冲突”。

## 调用和token账本

- **93/96次实际生成调用**，六例分别16/16/16/16/16/13，没有重跑。88次主执行/控制器调用、5次自动安全审批调用。没有自动增加run或额度。
- 93条请求预留、93条HTTP 200响应、Host usage、每run预算文件一致；input/output token逐例与API响应重新合计一致。
- 输入 **1,106,516 tokens**，其中缓存输入 **733,696**；输出 **104,182 tokens**，其中推理 **81,834**。推理已包含在输出内，不能再次相加计费。
- 价格没有冻结，API没有返回可核对账单金额，六例providerCosts都为空；金额保持未知。
- Host执行时长合计697,367ms，约11分37秒。不是多小时稳定性或性能基准。

原始对账：[live-summary.json](/Users/zhuhengtan/projects/Pulse/.pulse-dev/long-task-eval-20261015/live-summary.json)、[budget.json](/Users/zhuhengtan/projects/Pulse/.pulse-dev/long-task-eval-20261015/budget.json)。

## 主要问题与证据

1. **预算与阶段计划不匹配**：LT01前9次、LT02前10次、LT03前9次、LT05前12次请求只用于计划/调查/审查等前置流程；实现和验收余量不足。五阶段的多次模型审查在16次总额度下开销过大。
2. **半成品文件被提交**：LT01/03都是begin→inspect→commit，没有append；提交初始1443/1414字节，外部实际执行报Unexpected end of input。没有API截断证据，不能归因于provider输出length。
3. **失败worker诊断没有完整回收**：LT02失败stage-2的modelCalls仍为0/evidenceRefs为空，尽管已执行模型并写文件；根账本没有漏计。onJoin的异常分支在合并前continue。
4. **跨阶段证据复用不足**：LT05修改worker重读调查阶段相同文档4次；研究LT04则重复0次仍没有报告，说明重复检测无法单独解决交付饥饿。
5. **评估脚本也有问题**：LT06选项正则误选路径，basis与实际答案不一致；未识别已确认的报告布局后主动取消。该例不评分，也不声称真模计划保存/预览/冷恢复通过。

详细根因、置信边界、影响和回归建议见[问题台账](live-problems.md)；下一批实施顺序见[优化方案](next-optimization-plan.md)。建议先做离线轨迹复现，优先修预算感知的计划/调度、失败worker结算、草稿提交与评估选项映射，再安排新的有上限复测。

## 过程与保留范围

- [逐请求时间线、阶段与工具证据](process.md)
- [真实运行日志](/Users/zhuhengtan/projects/Pulse/.pulse-dev/long-task-real-20261015.log)
- [修复后Host源码/编译产物哈希](/Users/zhuhengtan/projects/Pulse/.pulse-dev/long-task-eval-20261015/driver-provenance.json)
- [六例诊断汇总](/Users/zhuhengtan/projects/Pulse/.pulse-dev/long-task-eval-20261015/diagnostics.json)

评估前后server/runtime/adapters源码及250个编译文件哈希一致，原未提交产品改动保留。模型只修改隔离副本；新增评估诊断和报告文件单独保留。没有提交、推送、发布或重启常驻服务。

low/high各三个任务不同、每个仅一次；本轮不支持档位因果优劣或稳定成功率判断。第6例是评估侧阻断，不能计为Pulse失败；真模冷恢复及最终“否/是”路径仍未验证。
