# SDK 长任务的历史与诊断

通用 `PulseRuntime` 不会替任意自定义程序自动设计摘要。长任务使用 DSL 时，应为程序显式配置历史压缩，并为摘要任务接好真实 Effect 执行器：

```ts
import { defineLaneProgram } from '@hunterzhu/pulse-runtime'

const program = defineLaneProgram({
  id: 'long-task',
  version: '1',
  historyCompaction: {
    summarizeTask: 'reason',
    keepRecentRounds: 4,
    instruction: 'Preserve the original goal, user constraints, accepted stages, failed evidence and pending questions.',
  },
}, builder => {
  builder.addReActLoopStep('work', {
    instruction: 'Complete the requested work and preserve verifiable evidence.',
    maxTurns: 32,
    onFinish: () => ({ complete: { finished: true } }),
  })
})
```

`maxTurns` 只约束该循环。模型实际调用预算需要宿主在 provider attempt 入口累计计算；`createLocalHost` 的 `maxModelCalls` 已覆盖本次 work run 的审批、压缩、重试与恢复。不要把轮数当成实际费用边界，也不要为了压缩而重置整个任务预算。

## 错误处理

- `CONTEXT_TOO_LARGE`：历史超过硬限制，程序仍无法提交有效压缩。Runtime 在连续控制错误达到既定上限后仍失败，但对外保留这个原始错误码和历史压力详情，并提示 `historyCompaction`。不会把失败标为成功，也不会自动删历史或无限重复模型请求。
- 其他重复控制错误仍报告 `CONTROL_ERROR_LOOP`，并保留 `details.lastError`。
- 失败现场可用 `runtime.exportPersistence()` 保存作诊断。终态失败快照不会因为重新`start()`而自动复活；继续工作需要恢复超限前的可运行检查点，或由宿主显式发起continuation并重新验证可复用证据。恢复遵守既有程序版本兼容规则，不能直接篡改持久化JSON绕过限制。

本地20轮双工具校准表明，未配置压缩时会触及历史硬限制；配置后同规模 fixture 完成。这不是任意任务都能完成的保证，真实摘要的需求/证据保真仍需单独验收。Pulse Host 的默认任务路径已配置压缩，不能把通用 SDK 的缺省行为等同于 Host。
