# Pulse deterministic benchmarks

该目录提供架构第 27 节要求的第一版调度对照基准，不访问网络、不调用真实模型，也不测量模型质量。

先构建 Runtime，再运行：

```bash
npm run build
node benchmarks/deterministic.mjs
PULSE_BENCHMARK_RUNS=100 node benchmarks/deterministic.mjs
```

基准固定 4 个立即完成的 Tool 操作，对比：

- `serial`：单 Lane 逐个等待；
- `batch`：单 Lane 批量提交并等待；
- `lanes`：多 Lane 独立推进后汇合；
- `coalesced`：请求 `forkAffinity: 'coalesce'` 的同系列多 Lane。

输出包含每个模式的样本、平均值、p50/p95、终态分布、平均 Effect 数和平均 Lane 数。它只用于回归调度开销与结构变化；真实 Provider 的延迟、费用、缓存命中和任务质量必须另行采集。
