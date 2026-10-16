# 证据与复现

- [类型构建](/Users/zhuhengtan/projects/Pulse/.pulse-dev/round3-typecheck.log)
- [34项定向回归](/Users/zhuhengtan/projects/Pulse/.pulse-dev/round3-targeted.log)
- [1111项完整回归](/Users/zhuhengtan/projects/Pulse/.pulse-dev/round3-full.log)
- [最终18项离线校准](/Users/zhuhengtan/projects/Pulse/.pulse-dev/round3-offline-final.log)
- [真实请求与监督器日志](/Users/zhuhengtan/projects/Pulse/.pulse-dev/round3-real.log)
- [首例原始结果：TimeoutError、180008毫秒](/Users/zhuhengtan/projects/Pulse/.pulse-dev/long-task-eval-round3-20261015/LT01/result.json)
- [无生成费用的预检](/Users/zhuhengtan/projects/Pulse/.pulse-dev/long-task-eval-round3-20261015/preflight.json)
- [冻结场景与预算](/Users/zhuhengtan/projects/Pulse/.pulse-dev/long-task-eval-round3-20261015/frozen.json)
- [实际请求总账本](/Users/zhuhengtan/projects/Pulse/.pulse-dev/long-task-eval-round3-20261015/budget.json)
- [整批自动停止记录](/Users/zhuhengtan/projects/Pulse/.pulse-dev/long-task-eval-round3-20261015/blocked.json)
- [驱动与监督器哈希](/Users/zhuhengtan/projects/Pulse/.pulse-dev/long-task-eval-round3-20261015/driver-provenance.json)
- [真实请求期间驱动/监督器未改变](/Users/zhuhengtan/projects/Pulse/.pulse-dev/long-task-eval-round3-20261015/workspace-after-live-audit.json)
- [历史场景输入差异](/Users/zhuhengtan/projects/Pulse/.pulse-dev/long-task-eval-round3-20261015/fixture-comparison.json)

本地复核（不调用外部模型）：

```sh
pnpm exec tsc -b --pretty false
pnpm test --maxWorkers 2 --minWorkers 1
node --test scripts/eval/long-task-calibration.test.mjs scripts/eval/long-task-transport.test.mjs scripts/eval/long-task-grader.test.mjs scripts/eval/long-task-supervisor.test.mjs
```

第三轮冻结后还有评估器清理，后续不得修改旧frozen.json/预算来绕过身份检查。前两轮数据完整保留。
