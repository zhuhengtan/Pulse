# 验收矩阵

## 冻结九项独立恢复验收

| 检查 | 结果 |
|---|---|
| helper-order-and-dedup | 通过 |
| all-six-terminal-statuses | 通过 |
| running-and-pending-retained | 通过 |
| actual-runner-failure-resume-no-replay | 通过 |
| duplicate-terminal-history-summary | **失败**：ERR_ASSERTION Expected values to be strictly equal:  3 !== 2  |
| corrupt-jsonl-fails-before-cli-and-preserves-bytes | 通过 |
| actual-interruption-retains-terminal-and-user-artifact | 通过 |
| resumed-token-cap-not-reset | 通过 |
| resumed-unknown-cost-cap-not-reset | **失败**：ERR_ASSERTION Expected values to be strictly equal:  2 !== 1  |

## 产品机制与验证边界

| 项目 | 本轮证据 |
|---|---|
| 历史压缩正常响应 | 第28次纯文本3345字符，无工具提议；通过 |
| 压缩异常工具响应拒收 | 本轮未出现异常响应，只有上一轮本地回归证据 |
| 拒绝后冻结只读验收与确定性收尾 | 实际执行；零追加模型请求；通过 |
| 失败结果展示 | 已展示两个失败；但重复及标准归因仍有缺陷 |
| lane 连续性、阶段候选隔离 | 六阶段 lane-1，候选各不相同，重规划0 |
| 混合未读分页＋搜索 | 本轮无 fs.search 混合批次，未覆盖 |
| 完成阶段复用 | 五阶段均1次，没有重新打开 |
| 预算耗尽/256次边界 | 只使用30次，未触及；额外预算不适用 |
| 冷恢复 | 本轮主引擎未重启；候选runner有独立恢复/中断探针 |
| 候选自有测试 | 真实过程模块8/8；停止后新离线副本合计13/13 |
| 原夹具同名编辑保留 | 补充离线诊断失败，未加入冻结评分 |
| CLI键盘、安装包、跨平台 | 未验证 |
