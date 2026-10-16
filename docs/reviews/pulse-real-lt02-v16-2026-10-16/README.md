# LT02 真实验收：开发引擎 v16（2026-10-16）

## 结果

**未完成。唯一一次真实运行使用 30/32 次请求，447.127 秒；30 次 HTTP 响应全部为 200。最终状态为 `failed / TASK_MODEL_CALL_BUDGET_EXHAUSTED`，没有追加真实运行。**

前 3 个阶段通过产品阶段检查，端到端阶段失败。独立离线验收 **6/9**；原始评分器虽为 6/6、给出临时 90 分，仍标记 partial/业务 failed，不能据此宣称完成。

本次使用 `deepseek/deepseek-flash`、`deepseek-flash`、high，当前编译 Host/Runtime 引擎。不是交互 CLI 键盘、安装包或跨平台验收。

## 本轮修复效果

- 全部阶段复用 `lane-1`，无重新规划、无阶段重试。
- 四个阶段的候选分别为 `result-25 / result-32 / result-45 / result-57`，其生产模型请求的 activeStage 分别是 stage-1/2/3/4，candidateAttempt 均为 1。没有串用候选，也没有把 README 正文当成另一阶段的结果。
- 真实轨迹中有 **5 批**混合工具触发新门禁：保留 fs.read，分别延后 fs.list、已知/尚不能证明为下一页的 fs.read、shell.exec 等；未整批拒绝、未伪造回执。“分页＋fs.search”的精确组合在本地定向回归通过，本次真实混合批次未直接出现该组合。
- 预算异常发生在控制器最终 report 步之前，因此 Host 仍拼接先前阶段正文后追加错误。这是另一个异常收尾缺陷，不是阶段候选串用复发。

## 阶段

| 阶段 | 产品状态 | 当前产物/检查 | 限制 |
|---|---|---|---|
| stage-1 调查并接入恢复 | passed | resume.mjs、run.mjs；语法检查 | 独立验收发现汇总和预算仍错误 |
| stage-2 定向测试 | passed | resume.test.mjs，8/8 | 主要是 helper 测试，不能证明真实 runner 完成 |
| stage-3 文档 | passed | README 新增恢复章节 | “预算边界不变”等描述未被实际行为证实 |
| stage-4 中断恢复端到端 | 运行中被终止 | fake-cli.mjs、resume-e2e.mjs；执行退出 1 | 未完成、未进入最终验收 |

## 独立验收矩阵

离线用记录型假 CLI、真实 runner、真实编译评分器检查。提供编译依赖，仅写入验收副本，候选原文件不改。

| 断言 | 结果 |
|---|---|
| helper 顺序、去重 | 通过 |
| 六类终态跳过（含失败） | 通过 |
| running/pending 继续待执行 | 通过 |
| 实际 runner 恢复不重跑失败终态 | 通过 |
| 重复终态不重复汇总 | **失败：tasksRun=3，实际唯一 trial=2；tokens=36，应为24** |
| 损坏 JSONL 显式失败、无 CLI 调用、字节保留 | 通过 |
| 真实子进程中断后保留终态及用户产物 | 通过 |
| 恢复继承 token 上限 | **失败：原有40,000上限下额外调用一次，累计62,002** |
| 恢复继承未知费用停止状态 | **失败：恢复后又调用一次，累计2次** |

## 问题与下一轮优化

1. **P1 调度预算与实际账本脱节**：账本为30，控制器usedTurns为26；本轮包含4次主模型审批。工作请求触及 verificationReserve=2 后直接失败，未使用预留调用收尾，也未执行已安装的九项 Host 验收。应以持久实际账本做调度依据，预留边界在提交工作请求前转为有界验收/检查点收尾；覆盖审批、修复调用及错误响应。
2. **P1 恢复预算重置**：候选run.mjs第88行把consumedTokens、consumedCostUnknown置零。应从去重历史终态及持久中断信息恢复预算，未知字段保持未知；回归两次恢复不得多启动trial。
3. **P1 汇总重复计数**：候选run.mjs第86行直接复制existingRecords，报告把重复终态及running历史当独立运行。原JSONL必须保留，报告视图按(taskId,trial)选终态并去重；不能靠删历史日志修复。
4. **P1 隔离环境缺编译依赖**：模型自己的端到端执行中，grade.mjs加载 `packages/adapters/dist/tools/shell.js` 失败，报告未生成。独立探针已补依赖，但候选工作区没有同样的环境准备。下一轮应在真实调用前做无模型假CLI基线并提供固定的编译依赖，不把环境排障交给付费模型。
5. **P2 候选测试断言错误**：补依赖后原样离线重放仍失败3项。它把“保留running行+追加终态”误判为重复执行，还要求实现未写入的逐行resume字段，并把4条历史/新增日志当4次运行。应依据假CLI dispatch记录验证有无重跑，分开日志保留与汇总去重，覆盖预算。
6. **P2 审批与解析顺序**：请求12/20/28/30共4次DeepSeek审批；effect-57复合sh命令仍以SHELL_SYNTAX_UNSUPPORTED失败。自动工具审批走主provider的runLlm；应在模型审批前完成确定性解析/规则判断，并统一使用已配置的本地审查路径或人工回退。
7. **P2 异常最终报告**：终止后stage-4仍为running，业务各条unverifiable，用户文本包含历史“后续待办”正文。异常路径也应从当前持久控制器生成完成项、首个阻塞、剩余项，不能拼接所有阶段正文当最终汇总。
8. **P2 旧评分器偏乐观**：原始6项主要检查文件/简单helper/字符串，没有发现上述3项业务缺陷。九项独立探针必须继续保留，并在预算异常后也以无模型方式执行；不能只在所有阶段通过后触发。

以上新问题本轮只定位、保留证据和提出方案，没有追加真实调用或顺手改动评测中的代码。

## 用量对账

| 字段 | HTTP原始统计 | Host账本 | 已知请求 |
|---|---:|---:|---:|
| inputTokens | 801423 | 801423 | 30/30 |
| outputTokens | 75706 | 75706 | 30/30 |
| cachedInputTokens | 519168 | 519168 | 30/30 |
| uncachedInputTokens | 282255 | 282255 | 30/30 |
| reasoningTokens | 64931 | 64931 | 30/30 |

总token **877129**。原始visible content为6423字符，Host为6125；差额298来自请求22的DSML工具控制文本，已转为工具调用而不计可见正文，能够对账。HTTP捕获延迟418756ms、Host测量420232ms，边界不同；墙钟447127ms。30个usageReceipt全部唯一，未重复累计。没有价格信息，不把未知费用记为0。

## 冻结与证据

隔离根目录：`.pulse-dev/long-task-eval-round10-lt02-20261016/`。

- 冻结502个源码文件、304个编译引擎/驱动文件。运行结束后二者及主工作区均无漂移，HEAD未改变。
- 原始runner/README来自round4，哈希与上一轮本地模拟一致。未植入现有resume.mjs、config-budget.mjs或eval-runner.test.ts答案。
- 实际仅修改候选副本6个文件。正式配置只作本地路由/认证，输入副本未复制凭据，凭据值扫描0匹配；嵌套工具禁网络。
- `LT02/attempts.jsonl`：逐请求时间、HTTP结果、usage、可见输出/工具名，无provider推理正文。
- `request-process.json`：30次请求的脱敏过程；本目录 `process.md` 为可读表。
- `candidate-ownership.json`、`mixed-batch-evidence.json`：两项修复的真实证据。
- `LT02/result.json`、`LT02/grade.json`：原始失败状态与旧评分，不覆盖历史失败。
- `offline-independent/result.json`：9项独立验收；各子目录保留原日志、调用记录和报告。
- `candidate-e2e-with-compiled-deps.json`、`original-grader-dependency-probe.json`：原脚本补依赖后的失败与缺依赖的独立复现。
- `usage-reconciliation.json`、`pre-run-integrity.json`、`post-run-integrity.json`：对账和完整性。

[本轮修复与本地验证](../pulse-stage-candidate-paging-repair-2026-10-16.md)。未提交、推送、发布或重启正式服务。
