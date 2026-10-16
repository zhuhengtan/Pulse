# 独立验证与证据

- [冻结要求与授权](/Users/zhuhengtan/projects/Pulse/.pulse-dev/long-task-eval-round5-20261015/frozen.json)
- [无模型网络预检](/Users/zhuhengtan/projects/Pulse/.pulse-dev/long-task-eval-round5-20261015/preflight.json)
- [真实请求与HTTP usage](/Users/zhuhengtan/projects/Pulse/.pulse-dev/long-task-eval-round5-20261015/LT01/attempts.jsonl)
- [可见运行事件](/Users/zhuhengtan/projects/Pulse/.pulse-dev/long-task-eval-round5-20261015/LT01/events.jsonl)
- [Runtime及业务结果](/Users/zhuhengtan/projects/Pulse/.pulse-dev/long-task-eval-round5-20261015/LT01/result.json)
- [外置ResultRef正确读取后的诊断](/Users/zhuhengtan/projects/Pulse/.pulse-dev/long-task-eval-round5-20261015/LT01/diagnostics-current.json)
- [原验收断言](/Users/zhuhengtan/projects/Pulse/.pulse-dev/long-task-eval-round5-20261015/LT01/grade.json)
- [额外模块与真实runner假CLI检查](/Users/zhuhengtan/projects/Pulse/.pulse-dev/long-task-eval-round5-20261015/LT01/independent-probe.json)
- [初次缺少编译依赖的检查记录](/Users/zhuhengtan/projects/Pulse/.pulse-dev/long-task-eval-round5-20261015/LT01/independent-probe-initial.json)
- [驱动和原工作区保留核对](/Users/zhuhengtan/projects/Pulse/.pulse-dev/long-task-eval-round5-20261015/preservation-audit.json)

## 原验收点

- 通过：产物: scripts/eval/config-budget.mjs
- 失败：产物: scripts/eval/run.mjs
- 失败：产物: evals/README.md
- 通过：新旧模型解析、非法引用和真实调用参数
- 失败：接入真实 runner
- 失败：修复文档旧的非硬预算声明

## 额外定向探针

- 通过：helper nested and flat resolution
- 通过：helper distinct call and turn arguments plus invalid budgets
- 通过：helper ambiguous bare names rejected
- 通过：syntax scripts/eval/config-budget.mjs
- 通过：syntax scripts/eval/run.mjs
- 通过：Pulse generated local directed tests
- 失败：actual runner nested explicit budget
- 失败：actual runner nested legacy call alias
- 失败：actual runner legacy flat model

假CLI及假评分器不联网，不使用真实密钥，仅证实实际runner的参数与模型解析控制流。初次探针失败与第二次隔离依赖后的结果分别保留，未修改候选实现。语法和模块通过不能替代入口集成验收。原评分器总分未用于本报告。
