# LT02 continuation-03 逐请求过程

工具提议与实际 effect 回执分列；length 响应中的残缺提议未执行。

| 累计请求 | UTC | 阶段 | 作用 | 结束原因 | input/output | 工具提议 | 实际工具 effect |
|---:|---|---|---|---|---:|---|---|
| 62 | 13:02:48 | — | 规划 | stop | 8073/2009 | 0字符 | — |
| 63 | 13:03:00 | S1 | 工作 | tool_calls | 14087/304 | fs.list scripts/eval; fs.search ; fs.search  | effect-3 fs.list succeeded; effect-4 fs.search succeeded; effect-5 fs.search succeeded |
| 64 | 13:03:04 | S1 | 工作 | tool_calls | 15102/407 | fs.list scripts/eval/.verify-resume; fs.read scripts/eval/run.mjs | effect-7 fs.read succeeded |
| 65 | 13:03:08 | S1 | 工作 | tool_calls | 16394/324 | fs.read scripts/eval/run.mjs offset=3000; fs.search scripts/eval/run.mjs | effect-9 fs.read succeeded |
| 66 | 13:03:11 | S1 | 工作 | tool_calls | 18177/641 | fs.read scripts/eval/run.mjs offset=6000; fs.search scripts/eval/run.mjs; fs.search scripts/eval/run.mjs | effect-11 fs.read succeeded |
| 67 | 13:03:16 | S1 | 工作 | tool_calls | 20130/2248 | fs.list scripts/eval/.verify-resume; fs.read scripts/eval/run.mjs offset=9000 | effect-13 fs.read succeeded |
| 68 | 13:03:30 | S1 | 工作 | tool_calls | 22015/2707 | fs.list scripts/eval/.verify-resume; fs.search scripts/eval | — |
| 69 | 13:03:47 | S1 | 工作 | tool_calls | 23083/8891 | fs.read scripts/eval/run.mjs offset=12000 | effect-16 fs.read succeeded |
| 70 | 13:04:43 | S1 | 工作 | tool_calls | 24826/1321 | fs.list scripts/eval/.verify-resume; fs.search scripts/eval/.verify-resume | — |
| 71 | 13:04:55 | S1 | 工作 | length | 26012/16384 | 0字符 | — |
| 72 | 13:06:38 | S1 | 工作 | tool_calls | 26853/1220 | fs.list scripts/eval/.verify-resume; fs.search scripts/eval/.verify-resume | — |
| 73 | 13:06:48 | S1 | 阶段验收 | stop | 23159/933 | 0字符 | — |

## 用量对账

| 字段 | 原始响应已知值 | Host 已知值 |
|---|---:|---:|
| inputTokens | 237911 | 237911 |
| outputTokens | 37389 | 37389 |
| cachedInputTokens | 125824 | 125824 |
| uncachedInputTokens | 112087 | 112087 |
| reasoningTokens | 35604 | 35604 |
| visibleOutputChars | 1869 | 1869 |
| latencyMs | 241319 | 241612 |

新增 12 次，累计 73 次；本次已知 12 次。价格未知，不填零。延迟边界为传输全响应与 provider 执行；可见字符可能在截断归一时减少。

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
| S1 run.mjs 以 --resume 时从 previousRecords 继承 unknown 费用计数与成本边界，不重置，恢复运行保持1次假CLI调用预算 | blocked | 2 | lane-1 |
| S2 run.mjs 写 fixture 改为仅补缺失：待恢复 trial 已有同名用户编辑文件必须原样保留，不得因覆盖或 wx 触发 EEXIST 中止 | pending | 0 | — |
| S3 校验 scripts/eval/resume.mjs 的 selectPendingTrials 与 JSONL 解析契约 | pending | 0 | — |
| S4 用真实入口 run.mjs + 自包含 .test.mjs 与本地假CLI 复现中断恢复，不启动真实模型、不提交 | pending | 0 | — |
| S5 更新 evals/README.md 记录 --resume 用法、恢复语义、成本边界与夹具保留规则 | pending | 0 | — |
| S6 最终验收：全套 node --test 通过并核对原独立9项与原夹具保存边界证据 | pending | 0 | — |
