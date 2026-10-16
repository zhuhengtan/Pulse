# 证据与复现

## 原始记录

- [冻结输入与环境](/Users/zhuhengtan/projects/Pulse/.pulse-dev/long-task-eval-round6-20261015/frozen.json)
- [完整授权及历史审批拒绝](/Users/zhuhengtan/projects/Pulse/.pulse-dev/long-task-eval-round6-20261015/approval-block.json)
- [无生成网络预检](/Users/zhuhengtan/projects/Pulse/.pulse-dev/long-task-eval-round6-20261015/preflight.json)
- [逐请求HTTP及usage](/Users/zhuhengtan/projects/Pulse/.pulse-dev/long-task-eval-round6-20261015/LT01/attempts.jsonl)
- [Runtime事件](/Users/zhuhengtan/projects/Pulse/.pulse-dev/long-task-eval-round6-20261015/LT01/events.jsonl)
- [终态结果及持久usage](/Users/zhuhengtan/projects/Pulse/.pulse-dev/long-task-eval-round6-20261015/LT01/result.json)
- [真实外置ResultRef解析诊断](/Users/zhuhengtan/projects/Pulse/.pulse-dev/long-task-eval-round6-20261015/LT01/diagnostics-current.json)
- [独立11项验收](/Users/zhuhengtan/projects/Pulse/.pulse-dev/long-task-eval-round6-20261015/LT01/grade.json)
- [补充语义探针5/9](/Users/zhuhengtan/projects/Pulse/.pulse-dev/long-task-eval-round6-20261015/LT01/semantic-probes.json)
- [相同工具证据审计](/Users/zhuhengtan/projects/Pulse/.pulse-dev/long-task-eval-round6-20261015/LT01/repeat-audit.json)
- [工作区和驱动保留核对](/Users/zhuhengtan/projects/Pulse/.pulse-dev/long-task-eval-round6-20261015/preservation-audit.json)
- [本地完整测试1204项](/Users/zhuhengtan/projects/Pulse/.pulse-dev/lt01-repair-20261015/full-tests-final.log)
- [本地验收器28项](/Users/zhuhengtan/projects/Pulse/.pulse-dev/lt01-repair-20261015/evaluator-final.log)

诊断脚本从runtime-results按ResultRef的SHA256读取实际结果，不把缺少inline value误判为空。另存诊断移除了provider continuation及推理正文；原始Runtime现场不改动。原始HTTP记录不保存认证或推理正文。

- [逐字段用量对账](/Users/zhuhengtan/projects/Pulse/.pulse-dev/long-task-eval-round6-20261015/usage-reconciliation.json)
- [最终引用资格核对](/Users/zhuhengtan/projects/Pulse/.pulse-dev/long-task-eval-round6-20261015/LT01/citation-audit.json)

## 离线复现

运行独立验收（只增加本地探针目录，不联网、不增加模型调用）：

```sh
cd /Users/zhuhengtan/projects/Pulse
node scripts/eval/long-task-grade.mjs .pulse-dev/long-task-eval-round6-20261015
```

复合引用可直接import隔离副本中的config-budget.mjs并传`{providers:{ds:{provider:'deepseek',models:{flash:{modelCode:'deepseek-flash'}}}}}`及`ds/flash`，无需任何凭据。

补充探针脚本保留在[semantic-probes.mjs](/Users/zhuhengtan/projects/Pulse/.pulse-dev/long-task-eval-round6-20261015/semantic-probes.mjs)；它的输出目录要求不存在，历史结果保留，不原地重复覆盖。完整入口使用已准备的runner-probe副本、假CLI、真实可信artifact评分器。此前真实运行不提供可直接重复执行的快捷命令，避免误开第二次真实测试。
