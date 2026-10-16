# 独立验收矩阵

原始评分保留为 8/14，不覆盖。补充语义核查不改变历史分数。

| 项目 | 原评分 | 独立说明 |
|---|---|---|
| 产物: scripts/eval/config-budget.mjs | 通过 | 实际通过对应检查 |
| 产物: scripts/eval/run.mjs | 通过 | 实际通过对应检查 |
| 产物: evals/README.md | 通过 | 实际通过对应检查 |
| 新旧模型解析、非法引用和真实调用参数 | 通过 | 实际通过对应检查 |
| 接入真实 runner | 通过 | 实际通过对应检查 |
| 修复文档旧的非硬预算声明 | 通过 | 实际通过对应检查 |
| 实际入口集成: nested explicit call budget | 失败 | 字段名误判；独立读 calls.jsonl 与 report.json：参数、实际 artifact 评分、报告生成通过；未验证 fake CLI 内部预算执行 |
| 实际入口集成: nested legacy call alias | 失败 | 字段名误判；独立读 calls.jsonl 与 report.json：参数、实际 artifact 评分、报告生成通过；未验证 fake CLI 内部预算执行 |
| 实际入口集成: legacy flat config | 失败 | 字段名误判；独立读 calls.jsonl 与 report.json：参数、实际 artifact 评分、报告生成通过；未验证 fake CLI 内部预算执行 |
| 实际入口集成: unknown model rejected before CLI | 通过 | 实际通过对应检查 |
| 实际入口集成: zero budget rejected before CLI | 通过 | 实际通过对应检查 |
| 实际入口集成: conflicting aliases rejected before CLI | 失败 | 真实缺陷；非法参数仍启动假 CLI，不能豁免 |
| 实际入口集成: duplicate budget flag rejected before CLI | 失败 | 真实缺陷；非法参数仍启动假 CLI，不能豁免 |
| 实际入口集成: missing budget value rejected before CLI | 失败 | 真实缺陷；非法参数仍启动假 CLI，不能豁免 |

## 过程能力

| 项目 | 实际结果 |
|---|---|
| 同一交付链 lane 连续性 | 5阶段与全部25模型请求均 lane-1 |
| 阶段重试复用 | 本次没有重试；仅有此前本地模拟证据，不能说本轮真实验证了重试 |
| 跨 lane 清单传递 | 本次无跨 lane；5份清单 731–1,346 UTF8字节，实际跨 lane 行为仍仅此前本地模拟验证 |
| 本地检查重复 | 3 个命令各执行一次 |
| 历史读取复用 | 9个fs.read提议执行8个；另外3次task.evidence重新暴露历史内容 |
| 渐进读取 | runner首三页实际按0/3000/6000读取；9000分页混合搜索被整批门禁阻止 |
| 历史大小 | 最终24条；最后请求历史块195,092个JSON字符，输入69,838token；压缩调用0 |
| 阶段候选隔离 | 失败；s2/s3使用s1 candidateRef，s5使用s4 candidateRef |
| 业务状态可信性 | 失败；Host accepted 与独立非法参数探针冲突 |
| 网络 / 用量 | 25/25 HTTP200；六个可比字段完全一致、25唯一账本回执 |
| 额外评测预算 | not_applicable；产品仍有256上限 |
| 环境保护 | 产品文件及281驱动均未变化，候选仅4个文件 |
