# 证据索引与复现

## 冻结输入

- [六场景任务集](/Users/zhuhengtan/projects/Pulse/evals/long-tasks.v1.json)
- [冻结快照与源码哈希](/Users/zhuhengtan/projects/Pulse/.pulse-dev/long-task-eval-20261015/frozen.json)
- [外部费用账本](/Users/zhuhengtan/projects/Pulse/.pulse-dev/long-task-eval-20261015/budget.json)
- [无生成网络/认证预检](/Users/zhuhengtan/projects/Pulse/.pulse-dev/long-task-eval-20261015/preflight.json)

输入为当前未提交源码的独立副本。运行记录来自repair-run-audit与continuation-audit，只保留状态/usage/来源字段，包含一个刻意重复的真实记录供去重验收。没有把原始任务提示词或正式配置复制到受测工作区。测试证书和测试私钥也排除。

官方资料在2026-10-15浏览并作简短快照，LT04可离线查阅，未开放任意网络工具：

- [DeepSeek Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode/)
- [DeepSeek Chat Completions](https://api-docs.deepseek.com/api/create-chat-completion/)

## 本地日志

- [173项定向回归](/Users/zhuhengtan/projects/Pulse/.pulse-dev/long-task-offline-20261015.log)
- [重试与压缩6项](/Users/zhuhengtan/projects/Pulse/.pulse-dev/long-task-offline-extra-20261015.log)
- [HTTP传输3项](/Users/zhuhengtan/projects/Pulse/.pulse-dev/long-task-http-offline-20261015.log)
- [新增规模/故障11项校准](/Users/zhuhengtan/projects/Pulse/.pulse-dev/long-task-calibration-20261015.log)
- [真实Host假传输16请求预算验证](/Users/zhuhengtan/projects/Pulse/.pulse-dev/long-task-transport-20261015.log)
- [TypeScript构建](/Users/zhuhengtan/projects/Pulse/.pulse-dev/long-task-typecheck-20261015.log)

合计194项离线检查（182项现有定向回归、11项新增校准、1项Host假HTTP验证）。不代表194个真实长任务，也不是全量本地测试或平台验收。

## 复现命令

```sh
node --test scripts/eval/long-task-calibration.test.mjs
node --test scripts/eval/long-task-transport.test.mjs
pnpm exec tsc -b --pretty false
```

首次创建新评估目录：

```sh
node scripts/eval/long-tasks.mjs prepare --out .pulse-dev/long-task-eval-NEW
node scripts/eval/long-tasks.mjs preflight --out .pulse-dev/long-task-eval-NEW
```

用户已明确同意真实调用，任务相关源码/文档/脱敏记录已用于本轮评估。模型凭据仅从环境变量提供，没有写入argv或受测工作区。本轮六例已结束，真实生成93次，没有重跑。

```sh
node scripts/eval/long-tasks.mjs run --out .pulse-dev/long-task-eval-20261015
node scripts/eval/long-task-grade.mjs .pulse-dev/long-task-eval-20261015
node scripts/eval/long-task-report.mjs .pulse-dev/long-task-eval-20261015
```

`run`只保留既有结果，不自动重跑失败样本。非LT06约定恢复点发生中断时，要求先审计；不静默再开run。LT06仅在最终确认处退出并恢复同run，然后明确选择暂不执行。

## 安全与解释边界

一个串行supervisor独占外部账本。Host内置账本和外部fetch admission双重限制；外部账本不是多进程共享数据库。候选代码行为探针运行于Pulse shell sandbox，关闭网络并过滤凭据。正式配置只供宿主选择模型，不复制给受测任务。源工作区没有被受测agent修改。

## 本轮真实证据

- [真实汇总](live-summary.md)、[逐请求过程](process.md)、[问题台账](live-problems.md)
- [模型原始运行日志](/Users/zhuhengtan/projects/Pulse/.pulse-dev/long-task-real-20261015.log)
- [93次请求与usage对账](/Users/zhuhengtan/projects/Pulse/.pulse-dev/long-task-eval-20261015/live-summary.json)
- [250个Host编译文件及源码指纹](/Users/zhuhengtan/projects/Pulse/.pulse-dev/long-task-eval-20261015/driver-provenance.json)
- [独立探针日志](/Users/zhuhengtan/projects/Pulse/.pulse-dev/long-task-live-grading-20261015.log)

本轮在原冻结的历史维护任务副本上测修复后Host；没有把主工作区已修复的runner当成模型本次产物。第6例评估脚本误选并取消，真模冷恢复未触发。原始run与结果保留，不改写为成功。
