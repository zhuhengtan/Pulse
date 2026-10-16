# 证据索引

- [复测前完整回归](/Users/zhuhengtan/projects/Pulse/.pulse-dev/repair2-full-final.log)
- [网络诊断修复后完整回归](/Users/zhuhengtan/projects/Pulse/.pulse-dev/repair2-full-after-network-fix.log)
- [最终类型构建](/Users/zhuhengtan/projects/Pulse/.pulse-dev/repair2-poststop-typecheck.log)
- [最终定向回归](/Users/zhuhengtan/projects/Pulse/.pulse-dev/repair2-poststop-targeted.log)
- [16项校准及grader](/Users/zhuhengtan/projects/Pulse/.pulse-dev/repair2-poststop-offline.log)
- [监督器fake503端到端](/Users/zhuhengtan/projects/Pulse/.pulse-dev/repair2-supervisor.log)
- [真实执行日志](/Users/zhuhengtan/projects/Pulse/.pulse-dev/repair2-real.log)
- [真实请求预算](/Users/zhuhengtan/projects/Pulse/.pulse-dev/long-task-eval-round2-20261015/budget.json)
- [真实网络预检](/Users/zhuhengtan/projects/Pulse/.pulse-dev/long-task-eval-round2-20261015/preflight.json)
- [冻结场景及脚本哈希](/Users/zhuhengtan/projects/Pulse/.pulse-dev/long-task-eval-round2-20261015/frozen.json)
- [驱动版本与哈希](/Users/zhuhengtan/projects/Pulse/.pulse-dev/long-task-eval-round2-20261015/driver-provenance.json)
- [请求期间驱动未改变](/Users/zhuhengtan/projects/Pulse/.pulse-dev/long-task-eval-round2-20261015/workspace-after-live-audit.json)
- [历史场景差异](/Users/zhuhengtan/projects/Pulse/.pulse-dev/long-task-eval-round2-20261015/fixture-comparison.json)
- [中断原因](/Users/zhuhengtan/projects/Pulse/.pulse-dev/long-task-eval-round2-20261015/interruption.json)
- [LT01原始结果](/Users/zhuhengtan/projects/Pulse/.pulse-dev/long-task-eval-round2-20261015/LT01/result.json)
- [第一轮原始数据](/Users/zhuhengtan/projects/Pulse/.pulse-dev/long-task-eval-20261015/live-summary.json)

可复制的本地检查（无外部模型）：

```sh
pnpm exec tsc -b --pretty false
pnpm test --maxWorkers 2 --minWorkers 1
node --test scripts/eval/long-task-calibration.test.mjs scripts/eval/long-task-transport.test.mjs scripts/eval/long-task-grader.test.mjs scripts/eval/long-task-supervisor.test.mjs
```

本轮已结束；冻结脚本之后还有网络失败保护修复，不应绕过哈希校验在旧轮次下继续运行新脚本。
