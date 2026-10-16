# 真实调用过程记录

使用修复后的Pulse Host，保持初次冻结的历史维护场景输入。逐请求证据包含API状态、usage、可见输出及工具参数；不保存凭据或推理正文。

阶段表只统计归属阶段的模型请求；独立审批也计入Host根账本。费用核算以外部attempts、HTTP usage和Host根账本三者对账为准，未知usage不当作0。

## LT01 修复真实评测入口的模型选择与调用预算 (low)

- 开始：2026-10-15T02:12:00.334Z；结束：2026-10-15T02:15:01.228Z。
- 实际请求预留1/64；已记录HTTP响应0；状态未知。
- Runtime：failed；Pulse业务自评：failed。
- 工具操作0；完全相同工具/参数/语义结果再次出现0次。这是诊断计数，不自动等同于无效循环。

### 请求时间线

| 请求 | UTC开始时间 | HTTP | 完成原因 | ms | input/output/reasoning |
|---:|---|---:|---|---:|---|
| 1 | 2026-10-15T02:12:01.008Z | 等待/未知 | 未知 | 未知 | 未知 / 未知 / 未知 |

### 执行阶段

| 阶段 | 状态 | 尝试数 | 阶段模型计数 | 调查轮数 |
|---|---|---:|---:|---:|

原始证据：[attempts.jsonl](/Users/zhuhengtan/projects/Pulse/.pulse-dev/long-task-eval-round3-20261015/LT01/attempts.jsonl)、[events.jsonl](/Users/zhuhengtan/projects/Pulse/.pulse-dev/long-task-eval-round3-20261015/LT01/events.jsonl)、[diagnostics.json](/Users/zhuhengtan/projects/Pulse/.pulse-dev/long-task-eval-round3-20261015/LT01/diagnostics.json)、[Runtime快照](/Users/zhuhengtan/projects/Pulse/.pulse-dev/long-task-eval-round3-20261015/LT01/data/conversations/conv-b4fcdd25-bd43-4140-8b6b-b1fdabfb3ac9/runs/run-58ba9630-0b1d-4ecc-9cb1-c88db04d8817/runtime.json)。

## LT02 为批量评测补充可恢复执行 (high)

- 开始：尚未开始；结束：运行中或未开始。
- 实际请求预留0/64；已记录HTTP响应0；状态未知。
- Runtime：运行中/未知；Pulse业务自评：未知。
- 工具操作0；完全相同工具/参数/语义结果再次出现0次。这是诊断计数，不自动等同于无效循环。

### 请求时间线

| 请求 | UTC开始时间 | HTTP | 完成原因 | ms | input/output/reasoning |
|---:|---|---:|---|---:|---|

### 执行阶段

| 阶段 | 状态 | 尝试数 | 阶段模型计数 | 调查轮数 |
|---|---|---:|---:|---:|

原始证据：attempts.jsonl（未生成）、events.jsonl（未生成）、[diagnostics.json](/Users/zhuhengtan/projects/Pulse/.pulse-dev/long-task-eval-round3-20261015/LT02/diagnostics.json)。

## LT03 整理真实失败运行与消耗账本 (low)

- 开始：尚未开始；结束：运行中或未开始。
- 实际请求预留0/64；已记录HTTP响应0；状态未知。
- Runtime：运行中/未知；Pulse业务自评：未知。
- 工具操作0；完全相同工具/参数/语义结果再次出现0次。这是诊断计数，不自动等同于无效循环。

### 请求时间线

| 请求 | UTC开始时间 | HTTP | 完成原因 | ms | input/output/reasoning |
|---:|---|---:|---|---:|---|

### 执行阶段

| 阶段 | 状态 | 尝试数 | 阶段模型计数 | 调查轮数 |
|---|---|---:|---:|---:|

原始证据：attempts.jsonl（未生成）、events.jsonl（未生成）、[diagnostics.json](/Users/zhuhengtan/projects/Pulse/.pulse-dev/long-task-eval-round3-20261015/LT03/diagnostics.json)。

## LT04 调研当前 DeepSeek 长任务适配缺口 (high)

- 开始：尚未开始；结束：运行中或未开始。
- 实际请求预留0/64；已记录HTTP响应0；状态未知。
- Runtime：运行中/未知；Pulse业务自评：未知。
- 工具操作0；完全相同工具/参数/语义结果再次出现0次。这是诊断计数，不自动等同于无效循环。

### 请求时间线

| 请求 | UTC开始时间 | HTTP | 完成原因 | ms | input/output/reasoning |
|---:|---|---:|---|---:|---|

### 执行阶段

| 阶段 | 状态 | 尝试数 | 阶段模型计数 | 调查轮数 |
|---|---|---:|---:|---:|

原始证据：attempts.jsonl（未生成）、events.jsonl（未生成）、[diagnostics.json](/Users/zhuhengtan/projects/Pulse/.pulse-dev/long-task-eval-round3-20261015/LT04/diagnostics.json)。

## LT05 同步过时的执行控制与中英配置文档 (low)

- 开始：尚未开始；结束：运行中或未开始。
- 实际请求预留0/64；已记录HTTP响应0；状态未知。
- Runtime：运行中/未知；Pulse业务自评：未知。
- 工具操作0；完全相同工具/参数/语义结果再次出现0次。这是诊断计数，不自动等同于无效循环。

### 请求时间线

| 请求 | UTC开始时间 | HTTP | 完成原因 | ms | input/output/reasoning |
|---:|---|---:|---|---:|---|

### 执行阶段

| 阶段 | 状态 | 尝试数 | 阶段模型计数 | 调查轮数 |
|---|---|---:|---:|---:|

原始证据：attempts.jsonl（未生成）、events.jsonl（未生成）、[diagnostics.json](/Users/zhuhengtan/projects/Pulse/.pulse-dev/long-task-eval-round3-20261015/LT05/diagnostics.json)。

## LT06 访谈并形成真实长任务评估计划后暂停 (high)

- 开始：尚未开始；结束：运行中或未开始。
- 实际请求预留0/64；已记录HTTP响应0；状态未知。
- Runtime：运行中/未知；Pulse业务自评：未知。
- 工具操作0；完全相同工具/参数/语义结果再次出现0次。这是诊断计数，不自动等同于无效循环。

### 请求时间线

| 请求 | UTC开始时间 | HTTP | 完成原因 | ms | input/output/reasoning |
|---:|---|---:|---|---:|---|

### 执行阶段

| 阶段 | 状态 | 尝试数 | 阶段模型计数 | 调查轮数 |
|---|---|---:|---:|---:|

原始证据：attempts.jsonl（未生成）、events.jsonl（未生成）、[diagnostics.json](/Users/zhuhengtan/projects/Pulse/.pulse-dev/long-task-eval-round3-20261015/LT06/diagnostics.json)。

## 第三轮时间与保护核对

以下UTC时间对应北京时间+8小时。

- 02:10:44：GET模型列表认证预检HTTP200，deepseek-flash存在，生成请求0。
- 02:12:01：LT01首个生成请求发出，low。
- 02:15:01：180秒后TimeoutError；usage.durationMs=180008，modelCalls=1，tokens/cost未知。工具操作0、任务文件变化0。
- 02:15:01：监督器写blocked.json并正常退出码1，未启动LT02–06。没有手动杀进程或重启无关服务。
- 02:16：核对250个编译驱动、源码与监督器哈希，差异0；前两轮93次和2次原始记录保留。
- 测后：清理监督器finished标记和传输日志分类；只做18项离线校准，没有新的真实调用。第三轮原始日志中旧finished=true保留为证据，不能当作业务完成。
