# 问题清单与优化方案

以下为本例实测及对应源码定位，尚未在本轮修复。

## P0：任务分类漏掉真实编辑意图

阶段t3要“将config-budget.mjs接入scripts/eval/run.mjs”，却被stageRequiresFileChange判为false；t4“更新evals/README.md”也为false。对实际阶段调用编译函数已复现。state.ts:127的validation正则在文件名run.mjs中匹配run，且directEdit要求句首动作词，句首“将”未覆盖；中文“更新”也未包含。因而实现阶段的强制编辑门未启用，模型可持续读取。

优化：规划阶段保存显式stage kind，代码约束独立于模型生成的goal措辞；兼容旧计划时识别中文宾语前置、更新和集成动作，排除路径、标识符中的run/test/check。回归使用本轮原始t3/t4文字、英文文件名和真正只读任务，不把只读研究强制改成写操作。

## P1：通过测试仍反复执行，证据去重被波动内容击穿

同一个node --test scripts/eval/config-budget.test.mjs执行6次，全是10/10通过，CheckReceipt.files与definitions没有改变；实际toolEvidenceHash却得到6个不同值。program.ts:207仅过滤shell顶层耗时，stdout含每项Node测试耗时和duration_ms，outputArchive还含随机ID和不同输出摘要，均进入哈希。编辑阶段的测试也未触发仅针对非编辑阶段的validation checkpoint。

优化：检查复用以实际命令/参数、cwd、CheckReceipt文件版本、退出码及稳定测试结果为准；日志原文、归档身份和时间保留但不作为新进展。语义归一不能抹掉失败断言；相同源码的已通过检查直接复用，文件变化后重验。覆盖“编辑后通过检查再重跑”、归档ID变化和TAP耗时变化。

## P1：纠偏自身格式失败，回到原循环

请求38 nextAction为508字符，超过schema的500；请求39格式纠错返回76个空白字符。第二次OUTPUT_SCHEMA_VIOLATION后progress-review-worker.onError直接回work-stage-worker，没有提供可用的新动作；随后继续读取同一首屏，最终NO_PROGRESS。

优化：提示明确字段长度；错误恢复保留已有有效字段并要求只补缺字段，空白响应不当作有效纠偏。纠偏失败时给出确定性的当前缺口/已有文件窗口，或者保存明确阻塞检查点，不能原样返回循环；保留格式失败证据。

## P1：结束报告引用旧阶段，和当前产物矛盾

Runtime结果正文仍说scripts/eval没有config-budget.mjs，而该文件已提交并通过测试；只在尾部笼统提示仍未完成。业务status正确为incomplete，没有误标accepted，但正文没有说明t3的真正阻塞和当前交付清单。

优化：根报告从当前controller阶段和实际文件回执生成，优先总结最新成功阶段及首个失败原因，历史发现注明时间/阶段；增加“早期文件不存在→后来创建→后续阶段失败”的本地回归。

## P1：归档后辅助usage统计不完整

HTTP usage42份全部完整。根预算的调用42、input848924、output30472正确；但Host缓存输入410624低于HTTP658432，推理为null而HTTP合计18917。index.ts:235的runUsage从活跃runtime.state.events汇总缓存/推理/latency，归档后只用durable ledger补了input/output/cost。该遗漏不影响本例调用预算，但会低估缓存等辅助指标。

优化：根账本持久累计cached/uncached/reasoning/visible/latency及已知计数，或聚合完整归档且保持去重。各字段单独标注完整性，不能因input/output完整就让其他部分统计被理解为全量。回归在归档前后比较所有HTTP字段。

## P2：规划粒度与隐含上限

该维护任务被拆为6个阶段；t1工作12次再验证1次，且调查报告已有，消耗偏高。无限预算模式当前也不存在：Host和controller均钳制到256。42次停止原因是NO_PROGRESS，不能归因于该上限。

优化：按交付依赖拆调查、实现、验证，已有报告作为调查输入即可；引擎若支持显式无调用上限，应保留持久用量、循环检测、取消和审批，不用超大数字冒充无限。此项仅记录，不在本轮更改限制。

## 评测器边界

原评分器预设整数预算，对本轮null上限计算出的总分没有意义，本报告不使用provisionalScore。原始6个验收点仍按冻结要求检查，没有放宽。初次额外假CLI探针缺少候选副本adapters/dist，保留原错误；第二次使用字节相同runner副本及明确的假评分器，仅测参数转发，证实旧flat路径也未传--max-model-calls（预期9、实际null）。这不是完整生产评分器验收。离线探针的一次自动审批超时，没有认定不安全；随后在普通受限环境执行成功，未增加真实请求。

后续优先用这42次脱敏轨迹做本地回放，验证分类、纠偏、证据复用、报告和usage后再考虑新的真实运行。
