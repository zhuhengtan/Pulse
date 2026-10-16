# Pulse 用例 2：本地模拟与验收器校准

日期：2026-10-16。按用户最新要求先做本地模拟，**没有启动真实 DeepSeek 测试，生成调用为 0**。先前仅完成官方 `/models` 网络预检。用户对 LT02 真实测试的授权已经收到，但本轮按后续“先本地跑一下模拟测试”的指示停止在本地验证。

## 结论

- 当前实现的独立场景探针 **9/9 通过**。
- 原始未实现恢复的版本 **0/9**，能被正确拒绝。
- 四类故障注入全部被检出，未把错误实现判成通过。
- 恢复、实际 Host + 模拟 Provider、独立验收门禁及 lane 连续性相关回归 **4 文件、35/35 通过**。
- 校准发现并修正了一项本轮验收探针误判：把错误路径中的 `corrupt` 字样当作 JSONL 损坏原因。产品源码没有改动。

这证明现有恢复实现和检查流程在这些本地场景可工作；没有证明真实模型能独立完成 LT02，也没有测到真实模型的长任务推理质量、网络恢复、token 成本或真实 CLI 内部调用预算执行。

## 场景矩阵

使用实际批量 runner、假 CLI 和可信编译 artifact 评分器；各场景在单独测试副本执行，不调用真实模型。

| 场景 | 当前实现 | 原始无恢复实现 |
|---|---|---|
| task 顺序优先、trial 从 1 开始、重复终态去重 | 通过 | 失败 |
| passed / partial / failed / blocked_env / succeeded / cancelled 六类终态跳过 | 通过 | 失败 |
| running / pending 保持待执行，不遗漏 | 通过 | 失败 |
| 真实入口恢复后，失败终态不重跑，历史与产物保留 | 通过 | 失败 |
| 重复终态不新增执行，汇总任务数和用量不重复累计 | 通过 | 失败 |
| 损坏 JSONL 明确报错、无新 CLI 调度、原字节保留 | 通过 | 失败 |
| 实际终止一次性 runner 后恢复，已结束项不重跑、用户进度文件保留 | 通过 | 失败 |
| 恢复后保留历史 token 消耗，不重置边界 | 通过 | 失败 |
| 已有费用上限且历史价格未知，恢复不继续新增执行 | 通过 | 失败 |

“实际终止”仅针对探针自行创建的一次性本地 runner：假 CLI 在第二个 trial 保存进度并终止自己的 runner 父进程，之后启动恢复。没有终止 Pulse 正式服务或用户进程。

## 故障注入

全部在一次性副本改动，产品源码保持不变。每个副本仍运行同样九项检查。

| 注入问题 | 检出的失败项目 | 检查结果 |
|---|---|---|
| 从终态集合遗漏 failed | 顺序/去重、六类终态、失败不重跑、中断恢复 | 5/9；拒绝 |
| 静默过滤损坏 JSONL | 损坏记录报错与保留 | 8/9；拒绝 |
| 恢复时把已消耗 token、未知费用状态和预算停止状态重置 | token 边界、未知价格费用边界 | 7/9；拒绝 |
| 汇总直接使用重复原始行 | 重复终态汇总及消耗去重 | 8/9；拒绝 |

## 验收探针误判及修正

初次原始版本校准错误地让“损坏 JSONL”一项通过，原因是检查器匹配完整异常字符串中的 `corrupt`，而测试输出路径本身含该词。实际失败来自输出目录已存在，不能证明 JSONL 解析正确。

修正后先验证同一健康目录可以成功恢复，再注入损坏记录；错误原因只从实际 Error / SyntaxError 诊断行识别明确 JSON / JSONL 解析失败。重新校准：当前实现 9/9，原始版本 0/9；单独“静默丢损坏行”故障稳定导致该项失败。首次误判日志保留，没有覆盖历史结果。

## 执行流程回归

```sh
pnpm exec vitest run tests/eval-runner.test.ts tests/independent-acceptance.test.ts tests/independent-acceptance-host.test.ts tests/lane-continuity.test.ts --maxWorkers=1 --minWorkers=1
```

实际结果：4 文件、35/35，通过。覆盖实际 runner 的假 CLI 恢复、终态记录/原产物保留、同 Host run 身份恢复、过期时限、未知用量/费用边界、Host 冻结断言门禁、问题冷恢复与 lane 连续性。这里的 Provider 为本地模拟，不是 DeepSeek。

## 证据与边界

证据目录：`.pulse-dev/long-task-eval-round9-lt02-20261016/`。

- `independent-checks.json`：真实模型调用前定义的九项验收要求。
- `probe-lt02.mjs`：本地独立入口探针；修复了本轮误判。
- `calibration-current-v2/result.json`：当前实现 9/9。
- `calibration-original-v2/result.json`：原始实现 0/9。
- `calibration-original/result.json` / `calibration-original.log`：保留首次误判证据。
- `fault-calibration.json` / `fault-*-probe/result.json`：四类故障及逐项结果。
- `local-regression.log`：35 项执行流程回归。
- `local-only-audit.json`：工作区/驱动保护、生成调用 0、真实 run 尚未开始。
- `LT02/workspace`：保留的原始缺陷副本；没有由 Codex 代写该场景的解法。

本轮校准的“当前正确实现”来自已有工作区代码；并没有让模拟模型重新推理开发需求。正式 LT02 harness 目前仍只有较少的静态/辅助模块检查，本轮新增的九项独立入口验收在评测目录中，尚未自动接入其 Host 验收适配器。真实测试后应使用这份补充探针独立验收，不能把 Host 的 accepted 或原评分当作完整通过。

真实执行目录账本仍为 used=0，`LT02/started.json` 不存在；未派发真实生成请求。保留所有未提交改动、旧样本及正式配置/服务；未提交、推送或发布。
