# 证据索引与复核

隔离输出：`/Users/zhuhengtan/projects/Pulse/.pulse-dev/long-task-eval-round7-20261016`。原始结果保留，不覆盖历史轮次。

- `frozen.json`：原题、种子、模型、驱动哈希与授权范围；LT01 与上一轮同题；任务额外预算均 null，产品上限 256。
- `preflight.json`：预检 HTTP 200、模型可用，generationCalls=0。
- `LT01/attempts.jsonl`：38 次请求、响应、可见输出、用量与耗时；不保存认证信息或推理正文。
- `LT01/result.json`：Runtime 结束、业务 incomplete、完整用量与预算账本。
- `LT01/diagnostics-current.json`：解析外置 ResultRef 后的控制器、工具结果和模型结构输出；移除 providerContinuation/reasoningContent/reasoning_content。
- `LT01/grade.json`、`independent-grade.log`：冻结评分器原结果 5/14。
- `LT01/runner-probe-*/`：离线实际入口日志、候选报告和真实 compiled artifact grader 结果；假 CLI 不验证真实模型执行上限。
- `LT01/offline-audit.json`、`offline-audit.log`：三个正向入口语义补充验收、直接接口检查、逐字段用量对账、重复身份、候选写入哈希。
- `preservation.json`：产品变化 0、279 驱动哈希一致、候选仅 3 个文件且与 result.changed 一致；在本报告写入前核对。

## 复核命令

在 `/Users/zhuhengtan/projects/Pulse` 执行以下离线命令；不启动模型：

```sh
python3 .pulse-dev/long-task-eval-round7-20261016/inspect.py
node .pulse-dev/long-task-eval-round7-20261016/audit.mjs
```

独立评分已经运行一次；再次运行会新增离线 probe 目录，因此通常直接读取原始 grade 即可。

本轮不是 CLI 方向键验收，不是安装包验收，也没有再次运行完整产品本地套件。上一轮本地回归通过不能替代本次真实任务结果。
