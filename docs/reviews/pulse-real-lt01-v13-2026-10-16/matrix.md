# 验收矩阵

原始评分不修改；补充核查与原评分分开。

| 项目 | 原评分 | 独立解释 |
|---|---|---|
| 产物: scripts/eval/config-budget.mjs | 通过 | 原判定保留 |
| 产物: scripts/eval/run.mjs | 通过 | 原判定保留 |
| 产物: evals/README.md | 失败 | 文档未启动、未修改 |
| 新旧模型解析、非法引用和真实调用参数 | 失败 | 模型码可解析；providerCode 返回 deepseek 而非既有目录约定的 ds |
| 接入真实 runner | 通过 | 原判定保留 |
| 修复文档旧的非硬预算声明 | 失败 | 文档未启动、未修改 |
| 实际入口集成: nested explicit call budget | 失败 | 评分器误判：实际入口、调用/轮数转发、本地 artifact 评分和报告生成通过，预算报告字段为 maxModelCallsPerAttempt |
| 实际入口集成: nested legacy call alias | 失败 | 评分器误判：实际入口、调用/轮数转发、本地 artifact 评分和报告生成通过，预算报告字段为 maxModelCallsPerAttempt |
| 实际入口集成: legacy flat config | 失败 | 评分器误判：实际入口、调用/轮数转发、本地 artifact 评分和报告生成通过，预算报告字段为 maxModelCallsPerAttempt |
| 实际入口集成: unknown model rejected before CLI | 通过 | 原判定保留 |
| 实际入口集成: zero budget rejected before CLI | 通过 | 原判定保留 |
| 实际入口集成: conflicting aliases rejected before CLI | 失败 | 确实启动了假 CLI；参数校验缺口 |
| 实际入口集成: duplicate budget flag rejected before CLI | 失败 | 确实启动了假 CLI；参数校验缺口 |
| 实际入口集成: missing budget value rejected before CLI | 失败 | 确实启动了假 CLI；参数校验缺口 |

## 用量及流程验收

| 项目 | 结果 |
|---|---|
| 网络 | 38/38 HTTP 200，无 transport/capture error |
| 账本 | 外部预算、HTTP 请求、Host modelCalls 均为 38；38 唯一回执 |
| 输入/输出/缓存/未缓存/推理/可见字符 | 捕获与 Host 完全一致，逐字段已知 38/38 |
| 延迟 | Host 259,159 ms；外部捕获 257,295 ms，计时边界差 1,864 ms，不强行判等 |
| 预算评分 | not_applicable；未设额外评测预算不扣分，也不表示产品无限预算 |
| 最终任务状态 | incomplete，汇总明确未完成及未启动阶段 |
| 保留已完成阶段 | s1/s2 保留，replanCount=0 |
| 防重复 | 部分生效，仍有 3 次同身份多余检查 |
| 正式工作区及驱动 | 报告前变化 0 / 279 驱动文件变化 0 |
