# 第三轮前的修复与本地验证

2026-10-15，用户确认上轮DeepSeek官方网络故障，并要求先修复已知问题再重测。由Codex直接开发；不使用Pulse CLI修改源码。

## 已处理的明确问题

| 问题 | 当前修复与证据 |
|---|---|
| 预算不感知、阶段过细 | Host持久账本逐请求提供limit/used/remaining；controller11按预算合并DAG，保留全部criteria/checks/依赖。5阶段16次预算回归保留完整要求并压至2阶段 |
| 失败阶段计0/证据丢失 | 可信Runtime结算保留直接同agent子阶段已完成工具receipt和providerAttempts；预算拒绝计0；失败/取消/正常blocked均有回归 |
| 耗尽后反复重新规划 | 保存证据后直接失败，不再触发goal recovery或另开run |
| 跨阶段重复读取 | 提供path/hash/窗口/ref索引及实际内容；变更文件、缺失内容和下一页允许再读 |
| 残缺草稿提交 | .mjs/.cjs staged commit使用node --check解析、不执行，失败保留草稿与revision，目标不落盘 |
| 小文件绕过语法保护 | 本轮补修：直接fs.write复用同一解析保护；无效源文件不存在，有效但含throw的文件可保存，证明没有执行代码 |
| 访谈误选/评分假通过 | 准确匹配v2路径/value和逐例报告布局；未知选项等待需求方。新增/修改才算产物；负向检查先跑合法输入，再核查冲突原因与无副作用 |
| 网络失败仍派发后续样本 | 网络/认证/429/5xx或usage缺失停止整批；重新启动也不能跳过阻塞。假503端到端确认只发1次请求 |
| 网络错误原因缺失 | TimeoutError/AbortError和白名单网络原因码脱敏保留，敏感message/URL不记录 |
| 失败耗时为0 | 本轮补修：已入场请求失败也保留实测latency，不伪造tokens/cost；预算入场拒绝不计provider耗时。Host回归验证durationMs>0且消耗仍未知 |
| 诊断报告仍写16次 | 本轮补修：报告和阶段诊断使用冻结的实际sampleLimit，说明阶段计数与全任务账本的区别 |

## 本地验证

- `.pulse-dev/round3-typecheck.log`：类型构建通过。
- `.pulse-dev/round3-targeted.log`：34项定向回归通过。
- `.pulse-dev/round3-full.log`：140文件、1111项完整本地测试通过。
- `.pulse-dev/round3-offline.log`：17项离线校准/本机HTTP/评分器/监督器检查通过。

## 真实复测边界

第三轮新目录`.pulse-dev/long-task-eval-round3-20261015`。deepseek/deepseek-flash，low/high各3例；每例64次实际请求、总384。API预检HTTP200、生成调用0。使用原历史维护场景源码，fixture仅批准的预算文字不同；250个Host/Runtime/adapter编译文件与源码哈希冻结。

前两轮93次与2次请求分别保留，不将网络阻塞样本计为业务能力失败。不提交、推送、发布或重启常驻服务。运行中的结果会另行记录，不能凭本地测试提前宣称真模通过。

## 仍需如实限定

语法保护覆盖.mjs/.cjs完整新文件，不证明语义正确，也不能替代其他语言、已有文件的实际检查。RunUsage.durationMs累加可用请求latency，不等于整个run的墙钟时间。跨平台和几十小时执行不在本轮六例验收范围。

## 实际复测结果

首个生成请求仍超时；只发1次请求后自动停批，后五例未运行。真实耗时修复得到错误路径验证（180008毫秒），不证明业务任务完成。测后补充评估器finished/传输日志清理，18项离线校准通过，没有追加付费请求。完整数据与限制见[总报告](README.md)。
