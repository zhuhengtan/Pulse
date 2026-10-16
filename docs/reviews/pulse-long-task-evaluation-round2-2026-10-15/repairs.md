# 第二轮前的修复与验证

日期：2026-10-15。用户要求“先修复已知问题后再重跑”。由 Codex 直接修改，保留原有未提交工作与第一轮 93 次真实请求记录。本轮尚未出结果时，不宣称真实长任务已经完成。

## 修复

| 已知问题 | 根因与修改 | 离线证据 |
|---|---|---|
| 规划不考虑实际消耗 | Host 每次请求附加持久账本 limit/used/remaining，含审批、重试和压缩；controller11合并过细DAG，保留每项检查、criteria和外部依赖，不截断约束 | 5阶段/16次计划压至2阶段；预算提示、原projection不变、拒绝入场计0 |
| 异常worker计0、写入证据丢失 | Runtime在父子join暴露同agent直接子阶段的工具receipt，Step读取可信结算；adapter记录实际providerAttempts，内部重试也计数 | 失败/取消/正常blocked均保留已结算调用；异常预算耗尽仍保留写入证据与1次实际请求 |
| 耗尽后又重新规划 | 异常预算失败原先只标blocked，随后goal recovery重开规划 | 保存阶段证据后直接failed，不再调用规划或另开run |
| 跨阶段重复读 | 只有摘要/引用不足以知道哪一页已读 | 传入path/hash/offset/nextOffset/ref索引和实际内容；依赖worker测试确认获得两者。变化文件/后续页仍可读取 |
| begin-inspect-commit落盘残缺JS | 草稿字节/版本正确不等于完整代码 | `.mjs/.cjs`提交前用node --check解析，失败保留草稿与revision，目标不存在；append补齐后可提交。解析不执行代码 |
| 访谈误选 | 模糊“新文件”匹配选到subdir/other，basis却声称v2 | 先匹配准确v2路径/value；明确逐例报告+汇总选项；未知选项写pending-question并等待需求方，无默认取消/猜测 |
| 评分误通过 | 原文件存在即算产物；任意exit1即算冲突保护 | 产物须新增/修改；负向探针先跑合法输入，再核查冲突原因和无summary副作用；语法错误不算保护成功 |

## 验证

- 类型构建：`.pulse-dev/repair2-typecheck-final.log`，通过。
- 定向回归：`.pulse-dev/repair2-targeted-final.log`，77项通过。
- Host审批/预算：`.pulse-dev/repair2-host-escalated.log`，12项通过。
- 完整本地回归：`.pulse-dev/repair2-full-final.log`，140文件、1107项通过。
- 编译产物校准及fake HTTP：`.pulse-dev/repair2-offline-final.log`，14项通过，实际16次本机HTTP后停止，未调用外部模型。
- 评分器负向回归：`.pulse-dev/repair2-grader.log`，1项通过。

首次全量高并发运行出现检查超时；按项目既有两进程执行方式复测全部通过。受限环境的语法检查子进程缺结果，在允许本地子进程环境复核通过。过程中新增提示过长与fake模型识别前缀问题均在离线发现并修正，未拿真实调用排查。

## 第二轮边界

- `.pulse-dev/long-task-eval-round2-20261015`，新数据/会话/输出，不重写第一轮。
- 每例64次实际请求，六例总上限384，审批/重试/压缩/冷恢复计入。
- 使用原历史维护场景源码；fixture比较仅`fixtures/evaluation-request.md`的预算数字变化。
- 250个Host/Runtime/adapter编译产物及源码哈希记录于driver-provenance.json。
- 同时修复驱动并增大预算，不构成单变量A/B，不用于推断low/high优劣。
- 不提交、推送或发布，不重启常驻服务。任意node -e未加入免审名单。

## 剩余边界

语法保护仅覆盖`.mjs/.cjs`的staged写入，不证明语义正确；其他语言和已有文件仍需相应检查。预算适配是调度估算，不能保证有限调用内完成所有需求。已读窗口复用有回归证据，真实模型是否减少重读由本轮轨迹判断。未知价格保持未知，不估算费用。几十小时、跨平台及外部服务故障恢复未验收。

## 真实复测阻塞与补充修复

第二轮发出2次请求：LT01于180秒后PROVIDER_NETWORK_ERROR，LT02被评估器提前派发后由Codex停止。tokens与费用未知；LT03–06未派发，本轮无真实业务完成样本。详见[过程记录](process.md)与[逐例结果](README.md)。

已另外修复监督器：网络错误/429/5xx/认证错误或usage缺失即停止整批，重新启动也不能跳过该失败；本地假503端到端确认仅1次请求，第二例没有started.json。DOM TimeoutError/AbortError安全名称保留，敏感message仍不输出。这两项补充修复仅离线验证，未追加付费请求。

最终网络诊断修复后的完整回归：140文件/1108项通过（`.pulse-dev/repair2-full-after-network-fix.log`）；另17项评估器/模拟检查通过。真实请求仍为2/384，未追加。
