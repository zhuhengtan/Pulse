# 离线校准报告

实际执行日期：2026-10-15。报告目录沿用已批准计划的2026-10-14名称。

## 已执行

| 范围 | 结果 | 证据 |
|---|---|---|
| 现有长任务定向回归 | 10文件 / 173项通过 | `.pulse-dev/long-task-offline-20261015.log` |
| 重试与上下文压缩 | 2文件 / 6项通过 | `.pulse-dev/long-task-offline-extra-20261015.log` |
| HTTP JSON/SSE/Runtime 传输 | 1文件 / 3项通过，本机假服务 | `.pulse-dev/long-task-http-offline-20261015.log` |
| 新增规模/账本/需求方模拟/故障校准 | 11项通过（含一个预期失败边界） | `.pulse-dev/long-task-calibration-20261015.log` |
| 真实 Host + 本地假 HTTP 模型 | 16次 fake 请求后按累计预算终止，账本、Host usage 与服务端计数一致 | `.pulse-dev/long-task-transport-20261015.log` |
| TypeScript project build | 通过 | `.pulse-dev/long-task-typecheck-20261015.log` |

上述10文件覆盖 task-controller、task-efficiency、task-continuity、dsl-react-contract、host-model-budget、model-budget、provider-network-diagnostics、verification-policy、grill-and-plan-workflow、incremental-editing。

## 按场景解释

1. **执行链长度**：5、10、20轮串行均完成；5、10轮每轮两项独立工具也完成。
2. **未配压缩的历史边界**：20轮双工具路径实际失败，`CONTROL_ERROR_LOOP` 包含 `CONTEXT_TOO_LARGE`，历史估计16196 tokens超过hardTokens16000。保留为预期负向用例；未通过放宽 Runtime 上限消除此失败。
3. **启用压缩**：同规模20轮双工具，启用 DSL historyCompaction 后完成，实际触发摘要；模拟执行器保留完成进度。此结论仅针对这个 fixture。
4. **循环与分页**：现有回归验证A/B重复读取、输出波动去噪、合法UTF-8分页、真实修改/新回答属于进展。不能因此保证所有语义性调查循环都被识别。
5. **证据与连续性**：通过检查点复用、相关文件失效及依赖传播、无关文件不重开、失败证据不伪装成功、阶段上限最终否决等回归。shell/外部证据不自动复用。
6. **交互恢复**：模拟访谈长计划保存与预览、同名保留、冷恢复同题和两条最终选择路径均覆盖。真实模型是否能正确发起这些工具，另见真实样本。
7. **费用边界**：主模型、审批、压缩、前置模型、内部重试及恢复的既有回归通过。新增外部预算账本六例累计96次耗尽、重读不重置、损坏失败；Host+HTTP fake 实测16次后终止，没有自动另开 run。
8. **拒绝和诊断**：拒绝/取消后停止等价重试、严格检查白名单、网络原因码脱敏覆盖。现有重试测试验证指数退避、禁止重复写、存储满时拒绝 admission。新增校准验证429保留可重试的 provider 错误码、慢工具接收 AbortSignal 并按取消结束。

## 解释与优化建议

未配置压缩的长历史失败是可重复的 SDK 配置边界，不能直接归咎于 Host 默认路径。可在 SDK 示例/诊断中提前提示历史压力，直接报告 `CONTEXT_TOO_LARGE`，避免最终由泛化 `CONTROL_ERROR_LOOP` 遮盖原因。建议增加真实 Host 在长历史下的任务语义保留测量；当前模拟摘要不能评价信息丢失质量。

## 未覆盖及限制

不是全平台验收，没有性能/内存容量基准，没有证明几十小时任务稳定性。429仅验证错误分类，没有测真实服务退避；慢工具仅测服从 AbortSignal 的执行器，没有覆盖不响应取消的进程。账本采用一个串行 supervisor，本次不支持多个独立 supervisor 同时写。真实 API 失败不能用本地假HTTP通过替代。
