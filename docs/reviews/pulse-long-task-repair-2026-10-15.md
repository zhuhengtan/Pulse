# 第四轮长任务问题修复与本地验收

日期：2026-10-15（Asia/Shanghai）。对应[第四轮真实报告](/Users/zhuhengtan/projects/Pulse/docs/reviews/pulse-long-task-evaluation-round4-2026-10-15/README.md)。本轮由 Codex 修改，**没有调用真实 DeepSeek**，不提交、推送或发布，不重启开发或正式服务。

## 修复内容

| 原问题 | 本轮修改 | 本地证据 |
|---|---|---|
| LT01/LT03反复 begin/inspect，草稿不落盘 | 同一目标的 begin 恢复持久活动草稿，返回原编号、最新版本及最多1024字节UTF-8尾部；不丢弃已有追加内容。进展按目标/内容hash/字节数/提交状态判断，不按UUID判断 | 编辑器重建后接续、追加、语法检查、提交；交替begin/inspect四轮无进展后停止，只有一次纠正 |
| LT02同一窗口反复读取 | 请求先规范化到3000字节有效上限；比较实际文件hash、offset、nextOffset和内容；后续阶段已提供的读取证据也参与判断 | 大小参数变化仍识别相同窗口；新页、内容变化和新回答仍允许；原分页回归保留 |
| 无进展停止后仍重规划 | NO_PROGRESS、调查耗尽、重复工具失败、验证器异常/虚构引用不自动触发目标恢复 | 阻断状态及真实证据保留；独立阶段仍可正常收尾，不用新计划重做该阶段 |
| LT02验证纠错撞2KB限制 | 原始输出保存在ResultRef；纠错控制指令固定、简短，字段路径/错误代码作为数据，原任务指令单独保留为输入；只允许一次纠错 | 长枚举错误/伪工具转录只得到一次纠错，最终仍是格式失败，不是指令超长 |
| 验证模型虚构result-151并要求重写 | 不可见引用不能授权纠正；验证器两次无效后只阻断验证，不回到实现、重写文件或重新规划 | 已写文件仅写一次、真实证据保留、业务状态incomplete；未将失败改成通过 |
| LT02候选恢复实现丢历史预算 | 正式runner继续继承去重历史消耗，并补充已耗尽及原预留超出剩余额度的派发前检查 | 真实runner配假CLI：历史消耗超限时不增加调用、不改历史；原中断恢复和损坏JSONL检查保留。没有修改历史受测副本来伪造其成绩 |
| LT05文档关键词过关但语义错误 | 修正文档的4次总尝试、Host持久账本、显式截止及恢复语义；grader从实际源代码提取版本/尝试次数，拒绝旧追加尝试承诺、删账本建议和恢复混淆 | 同样包含关键词的错误文档必须失败；正确文档通过。机械检查仍不替代人工语义复核 |
| LT06重复问已答问题 | Runtime持久保存问题、选项、选中label/value、原回复与引用；压缩/恢复后继续作为决策数据提供；相同题干的重复提问不再发送给用户 | 第一次重复给纠正，继续重复则停止；新问题即使也回答A仍算进展；恢复执行分支保留前面的访谈结论 |
| Host/验收器不识别hold/execute | 共用保守项在前的最终确认解析器，允许说明性括号但保留真实选项value；反序、重复value、任意A/B标签不视为最终门 | 中文和原生value两套格式，执行/暂不执行两条路径均冷恢复验证；原计划保留、长计划保存及完整预览 |
| 暂不执行后仍付费收尾 | 原生回复成功后由Runtime直接结束，不再请求主模型或验证模型 | 冷恢复后暂不执行的调用计数不增加；实际监督进程模拟只走到最终确认，没有实施续轮或实现文件 |
| 验收重启/人工等待刷新截止 | worker沿用started.json的绝对截止；传输派发、恢复和答复前检查；未知问题等待也会按原截止退出 | 本地实际进程冷启动、同run/同pending/原调用账本不变；过期恢复零派发、零自动答复 |
| 访谈模拟器用无关事实回答未知偏好 | 只答已确认维度；报告布局按真实选择匹配，未知开放问题保持等待 | 未知配色问题不自动回答；原生最终确认立即识别，避免再次人工适配至超时 |
| 报告生成格式及环境归因 | 生成真实Markdown换行，未运行时不编造审批阻塞；沙箱准备失败标记为环境未执行，不能算产品行为失败 | 报告格式回归、无模型生成检查、grader负向检查 |

研究/多文档阶段也改为先形成短小且完整的交付，再深化；空大纲不当作交付。这个调度提示的真实完成质量尚未重新测量。

## 本地验证

- 类型构建：通过。
- 新增真实轨迹回归：13项，覆盖长验证错误、草稿轮转、恢复接续、同窗口规范化、伪引用、停止后不重规划及访谈重复/合法新回答。
- 计划工作流：4条模拟路径，覆盖中文/原生值 × 执行/暂不执行；包括长计划、旧件保留、预览和同会话恢复。
- 验收器：25项离线检查，含真正的独立worker进程退出和冷恢复。本地假HTTP服务仅监听127.0.0.1，不访问外部模型。
- 完整本地测试：141个测试文件、1127项全部通过；最终源代码审计见下方记录。

可复制命令（仅本地模拟）：

```sh
cd /Users/zhuhengtan/projects/Pulse
pnpm exec tsc -b --pretty false
pnpm exec vitest run tests/round4-regressions.test.ts tests/grill-and-plan-workflow.test.ts tests/eval-runner.test.ts tests/task-controller.test.ts
node --test --test-concurrency=1 scripts/eval/long-task-calibration.test.mjs scripts/eval/long-task-workflow.test.mjs scripts/eval/long-task-grader.test.mjs scripts/eval/long-task-supervisor.test.mjs scripts/eval/long-task-transport.test.mjs
node scripts/ci/test.mjs
```

## 过程问题与边界

第一轮定向回归发现新进展判断错误地把“本轮刚返回、已被控制器加入上下文”的引用当成旧证据，造成假循环；已排除当前待结算引用，相关阶段验收/重试回归通过。原生value工作流也捕获到预览仍使用中文伪答值，以及暂不执行后继续调用模型的问题；均通过实际路径修复，未降低检查要求。

受限执行环境中的回环Node测试曾触发底层Node断言崩溃；允许本地回环后重复验证通过。测试夹具也补齐started.json，并单独处理压缩请求；原失败日志保留，未归咎于业务实现。

本地模拟证明上述控制行为，不证明真实DeepSeek在开放任务中的完成质量已经提高。不同措辞但语义重复的问题由已确认决策上下文帮助模型识别，确定性阻断目前只针对相同题干；文档语义检查仍有人工复核边界。原第四轮2失败/4部分完成结果保持不变；不补分，不补真实样本。没有验证交互终端方向键/Enter、跨平台或发布包。

## 证据

- [类型构建日志](/Users/zhuhengtan/projects/Pulse/.pulse-dev/repair-round4-20261015/typecheck-final.log)
- [最终定向回归](/Users/zhuhengtan/projects/Pulse/.pulse-dev/repair-round4-20261015/focused-confirmed.log)
- [验收器最终回归](/Users/zhuhengtan/projects/Pulse/.pulse-dev/repair-round4-20261015/evaluator-confirmed.log)
- [完整本地测试](/Users/zhuhengtan/projects/Pulse/.pulse-dev/repair-round4-20261015/full-tests-verified.log)
- [开始前未提交改动备份](/Users/zhuhengtan/projects/Pulse/.pulse-dev/repair-round4-20261015/before.patch)
- [最终改动与保护审计](/Users/zhuhengtan/projects/Pulse/.pulse-dev/repair-round4-20261015/final-audit.json)

## 后续修复记录（2026-10-15）

上述内容保留为发现/验证当时的记录。后续已由 Codex 直接修复并完成离线回归，见[全部已知问题修复报告](/Users/zhuhengtan/projects/Pulse/docs/reviews/pulse-all-known-issues-repair-2026-10-15.md)。原始真实任务成绩、失败现场及调用账本保持不变；没有追加真实模型调用。
