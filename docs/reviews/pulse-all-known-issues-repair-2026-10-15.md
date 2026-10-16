# Pulse 已知长任务问题修复与本地验收

日期：2026-10-15。Codex 直接实现；本轮没有请求真实 DeepSeek，没有使用 Pulse CLI 开发，没有提交、推送、发布或重启用户服务。

## 范围与结论

本轮覆盖[第四轮真实运行问题](/Users/zhuhengtan/projects/Pulse/docs/reviews/pulse-long-task-evaluation-round4-2026-10-15/README.md)、[上一轮修复](/Users/zhuhengtan/projects/Pulse/docs/reviews/pulse-long-task-repair-2026-10-15.md)，以及[18 项边界模拟](/Users/zhuhengtan/projects/Pulse/docs/reviews/pulse-boundary-simulation-2026-10-15/README.md)。已经修复可复现的控制、文件恢复和验收缺陷，保留原有修复并追加正反回归。18 项原场景在最终构建上全部达到各自预期；受控停止、拒绝批准和业务未完成不会被改记成业务成功。

原来的真实成绩仍是 0 项完整验收、4 项部分完成、2 项失败，没有通过修改历史现场或更换评分口径补分。本轮不能证明真实模型开放式长任务的完成率已提高。

## 修复矩阵

| 问题 | 根因与修复 | 验证 |
|---|---|---|
| F01 / B18：正常回归 exit 1 被验收为通过 | `expectedFailureRefs` 原先无条件可信。现在由该阶段绑定的原始验收条目授权负向检查；其他条目允许负向测试不授予本条豁免。环境拒绝、超时、取消、没有退出码不能当作正常负向结果。漏引失败的必要检查也不能通过；同一命令后续真实成功可替代早先失败，历史保留 | 真实本地子进程仍 exit 1，业务结果变为 incomplete；10 项误判/合法负向/成功重跑回归 |
| F02 / B09：没写计划就获准实施 | 执行答复必须对应本 run 当前待答 effect，以及已保存并已预览的具体计划。缺少绑定返回 PLAN_PREVIEW_REQUIRED，题目保持待答，不写实现 | 实际 Host，漏计划后执行被拒，随后暂不执行不再派发模型 |
| F03 / B10：计划变化但旧批准仍有效 | 持久 gate v2 绑定 runId、effectId、planPath、hash、previewRef、cwd、this-run scope。在答复时及每次后续操作前核对；变化后关闭门，展示新版并要求再次明确确认。旧无版本批准不能在恢复后自动开门 | 等待中修改、删除、批准后修改、重新预览再批准；既有长计划冷恢复四条路径继续通过 |
| F04 / B11：矛盾按钮被识别成实施 | 只接受 choice 类型、保守顺序、唯一 opaque value 和已知明确标签；拒绝“执行（仅查看，不实施）”等矛盾附注 | 4 种冲突标签、multi 类型、反序、任意 A/B、重复 value 均不授权；正常原生值和否路径保持 |
| F05 / B01+B17：跨任务草稿串用 | Host 提供 run 归属，模型参数不能伪造；草稿和索引按 owner＋规范化路径定位，inspect/append/commit 核对 owner。同 run 恢复，独立 run 各自保留内容 | 两段实际 Host 会话同名报告，第二段只拿到客户 B 的正文；直接越权 inspect 被拒 |
| F06 / B05：空补丁算进展 | patch 回执增加 beforeHash/changed；相同文件结果不因 find/replace、次数等变化而成为新进展。纯空补丁不能算阶段已编辑，也不能重置停滞计数 | 单补丁和合并补丁均四轮停止；原有真实改动、分页和新回答回归保持 |
| F07 / B06：同题干误拒新决定 | 身份包含工具类型、完整选项、decisionScope、稳定 decisionId。题干相同但选项/决定不同仍可问 | 排障选择与测试/文档选择均呈给模拟用户；相同完整决定仍拦截 |
| L01 / B07：换措辞重复访谈 | 内置技能要求稳定决策 ID；同 ID 改写不得重问。对原有报告布局场景有保守的相同选项适配，通用 A/B 不合并。用户明确改意后允许一次新版本，随后重复再次停止 | 原四种布局措辞只问一次；显式 ID、通用不同问题、用户改意并从 A 改 B 均覆盖 |
| F08 / B03：commit 旧回执冒充当前文件 | 幂等 commit 也核对当前目标，变化/删除返回 DRAFT_TARGET_CHANGED，不覆盖外部内容。Host 在阶段/最终验证调用前后检查最新文件证据；受影响阶段标记 EVIDENCE_CHANGED，其他阶段保留，不全量重规划 | 未变化仍幂等；用户修改/删除明确冲突。验证前、验证中、最终验证中外部修改均不能验收，DSML 正常流程保持 |
| F09 / B04+B02：索引崩溃窗口与孤儿 | 新草稿 ID 由 owner＋路径稳定派生；正文先落盘，重复 begin 不依赖索引即可找回。并发 begin 收敛到同一持久正文，索引为辅助发现信息，不按时间盲选或删除草稿 | 索引写入故障后找回原正文；4 个并发 begin 返回同一 ID/正文，仅一个草稿，目标未创建 |
| F10 / B08：问答登记表随访谈增长 | 模型表面最多约 8 KiB 当前决策数据，完整回答保留在 ResultRef，长条目标记 incomplete。task.decisions 分页列原问题与回复引用，task.evidence 取原文。普通请求不重复注入全部原始回复 | 30 题与实际历史压缩，全部原文保留；100 条决策表面有界。详见下方测量 |

### 原真实轨迹的既有修复

LT01/LT03 草稿轮转、LT02 相同窗口循环/虚构验证转录/超长纠错、完成阶段重复规划、预算历史恢复、LT05 文档旧语义误判、LT06 原生选项及暂不执行后追加调用等修复继续保留。对应源码、定向回归和验收器离线检查全部纳入本次完整测试。没有重做已完成交付，也没有修改六个历史任务的产物来让旧评分通过。

## 本轮补测捕获并修复的接缝

1. 新增文件新鲜度检查最初放入纯计算步骤，造成 DSML 合法流程误拒。已移到 Host 的验证 Effect 调用前后；文件 I/O 不在纯 Step 中执行。保留初始失败日志。
2. 新增负向检查反例捕获没有退出码也可被当作 expected failure，已要求实际整数非零退出，并排除环境/超时/取消。
3. 一个任务包含负向与正常验收条目时，原始目标的整体负向许可可能越界。改为核对当前阶段绑定的每条原始验收条目；正向条目不能继承其他条目的豁免。
4. 计划变更后再次使用相同最终问题，旧重复检测会误挡第二次批准。最终问题的身份现在由实际保存回执的内容 hash 派生，新计划版本需要新的显式批准。
5. 用户改意事件消费后不能恢复成旧的空版本，否则会额外重问。当前决策版本在登记表中接续；每次真实修改只开放一次，旧回答仍留原始引用。

## 验证与测量

- 最终类型构建：通过。
- 完整本地测试：144 个测试文件、1164 项全部通过。
- 离线验收器：25/25 通过，包括独立 worker 恢复、原截止、原预算、否路径、文档负例和报告输出。
- 原边界场景：18/18 达到预期，基于真实 Host/Runtime/文件工具及本地进程，模型响应由脚本提供。没有人工临时替模型修复产物来提高成绩。
- 新增永久回归：23 项控制/访谈/计划/草稿，10 项验收误判，4 项 Host 文件新鲜度；另保留既有长计划与冷恢复回归。
- 相同的 30 题访谈：显式 conversation 从 94,476 字节降至 8,337 字节；整个内部 Effect 从 368,048 降至 33,698 字节。后者含内部重复表示，不能当作 API token 数或费用。仍发生 18 次历史压缩，全部 30 条原始回复可取回。
- 100 条决策有界表面测试通过。额外尝试过无持久存储的 100 题运行：默认 1 MB 存储护栏在第 86 个回答后受控停止，未放宽护栏；因此没有把它记为默认条件下 100 题执行通过。原日志保留。真实 Host 持久化与无持久化 SDK 的存储条件不同。

完整回归有一次与其他套件同时运行时，H5 配对用例达到原 10 秒期限；没有增加期限或改断言。独立 H5 的 22 项全部通过，随后单独执行最终完整测试。测试环境只允许必要的本地回环假服务。

## 证据与复跑入口

- [原场景最终重放结果](/Users/zhuhengtan/projects/Pulse/.pulse-dev/all-known-repair-confirmed-20261015/results.json)
- [B18 真实失败进程与验收状态](/Users/zhuhengtan/projects/Pulse/.pulse-dev/all-known-repair-confirmed-20261015/B18/result.json)
- [长访谈逐次字节测量](/Users/zhuhengtan/projects/Pulse/.pulse-dev/all-known-repair-confirmed-20261015/B08/size-details.json)
- [类型构建](/Users/zhuhengtan/projects/Pulse/.pulse-dev/all-known-repair-20261015/typecheck-final.log)
- [最终完整本地测试](/Users/zhuhengtan/projects/Pulse/.pulse-dev/all-known-repair-20261015/full-tests-complete.log)
- [验收条目权限回归](/Users/zhuhengtan/projects/Pulse/.pulse-dev/all-known-repair-20261015/criterion-scoped-final.log)
- [离线验收器](/Users/zhuhengtan/projects/Pulse/.pulse-dev/all-known-repair-20261015/evaluator-confirmed.log)
- [保留审计](/Users/zhuhengtan/projects/Pulse/.pulse-dev/all-known-repair-20261015/final-audit.json)

可复制命令：

```sh
cd /Users/zhuhengtan/projects/Pulse
pnpm exec tsc -b --pretty false
pnpm exec vitest run tests/known-boundary-repairs.test.ts tests/verification-boundary-repairs.test.ts tests/evidence-freshness-host.test.ts --maxWorkers=2 --minWorkers=1
node scripts/ci/test.mjs
node --test --test-concurrency=1 scripts/eval/long-task-calibration.test.mjs scripts/eval/long-task-workflow.test.mjs scripts/eval/long-task-grader.test.mjs scripts/eval/long-task-supervisor.test.mjs scripts/eval/long-task-transport.test.mjs
```

## 保留事项和验证边界

原有未提交改动、历史运行、真实调用账本与正式配置保留。四轮旧账本仍为 93 / 2 / 1 / 299 次。本轮不自动启动下一次真实模型验收。

通用开放问题的语义同义识别仍依赖稳定决策 ID；本轮不宣称能识别任意模型刻意更名的相同意图。旧版没有 owner 的草稿无法安全推断归属，保留原件并拒绝跨 run 自动接管；历史无索引、无归属孤儿需要人工确认归属后迁移，不能按时间猜测。新格式的索引中断恢复已经验证。

计划版本在答复和每次操作前核对，文件证据在验证调用前后核对；不是跨进程文件事务。未进行真实模型完成质量复验、终端方向键/Enter 实测、跨平台或发布包验收。文档关键词与已知矛盾负例通过不等于通用语义事实全部正确。
