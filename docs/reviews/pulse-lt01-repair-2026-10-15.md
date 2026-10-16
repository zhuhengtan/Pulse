# Pulse LT01 执行流程与验收器修复

日期：2026-10-15。当前状态：**本地修复及验证完成；2026-10-16唯一真实重跑已执行，49次调用，独立验收7/11，任务未完整通过。**

## 已完成

| 问题 | 修复 | 本地证据 |
|---|---|---|
| 将 `run.mjs` 中的 run 当作验证动作，漏掉接入与更新 | 新运行使用控制器v12，持久保存edit/verify/analyze阶段意图；剥离路径和标识符后识别动作，明确编辑需求覆盖错误的analyze分类，只读描述优先 | 原始t3/t4文字、只读任务、路径与标识符回归 |
| 调查、范围确认过度拆阶段 | 单一交付所属的纯调查前置阶段可合并，保留需求ID、检查、依赖；已通过阶段不重新打开 | DAG和需求覆盖断言；原有控制器回归 |
| 六次通过测试仍被当成新进展 | 身份包含实际命令、参数、检查范围版本、检查定义、环境及稳定结果；只去掉已识别测试格式的时间字段及归档身份，保留失败与归档错误 | 六份真实成功回执现在得到同一个哈希，断言失败、源码变化仍不同 |
| 编辑后缺少验证检查点 | 根路径和独立worker均在成功检查后进入阶段验收，待执行的串行工具不会被检查点丢弃 | 控制器、子任务、负向检查和阶段上限回归 |
| 超长/空白纠偏后原样回到循环 | 保留500字符限制和一次结构修复；只允许一次有真实回执支持的未读分页，否则保存PROGRESS_REVIEW_UNAVAILABLE | 原508字符指令及空白响应；根/worker分页恢复与无分页停止 |
| 早期正文覆盖当前结束报告 | Host优先使用控制器根报告；调查阶段的旧候选正文不充当当前交付，汇总当前阶段、文件回执和依赖阻塞 | 早期“模块不存在”候选与当前“已交付、集成受阻”汇总的Host回归 |
| 事件归档后缓存/推理等usage丢失 | 持久累计各字段及已知次数；使用独立请求回执身份去重，避免不同审批运行内部编号相同造成漏记 | 42份HTTP usage回放、自动归档和同一问题冷恢复 |
| 部分usage被当零或可用 | 已知字段分别保留，缺失字段未知；只有耗时可用时，token completeness仍为unavailable | 旧账本、部分响应、失败请求原有断言均保留 |
| 无额外预算被评分器扣分 | null表示没有额外评测上限，预算项not_applicable；产品256次硬上限仍保留 | null及混合有限/无限账本、报告生成回归 |
| 假CLI集成探针缺编译依赖 | 独立副本提供可信编译依赖；使用真实artifact评分器，候选不能替换独立评分器；假CLI只用于入口参数控制流 | 新旧配置、预算参数、非法引用/预算及原候选不变检查 |

## 验证结果

- 最终完整本地非live测试：**147个文件，1204项通过**。
- 独立Node验收器：**28/28通过**，含本机模拟HTTP、预算耗尽、冷恢复、报告和真实编译评分器探针。
- TypeScript构建检查、`git diff --check`通过。
- 新增真实轨迹回归数据只含工具回执和用量，不含用户配置、密钥、认证链接或推理正文。
- 回放的42次历史请求总数及输入/输出保留，缓存输入658432、推理输出18917与HTTP记录一致；后二者是子集，不重复相加。
- 旧v11的纠偏兼容行为有独立测试；新v12的确定性停止另有测试，没有改成接受失败。

本地过程中发现并修复了独立审批请求编号冲突、旧评测冻结文件缺少预算字段、隔离评分器缺typescript依赖及整体usage完整性兼容问题。失败和中间日志均保留。第一次归档回归错误地在等待用户回答时调用了等待终态的usage接口；测试现先验证持久账本，冷恢复后明确取消本地样本，再核对终态usage，没有改变产品接口的等待语义。

## 真实重跑准备与执行

已准备新的LT01副本，保留与上一轮相同的历史runner/README缺陷及原始验收要求。仅补充当前可信编译的model-config.js，供复用现有目录解析功能；完整评分器依赖只在独立探针中提供。旧报告和历史运行没有覆盖。

最新模型列表预检HTTP200（2026-10-15T15:54:27Z），deepseek-flash可用，0生成调用。用户回答“允许”后再次申请启动，但自动审批仍认为短回复未明确覆盖非公开源码及DeepSeek目标地址，拒绝派发；进程未启动。已补充要求完整授权表述的问题，没有绕过或换入口执行。

用户随后完整明确授权源码及脱敏资料发送DeepSeek；北京时间2026-10-16实际运行已完成：49次HTTP200，产品上限256，额外评测上限未设置。Runtime succeeded，业务incomplete；三个交付已落地，最后阶段因引用空仓库git log的非零退出而阻塞。独立验收7/11，补充语义5/9，确认复合引用未实现、旧入口残留maxCalls、别名冲突未提前拒绝等新缺陷。现有稳定检查身份和usage对账通过，但不能宣称业务完成或冗余消除。没有追加真实run。

详细报告：[修复后唯一真实验收](/Users/zhuhengtan/projects/Pulse/docs/reviews/pulse-real-lt01-after-repair-2026-10-16/README.md)。

## 证据

- [本地完整测试](/Users/zhuhengtan/projects/Pulse/.pulse-dev/lt01-repair-20261015/full-tests-final.log)
- [独立验收器](/Users/zhuhengtan/projects/Pulse/.pulse-dev/lt01-repair-20261015/evaluator-final.log)
- [类型检查](/Users/zhuhengtan/projects/Pulse/.pulse-dev/lt01-repair-20261015/typecheck-final-confirmed.log)
- [本地改动与保留核对](/Users/zhuhengtan/projects/Pulse/.pulse-dev/lt01-repair-20261015/local-audit.json)
- [新增真实轨迹回归测试](/Users/zhuhengtan/projects/Pulse/tests/lt01-execution-repair.test.ts)
- [原始失败报告](/Users/zhuhengtan/projects/Pulse/docs/reviews/pulse-real-lt01-2026-10-15/README.md)
- [新一轮冻结输入](/Users/zhuhengtan/projects/Pulse/.pulse-dev/long-task-eval-round6-20261015/frozen.json)
- [网络预检](/Users/zhuhengtan/projects/Pulse/.pulse-dev/long-task-eval-round6-20261015/preflight.json)

保留全部原有未提交改动与历史评估记录；未提交、推送、发布或重启正式服务。未做跨平台或正式包验收。
