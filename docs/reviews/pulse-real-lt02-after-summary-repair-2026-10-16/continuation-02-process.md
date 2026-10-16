# LT02 continuation-02 逐请求过程

工具提议与实际 effect 回执分列；length 响应中的残缺提议未执行。

| 累计请求 | UTC | 阶段 | 作用 | 结束原因 | input/output | 工具提议 | 实际工具 effect |
|---:|---|---|---|---|---:|---|---|
| 50 | 12:39:10 | — | 规划 | stop | 7416/2207 | 0字符 | — |
| 51 | 12:39:23 | S1 | 工作 | tool_calls | 13763/134 | fs.read scripts/eval/run.mjs; fs.list scripts/eval | effect-3 fs.read succeeded; effect-4 fs.list succeeded |
| 52 | 12:39:25 | S1 | 工作 | tool_calls | 15394/255 | fs.read scripts/eval/run.mjs offset=3000; fs.search scripts/eval | effect-6 fs.read succeeded |
| 53 | 12:39:27 | S1 | 工作 | tool_calls | 16811/281 | fs.read scripts/eval/run.mjs offset=6000; fs.search scripts/eval | effect-8 fs.read succeeded |
| 54 | 12:39:29 | S1 | 工作 | tool_calls | 18314/518 | fs.read scripts/eval/run.mjs offset=9000; fs.list scripts/eval/.verify-resume | effect-10 fs.read succeeded |
| 55 | 12:39:33 | S1 | 工作 | tool_calls | 20110/238 | fs.read scripts/eval/run.mjs offset=12000; fs.read scripts/eval/resume.mjs | effect-12 fs.read succeeded; effect-13 fs.read succeeded |
| 56 | 12:39:36 | S1 | 工作 | tool_calls | 22840/1749 | fs.read scripts/eval/run.mjs offset=15000; fs.list scripts/eval/.verify-resume | effect-15 fs.read succeeded |
| 57 | 12:39:49 | S1 | 工作 | tool_calls | 24234/985 | fs.list scripts/eval/.verify-resume; fs.search scripts/eval | — |
| 58 | 12:39:55 | S1 | 工作 | tool_calls | 25350/4437 | fs.apply_patches scripts/eval/run.mjs | effect-18 fs.apply_patches succeeded |
| 59 | 12:40:18 | S1 | 工作 | tool_calls | 27630/1028 | fs.list scripts/eval/.verify-resume; shell.exec node | effect-20 fs.list succeeded; effect-21 shell.exec failed |
| 60 | 12:41:31 | S1 | 阶段验收 | stop | 24510/1849 | 0字符 | — |
| 61 | 12:41:42 | S1 | 工作 | tool_calls | 30804/443 | shell.exec node; fs.read scripts/eval/.verify-resume/resume-e2e.test.mjs | effect-26 shell.exec failed; effect-27 fs.read failed |

## 用量对账

| 字段 | 原始响应已知值 | Host 已知值 |
|---|---:|---:|
| inputTokens | 247176 | 247176 |
| outputTokens | 14124 | 14124 |
| cachedInputTokens | 132736 | 132736 |
| uncachedInputTokens | 114440 | 114440 |
| reasoningTokens | 11428 | 11428 |
| visibleOutputChars | 2427 | 2427 |
| latencyMs | 82944 | 83328 |

新增 12 次，累计 61 次；本次已知 12 次。价格未知，不填零。延迟边界为传输全响应与 provider 执行；可见字符可能在截断归一时减少。

## 实际验收

| 断言 | 结果 |
|---|---|
| 独立恢复验收: helper-order-and-dedup | 通过 |
| 独立恢复验收: all-six-terminal-statuses | 通过 |
| 独立恢复验收: running-and-pending-retained | 通过 |
| 独立恢复验收: actual-runner-failure-resume-no-replay | 通过 |
| 独立恢复验收: duplicate-terminal-history-summary | 通过 |
| 独立恢复验收: corrupt-jsonl-fails-before-cli-and-preserves-bytes | 通过 |
| 独立恢复验收: actual-interruption-retains-terminal-and-user-artifact | 通过 |
| 独立恢复验收: resumed-token-cap-not-reset | 通过 |
| 独立恢复验收: resumed-unknown-cost-cap-not-reset | 失败 |

## 阶段

| 阶段 | 状态 | 尝试 | lane |
|---|---|---:|---|
| S1 修 scripts/eval/run.mjs 终态汇总按 taskId/trial 去重，报表 tasksRun 计唯一终态数，追加记录不重跑 | blocked | 2 | lane-1 |
| S2 run.mjs 以 --resume 时从 previousRecords 继承 consumedCostUnknown/成本边界，不重置 | blocked | 0 | — |
| S3 run.mjs fixture 写入改为仅补缺失，保留待恢复 trial 已有同名用户编辑文件 | blocked | 0 | — |
| S4 校验 scripts/eval/resume.mjs 的 selectPendingTrials 契约：终态跳过、running/pending 保留、task 顺序、trial 从1、损坏 JSONL 报错 | blocked | 0 | — |
| S5 新增/完善真实入口 run.mjs + 本地假CLI 的自包含 .test.mjs（node --test）复现中断恢复 | blocked | 0 | — |
| S6 更新 evals/README.md，记录 --resume 用法、恢复语义、成本边界、夹具保留规则 | blocked | 0 | — |
| S7 运行 node --test 全套并核对原独立9项：汇总=2、假CLI=1次、夹具边界有实际证据 | blocked | 0 | — |
