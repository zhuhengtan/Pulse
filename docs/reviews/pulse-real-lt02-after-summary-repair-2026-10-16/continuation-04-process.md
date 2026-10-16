# LT02 continuation-04 逐请求过程

工具提议与实际 effect 回执分列；length 响应中的残缺提议未执行。

| 累计请求 | UTC | 阶段 | 作用 | 结束原因 | input/output | 工具提议 | 实际工具 effect |
|---:|---|---|---|---|---:|---|---|
| 74 | 13:23:09 | — | 规划 | stop | 11481/1844 | 0字符 | — |
| 75 | 13:23:22 | T1 | 工作 | tool_calls | 17484/2063 | fs.list scripts/eval; fs.list scripts/eval/.verify-resume | effect-3 fs.list succeeded; effect-4 fs.list succeeded |
| 76 | 13:23:35 | T1 | 工作 | tool_calls | 18194/1248 | fs.read scripts/eval/run.mjs offset=14753; fs.read scripts/eval/resume.mjs; fs.read scripts/eval/.verify-resume/resume-e2e.test.mjs; fs.search  | effect-6 fs.read succeeded; effect-7 fs.read succeeded |
| 77 | 13:23:43 | T1 | 工作 | tool_calls | 20788/4885 | fs.search ; fs.read scripts/eval/.verify-resume/make-dataset.mjs; fs.read scripts/eval/.verify-resume/fake-cli.mjs; fs.read scripts/eval/run.mjs offset=14753 | effect-9 fs.read succeeded; effect-10 fs.read succeeded |
| 78 | 13:24:12 | T1 | 工作 | tool_calls | 22499/2688 | fs.search ; fs.search ; fs.list scripts/eval | — |
| 79 | 13:24:29 | T1 | 工作 | tool_calls | 23584/8062 | fs.apply_patches scripts/eval/run.mjs | effect-13 fs.apply_patches succeeded |
| 80 | 13:25:16 | T1 | 工作 | tool_calls | 25927/1904 | fs.search ; shell.exec node | effect-15 fs.search succeeded; effect-16 shell.exec failed |
| 81 | 13:25:49 | — | 规划 | stop | 22163/3004 | 0字符 | — |
| 82 | 13:26:05 | T1 | 工作 | tool_calls | 29332/1832 | fs.search scripts/eval/run.mjs; fs.read scripts/eval/run.mjs offset=6000 | effect-20 fs.search succeeded; effect-21 fs.read succeeded |
| 83 | 13:26:17 | T1 | 工作 | tool_calls | 31592/4837 | fs.search scripts/eval/run.mjs; fs.read scripts/eval/run.mjs offset=8400 | — |
| 84 | 13:26:49 | T1 | 工作 | tool_calls | 32680/3725 | fs.read scripts/eval/run.mjs offset=6000; fs.read scripts/eval/run.mjs offset=8400 | — |
| 85 | 13:27:13 | T1 | 工作 | tool_calls | 33973/4206 | fs.read scripts/eval/run.mjs offset=6000 | — |
| 86 | 13:27:39 | T1 | 工作 | tool_calls | 35185/5082 | fs.read scripts/eval/run.mjs offset=5600; fs.read scripts/eval/.verify-resume/fake-config.json; fs.read scripts/eval/run.mjs offset=8450 | effect-26 fs.read succeeded |
| 87 | 13:28:12 | T1 | 工作 | tool_calls | 36761/6652 | fs.apply_patches scripts/eval/run.mjs | effect-29 fs.apply_patches failed |
| 88 | 13:28:50 | T1 | 压缩 | stop | 17583/3968 | 3258字符 | — |
| 89 | 13:29:14 | T1 | 工作 | tool_calls | 33108/1079 | fs.search scripts/eval/run.mjs; fs.read scripts/eval/run.mjs offset=5900; fs.read scripts/eval/run.mjs offset=8500 | effect-31 fs.search succeeded; effect-32 fs.read succeeded; effect-33 fs.read succeeded |
| 90 | 13:29:21 | T1 | 工作 | tool_calls | 36182/10303 | fs.read scripts/eval/run.mjs offset=4600 | — |
| 91 | 13:30:23 | T1 | 阶段验收 | stop | 32844/5811 | 0字符 | — |
| 92 | 13:30:57 | T1 | 工作 | tool_calls | 39211/4325 | fs.list scripts/eval/.verify-resume; fs.read scripts/eval/validate.mjs | effect-37 fs.read succeeded |
| 93 | 13:31:23 | T1 | 工作 | length | 41791/16384 | 66字符 | — |
| 94 | 13:32:49 | T1 | 工作 | tool_calls | 43358/12735 | fs.apply_patches scripts/eval/run.mjs | effect-41 fs.apply_patches failed |
| 95 | 13:34:05 | T1 | 压缩 | stop | 22672/3355 | 3859字符 | — |
| 96 | 13:34:27 | T1 | 工作 | tool_calls | 39084/15829 | fs.apply_patches scripts/eval/run.mjs | effect-44 fs.apply_patches failed |
| 97 | 13:35:56 | T1 | 压缩 | stop | 15847/2490 | 3658字符 | — |
| 98 | 13:36:11 | T1 | 工作 | tool_calls | 42589/7310 | fs.read scripts/eval/run.mjs offset=4000; fs.read scripts/eval/run.mjs offset=15150 | — |
| 99 | 13:36:56 | T1 | 压缩 | stop | 17732/3075 | 4102字符 | — |
| 100 | 13:37:14 | T1 | 阶段验收 | stop | 40266/1922 | 0字符 | — |
| 101 | 13:37:28 | T1 | 工作 | length | 46987/16384 | 0字符 | — |
| 102 | 13:39:02 | — | 规划 | stop | 45027/1570 | 0字符 | — |
| 103 | 13:39:12 | — | 压缩 | stop | 26691/2440 | 4118字符 | — |
| 104 | 13:39:25 | S1 | 工作 | tool_calls | 46151/5973 | fs.read scripts/eval/run.mjs offset=5500; fs.list scripts/eval/.verify-resume | — |
| 105 | 13:40:04 | — | 工作 | cancelled | 未知 | 0字符 | — |

## 用量对账

| 字段 | 原始响应已知值 | Host 已知值 |
|---|---:|---:|
| inputTokens | 948766 | 948766 |
| outputTokens | 166985 | 166985 |
| cachedInputTokens | 343552 | 343552 |
| uncachedInputTokens | 605214 | 605214 |
| reasoningTokens | 150663 | 150663 |
| visibleOutputChars | 25249 | 25249 |
| latencyMs | 957484 | 959591 |

新增 32 次，累计 105 次；本次已知 31 次。价格未知，不填零。延迟边界为传输全响应与 provider 执行；可见字符可能在截断归一时减少。

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
| 独立恢复验收: resumed-unknown-cost-cap-not-reset | 通过 |

## 阶段

| 阶段 | 状态 | 尝试 | lane |
|---|---|---:|---|
| S1 修正 run.mjs resume 继承历史未知费用：不重置 consumedCostUnknown，未知历史费用时停止额外假CLI调用；夹具只补缺失不覆盖。 | blocked | 1 | lane-1 |
| S2 定向校验 resume.mjs 契约：selectPendingTrials 顺序与 trial 起点、终态跳过集合、running/pending 待执行、重复终态、损坏 JSONL 抛错。 | pending | 0 | — |
| S3 新增自包含 .test.mjs：经真实入口 run.mjs --resume 配合本地假 CLI/预置记录复现中断恢复，追加记录并汇总历史+新增，全程不启动真实模型。 | pending | 0 | — |
| S4 更新 evals/README.md：写明 --resume 用法、恢复与去重语义、成本边界不变、夹具保留规则，与 run.mjs 实际行为一致。 | pending | 0 | — |
| S5 端到端复验：整合运行 scripts/eval 全部 node --test，核对原独立 9 项与夹具保存边界证据，如实报告未过项。 | pending | 0 | — |
