# 证据与复现

## 本轮原始记录

- [冻结输入与规则](/Users/zhuhengtan/projects/Pulse/.pulse-dev/long-task-eval-round4-20261015/frozen.json)
- [无模型连通检查](/Users/zhuhengtan/projects/Pulse/.pulse-dev/long-task-eval-round4-20261015/preflight.json)
- [预算账本](/Users/zhuhengtan/projects/Pulse/.pulse-dev/long-task-eval-round4-20261015/budget.json)
- [冻结驱动溯源](/Users/zhuhengtan/projects/Pulse/.pulse-dev/long-task-eval-round4-20261015/driver-provenance.json)
- [最终哈希与账本审计](/Users/zhuhengtan/projects/Pulse/.pulse-dev/long-task-eval-round4-20261015/final-audit.json)
- [逐例诊断](/Users/zhuhengtan/projects/Pulse/.pulse-dev/long-task-eval-round4-20261015/diagnostics.json)

- LT01：[请求](/Users/zhuhengtan/projects/Pulse/.pulse-dev/long-task-eval-round4-20261015/LT01/attempts.jsonl)、[事件](/Users/zhuhengtan/projects/Pulse/.pulse-dev/long-task-eval-round4-20261015/LT01/events.jsonl)、[独立评审](/Users/zhuhengtan/projects/Pulse/.pulse-dev/long-task-eval-round4-20261015/LT01/review.json)、[自动检查](/Users/zhuhengtan/projects/Pulse/.pulse-dev/long-task-eval-round4-20261015/LT01/grade.json)
- LT02：[请求](/Users/zhuhengtan/projects/Pulse/.pulse-dev/long-task-eval-round4-20261015/LT02/attempts.jsonl)、[事件](/Users/zhuhengtan/projects/Pulse/.pulse-dev/long-task-eval-round4-20261015/LT02/events.jsonl)、[独立评审](/Users/zhuhengtan/projects/Pulse/.pulse-dev/long-task-eval-round4-20261015/LT02/review.json)、[自动检查](/Users/zhuhengtan/projects/Pulse/.pulse-dev/long-task-eval-round4-20261015/LT02/grade.json)
- LT03：[请求](/Users/zhuhengtan/projects/Pulse/.pulse-dev/long-task-eval-round4-20261015/LT03/attempts.jsonl)、[事件](/Users/zhuhengtan/projects/Pulse/.pulse-dev/long-task-eval-round4-20261015/LT03/events.jsonl)、[独立评审](/Users/zhuhengtan/projects/Pulse/.pulse-dev/long-task-eval-round4-20261015/LT03/review.json)、[自动检查](/Users/zhuhengtan/projects/Pulse/.pulse-dev/long-task-eval-round4-20261015/LT03/grade.json)
- LT04：[请求](/Users/zhuhengtan/projects/Pulse/.pulse-dev/long-task-eval-round4-20261015/LT04/attempts.jsonl)、[事件](/Users/zhuhengtan/projects/Pulse/.pulse-dev/long-task-eval-round4-20261015/LT04/events.jsonl)、[独立评审](/Users/zhuhengtan/projects/Pulse/.pulse-dev/long-task-eval-round4-20261015/LT04/review.json)、[自动检查](/Users/zhuhengtan/projects/Pulse/.pulse-dev/long-task-eval-round4-20261015/LT04/grade.json)
- LT05：[请求](/Users/zhuhengtan/projects/Pulse/.pulse-dev/long-task-eval-round4-20261015/LT05/attempts.jsonl)、[事件](/Users/zhuhengtan/projects/Pulse/.pulse-dev/long-task-eval-round4-20261015/LT05/events.jsonl)、[独立评审](/Users/zhuhengtan/projects/Pulse/.pulse-dev/long-task-eval-round4-20261015/LT05/review.json)、[自动检查](/Users/zhuhengtan/projects/Pulse/.pulse-dev/long-task-eval-round4-20261015/LT05/grade.json)
- LT06：[请求](/Users/zhuhengtan/projects/Pulse/.pulse-dev/long-task-eval-round4-20261015/LT06/attempts.jsonl)、[事件](/Users/zhuhengtan/projects/Pulse/.pulse-dev/long-task-eval-round4-20261015/LT06/events.jsonl)、[独立评审](/Users/zhuhengtan/projects/Pulse/.pulse-dev/long-task-eval-round4-20261015/LT06/review.json)、[自动检查](/Users/zhuhengtan/projects/Pulse/.pulse-dev/long-task-eval-round4-20261015/LT06/grade.json)

## LT02独立探针

- [语法检查](/Users/zhuhengtan/projects/Pulse/.pulse-dev/long-task-eval-round4-20261015/LT02/manual-probes.json)
- [直接模块断言](/Users/zhuhengtan/projects/Pulse/.pulse-dev/long-task-eval-round4-20261015/LT02/direct-module-probe.json)
- [假CLI恢复场景](/Users/zhuhengtan/projects/Pulse/.pulse-dev/long-task-eval-round4-20261015/LT02/manual-runner-probe.json)
- [历史预算超限探针](/Users/zhuhengtan/projects/Pulse/.pulse-dev/long-task-eval-round4-20261015/LT02/manual-budget-probe.json)
- [探针移出候选工作区后的保护核对](/Users/zhuhengtan/projects/Pulse/.pulse-dev/long-task-eval-round4-20261015/LT02/post-probe-preservation.json)

## LT06未完成验收现场

- [访谈原始记录](/Users/zhuhengtan/projects/Pulse/.pulse-dev/long-task-eval-round4-20261015/LT06/interactions.jsonl)
- [用户明确布局选择](/Users/zhuhengtan/projects/Pulse/.pulse-dev/long-task-eval-round4-20261015/LT06/user-layout-confirmation.json)
- [截止前待答快照](/Users/zhuhengtan/projects/Pulse/.pulse-dev/long-task-eval-round4-20261015/LT06/pre-restart-pending.json)
- [测试适配干预说明](/Users/zhuhengtan/projects/Pulse/.pulse-dev/long-task-eval-round4-20261015/LT06/manual-restore-intervention.json)
- [恢复对比（待答已被截止取消）](/Users/zhuhengtan/projects/Pulse/.pulse-dev/long-task-eval-round4-20261015/LT06/restore.json)
- [新增计划](/Users/zhuhengtan/projects/Pulse/.pulse-dev/long-task-eval-round4-20261015/LT06/workspace/docs/plans/pulse-long-task-evaluation-v2.md)

## 无模型复核命令

以下只重算已有数据，不会调用模型。grader可能创建本地检查产物，建议在副本执行。

```sh
cd /Users/zhuhengtan/projects/Pulse
node scripts/eval/long-task-grade.mjs .pulse-dev/long-task-eval-round4-20261015
node scripts/eval/long-task-diagnostics.mjs .pulse-dev/long-task-eval-round4-20261015 docs/reviews/pulse-long-task-evaluation-round4-2026-10-15
```

本轮真实测试已结束。不要重跑supervisor或修改预算文件；原数据保留，失败不加试。报告生成器输出不能替代独立语义评审。
