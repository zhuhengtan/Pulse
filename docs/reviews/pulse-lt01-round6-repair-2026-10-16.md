# LT01 真实轨迹后的第二轮修复

日期：2026-10-16。由 Codex 直接修改；**本轮仅本地验证，0 次新增真实模型调用**。历史 LT01 仍是49次调用、独立7/11，未覆盖或改成通过。

## 修复结果

| 轨迹问题 | 本轮处理 | 验证证据 |
|---|---|---|
| 模型把字符串接口测成对象接口、混淆provider身份 | 主工作区原有共享模型解析已正确；保持该实现，补强规划/验证指令中的精确接口要求、独立完整入口探针 | 新旧配置、复合字符串、配置profile ID、实际CLI参数与完整report落盘 |
| 生成代码漏掉旧变量、语法检查无法发现运行错误 | 保留当前正确runner；独立探针同时断言执行、评分、report字段和模型身份，不以语法通过代替入口成功 | 三条正向完整入口均通过；历史候选的maxCalls错误保留 |
| 预算别名冲突、重复/缺值参数 | 集中解析预算，先分别读取再校验别名；重复参数、缺值和冲突均在CLI执行前失败，相同别名值允许 | 五条负向入口都无CLI调用 |
| git空仓库观察的非零回执让最后阶段直接阻塞 | 控制器v13允许一次仅修正验证引用的机会，保存citationRepairs；不重开工作、不重试git，不接受非零观察为成功 | 真实128回执回放：纠正后通过；重复错误引用停止；失败必需测试仍阻断 |
| 纯集成核查被标edit、被要求写文件 | Host校验阶段意图，纯核查归verify；明确要求写入指定报告文件仍归edit，只读约束优先 | 原始stage-4、中文/英文核查、指定文档写入和实际编辑回归 |
| 跨阶段重复读、重复检查 | 独立保存已读窗口/写入版本contextRefs，最多128条/阶段；不把它们自动当验收证据。重复读提议在派发前复用原ref，两次纠偏、四次停止；成功稳定检查直接用原回执进入验收 | 交替读取仅执行两次，后续四次提议停止；合法分页、写后新版本、新回答仍放行；真实本地Host两个核查阶段只执行一次检查 |

新运行使用 `pulse.assistant` v13，5–12仍注册用于历史恢复；没有自动迁移等待中的旧会话或重启正式进程。已有预算和恢复保护保持。

检查复用只适用于可见的同命令、参数、cwd及稳定成功回执。更新后的失败不能回退到旧成功。Host在验证前后重新捕获文件/导入依赖范围、检查定义和环境；变化不能通过，失败检查也不能通过删引用变成通过。复用不会新增shell effect或伪造“又执行了一次”的回执。

## 本地过程中追加修复

- 规划恢复分支因补充规则可能超过2KB：缩短指令，把恢复criterion IDs移到结构化上下文；2KB上限未放宽。
- 复用成功检查没有新的候选正文时，旧join逻辑会报“Stage worker returned no candidate result”：v13可凭实际稳定成功检查进入阶段验证，仍需Host和最终逐项验收，不直接判任务完成。
- 已读窗口从“可见上下文”复用后，原ref需要明确进入本阶段证据集合：保留原来源，修复跨阶段引用传播，冷恢复后的持久状态保持。

## 验证

- 新增轨迹回归11项：引用纠正/失败保留、纯核查分类、预算参数、交替读取、合法分页、源码变化、用户回答、旧成功被新失败覆盖、持久状态、跨阶段上下文、实际本地Host复用。
- 独立验收器28项通过。
- 当前评测入口8/8离线探针通过：新配置显式预算、新配置旧别名、旧flat配置、未知模型、零预算、别名冲突、重复预算、缺失预算。正向探针完整运行到实际可信artifact评分器和report落盘；假CLI无Host账本，报告不得声称已确认真实provider预算执行。
- TypeScript构建检查、差异空白检查通过。
- 最终完整本地回归：**148个文件、1215项全部通过**（2个worker，原断言、原超时）。最初高并发全量为1213通过/2超时；H5等待和2001文件搜索随后在原断言、原超时下隔离30/30通过，再降低并发重跑。没有删测试、放宽断言或延长超时。

独立留档探针最初把输出放在输入源码目录的子目录，复制工具按保护规则拒绝（ERR_FS_CP_EINVAL）。随后采用独立最小入口副本及并列输出，8项真实离线探针通过。调试中曾因在纯步骤内打印信息触发纯步骤保护，已移除该调试代码；没有关闭保护。受限执行的EPERM与这些准备/调试失败日志均保留。

## 保留与限制

历史候选五个文件的hash仍与原始回执一致；旧真实结果、请求轨迹和报告保持。全部原有未提交改动保留；未提交、推送、发布或重启正式服务。

这轮验证证明本地流程和当前入口的对应行为，**不证明DeepSeek下一次一定生成正确代码，也不替代新的真实长任务验收**。提示与独立探针已加强，模型生成代码的语义正确性仍要独立检查。外部文件变化而尚无新回执时，复用可能在Host验证处以EVIDENCE_CHANGED安全停止；没有宣称自动重新执行所有失效检查。未做正式安装包、交互式CLI键盘或跨平台验收。

## 证据

- [新增回归](/Users/zhuhengtan/projects/Pulse/tests/lt01-round6-repair.test.ts)
- [最终全量测试](/Users/zhuhengtan/projects/Pulse/.pulse-dev/lt01-round6-repair-20261016/full-tests-confirmed.log)
- [第一次降低并发后的全量测试](/Users/zhuhengtan/projects/Pulse/.pulse-dev/lt01-round6-repair-20261016/full-tests-final.log)
- [初次超时及保留失败](/Users/zhuhengtan/projects/Pulse/.pulse-dev/lt01-round6-repair-20261016/full-tests.log)
- [隔离复现30项](/Users/zhuhengtan/projects/Pulse/.pulse-dev/lt01-round6-repair-20261016/timeout-isolation.log)
- [独立验收器28项](/Users/zhuhengtan/projects/Pulse/.pulse-dev/lt01-round6-repair-20261016/evaluator-confirmed.log)
- [8种完整入口探针](/Users/zhuhengtan/projects/Pulse/.pulse-dev/lt01-round6-repair-20261016/current-entry-probe-verified/result.json)
- [类型检查](/Users/zhuhengtan/projects/Pulse/.pulse-dev/lt01-round6-repair-20261016/typecheck-final.log)
- [改动保留审计](/Users/zhuhengtan/projects/Pulse/.pulse-dev/lt01-round6-repair-20261016/change-audit.json)
- [历史候选核对](/Users/zhuhengtan/projects/Pulse/.pulse-dev/lt01-round6-repair-20261016/history-audit.json)
- [历史真实验收](/Users/zhuhengtan/projects/Pulse/docs/reviews/pulse-real-lt01-after-repair-2026-10-16/README.md)
