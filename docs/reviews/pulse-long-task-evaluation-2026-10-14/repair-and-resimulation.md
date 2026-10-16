# 发现问题修复与重新模拟

执行日期：2026-10-15。根据用户“先修复这些发现的问题，然后再模拟一次”，由 Codex 直接修改。保留初次评估的冻结输入、负向证据和六例未运行状态；本次是单独的修复/重测阶段，没有用改代码的方式刷新原有真实样本分数。

## 结果

**四项修复完成，离线重新模拟通过。**完整本地回归为139文件、1100项通过；另有12项编译产物上的模拟校准通过。真实DeepSeek调用仍为0/96；没有绕过此前的数据外发审批，也没有把fake模型结果当成真实任务完成能力。

| 问题 | 根因 | 修复 | 独立证据 |
|---|---|---|---|
| 新模型配置不能使用，调用预算误当轮数 | 旧runner只查flat models；max-calls映射max-turns | 复用server统一目录规范化/解析，支持provider/model及旧别名；max-model-calls与max-turns独立，旧max-calls改为调用预算别名 | 新旧目录、歧义/未知模型、非法预算、真实runner传参探针 |
| 批量中断后重复任务/重置消耗风险 | 输出目录已存在即失败；历史records不恢复 | batch身份指纹、独占锁、trial journal、终态去重、捕获输出复用、原Host run恢复；累计token/费用边界保留 | 完成/失败不重跑，已执行未评分只补评分，未完成使用resume原ID，损坏/失配明确失败 |
| 长历史错误被通用控制循环错误遮蔽 | 连续控制错误统一转CONTROL_ERROR_LOOP | 超限仍失败，对外保留CONTEXT_TOO_LARGE、原始详情及historyCompaction建议；其他错误循环保持原行为 | 原历史和可恢复快照保留；无压缩仍失败；有压缩20轮双工具完成 |
| 恢复命令缺少usage | resume JSONL只写status/text/taskOutcome | 增加与run一致的累计usage字段 | CLI命令回归确认modelCalls可读取；Host原预算恢复回归继续通过 |

## 关键执行边界

- 断点恢复读取原有终态记录并追加新结果；失败、取消、超时均不自动重跑。
- 如果模型已结束、只差评分，则复用保存的capture或Host outcome/usage，不再调用模型。
- 真正未完成的trial只用`resume <conversationId>`恢复原run，核对原budget.limit及used，不附加新任务。
- JSONL损坏、终态记录冲突、未知status、负消耗、batch配置/数据集/CLI身份改变、原进程仍活着或预算不符，都失败并保留现场。
- 原评测deadline过期时不启动新工作。已有文件不重新初始化，预算不重置。
- token缺失停止后续trial；设置max-cost但价格未知也停止。缺失数据保持未知。
- 报告只有在所有trial的Host预算文件与请求限额及usage一致时，才标记调用限额已确认；任意fake或旧CLI忽略flag，不能仅凭参数传入就宣称已硬限制。

## 再模拟的真实维护情境

1. **维护评测入口**：用完整24任务数据集的副本与本地假CLI，实际调用生产runner，验证nested模型、16次调用预算和32轮参数独立传递。
2. **长批次中断**：保留第1个trial的终态记录，让第2个处于“已完成未评分”或“原run未完成”状态。恢复后分别只补评分、恢复原conversation；文件和已发生消耗不重置。
3. **费用信息缺失**：模拟token缺失及价格未知；初次运行停止，resume仍停止，不因重开进程获得新额度。
4. **输入损坏或运行身份变化**：损坏JSONL/原budget失配/原deadline过期明确失败，验证没有多发一轮模型请求。
5. **长执行链**：5/10/20轮串行，5/10轮双工具均完成；20轮双工具不配压缩仍失败，配压缩完成并实际触发摘要。
6. **故障与费用上限**：429分类、慢工具AbortSignal取消、需求方不误选执行、96次总账本保留；真实Host搭配本机fake HTTP实测16次后按预算停止。

前四项证明runner接线与恢复流程，不证明DeepSeek理解复杂需求的能力。后两项证明特定Runtime/Host路径，模拟摘要也不能代表真实摘要语义保真。

## 验证证据

- [完整本地回归：139文件/1100项](/Users/zhuhengtan/projects/Pulse/.pulse-dev/long-task-repair-full-20261015.log)
- [最终runner定向回归](/Users/zhuhengtan/projects/Pulse/.pulse-dev/long-task-repair-runner-final-20261015.log)
- [12项重新模拟](/Users/zhuhengtan/projects/Pulse/.pulse-dev/long-task-repair-simulation-20261015.log)
- [类型构建](/Users/zhuhengtan/projects/Pulse/.pulse-dev/long-task-repair-typecheck-20261015.log)
- [现有改动保护核对](/Users/zhuhengtan/projects/Pulse/.pulse-dev/long-task-repair-preservation-20261015.json)

可复制命令：

```sh
pnpm exec tsc -b --pretty false
pnpm exec vitest run tests/eval-runner.test.ts tests/history-pressure.test.ts tests/runtime-control.test.ts tests/cli-commands.test.ts --maxWorkers 2 --minWorkers 1
node --test scripts/eval/long-task-calibration.test.mjs scripts/eval/long-task-transport.test.mjs
pnpm test --maxWorkers 2 --minWorkers 1
```

## 剩余限制

六个真实DeepSeek场景仍未执行，需要明确允许任务相关源码、文档和脱敏记录外发。旧冻结输入保留原样；将来真实验收应记录修复后的Host版本/产物哈希，并说明这些工作区是保留的历史维护场景。没有提交、推送、发布或重启常驻服务，也没有验证跨平台或几十小时任务稳定性。
