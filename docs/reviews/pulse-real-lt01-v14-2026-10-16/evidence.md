# 证据索引

隔离目录：`/Users/zhuhengtan/projects/Pulse/.pulse-dev/long-task-eval-round8-20261016`。保留旧轮次和原始评分，本轮只 dispatch 一次。

- `frozen.json`：同题校验、原始缺陷种子哈希、驱动哈希、授权与预算。
- `preflight.json`：模型可用，HTTP200，生成调用0。
- `LT01/attempts.jsonl`：25次HTTP请求/响应、可见输出、用量与延迟，不写认证或推理正文。
- `LT01/session.json`、`data/…/runtime.json` 及外置 runtime-results：原始运行现场。不要把原始模型续接/推理内容直接展示或复制进报告。
- `LT01/result.json`：Runtime succeeded、Host accepted、25次账本与候选改动。
- `LT01/diagnostics-current.json`：外置ResultRef解析后的脱敏控制器/工具/模型结构输出，移除providerContinuation及reasoning字段。
- `LT01/grade.json`：冻结独立评分器原8/14；`runner-probe-*`保留实际入口正反向日志及候选报告。
- `LT01/offline-audit.json`：六字段对账、六项直接接口检查、三个正向入口语义验收、候选写入哈希。
- `LT01/execution-audit.json`：逐请求作用/输入大小/历史块长度/ownerLane、阶段及candidateRef、清单大小。
- `preservation.json`：报告写入前1,059文件不变、281驱动不变、Git状态一致，候选四文件与result.changed一致。

## 离线复核

在 `/Users/zhuhengtan/projects/Pulse` 执行，不调用模型：

```sh
python3 .pulse-dev/long-task-eval-round8-20261016/inspect.py
node .pulse-dev/long-task-eval-round8-20261016/audit.mjs
```

`final-audit.mjs`记录的是报告写入前基线；新增本报告后重跑其严格产品不变断言会因报告新增而失败。原记录应保留。独立grade已执行，再执行会新增probe目录，通常直接读取原结果即可。

本次没有修改产品代码、候选代码或评分器。上次本地150文件1228测试通过是lane修复的本地证据，本轮仅重新编译，不把该历史测试冒充本轮新测试。没有交互CLI键盘、打包、跨平台或费用真实性验收。
